const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { callAgent } = require('./agentCall');
const { uploadBufferToS3 } = require('./s3Uploader');
const { buildSingleTilePrompt, buildDirectTilePrompt } = require('./singleTileEnvelope');
const { plannerInstruction, validateTilePlan } = require('./plannerContract');
const inputs = require('./ecommInputs');

// ─── core/ecommRunner.js ─────────────────────────────────────────── Phase 3 ──
//
// ── v7 (Sep 25, 2026): NO PLAYBOOKS ──────────────────────────────────────────
// The master prompt lives on the TEMPLATE (template.masterPrompt), not on an
// EcommPlaybooks row. The template also carries its own customer inputs
// (template.inputSchema): either one fixed field list (e.g. food & beverage) or
// one field list per subcategory (e.g. beauty → skincare / haircare / makeup).
//
// The author writes {{tokens}} into the master prompt. Before every call the
// engine turns it into ONE plain string (ecommInputs.resolveTokens):
//   {{userInputs.SkinConcern}}  → "Acne"
//   {{textureImage}}            → "Image 2 (TEXTURE IMAGE)" — or nothing, when
//                                 that image is not attached to this call
//   {{subcategory}}             → "Skincare"
// A line whose tokens all came out empty is removed.
//
// Images are resolved per call, because different calls see different images:
//   analyser + role picker   ALL uploaded images
//   tile calls               only images with toTiles (front of pack always;
//                            back of pack off by default; texture / shade on)
// Every call that carries images opens with an ATTACHED IMAGES list written
// here, so the image adapter's own manifest is switched off (suppressManifest).
//
// ── The pipeline (unchanged from v6) ─────────────────────────────────────────
//   direct   inputs → analyser (optional) → role picker (or fixed tile roles)
//            → N tiles in parallel, each: master prompt + its role (+ analysis)
//   planner  (v5) inputs → analyser → planner briefs → N tiles from the briefs
//
// ── WHY THE ROLE PICKER / PLANNER EXISTS (§A2 — read before removing it) ──────
// Eight independent image calls share no memory. Give all 8 the same prompt and
// each picks *the strongest* story — eight hero shots, not a campaign. One text
// call decides the N different stories first; each tile then gets its own.
//
// ── WHY THE ENVELOPE EXISTS (§A3) ─────────────────────────────────────────────
// The master prompt ends with "Generate EXACTLY 8 images". Correct for the role
// picker, WRONG for a per-tile call. singleTileEnvelope.js cuts that block at
// the OUTPUT heading and puts a single-tile block in its place.
//
// ── THREE JOB KINDS ──────────────────────────────────────────────────────────
//   full       first run. Analyser → roles/planner → all N tiles.
//   regen_all  the whole thing again from the top; outputs merge into the set.
//   regen_one  ONE tile again, FROM ITS STORED ROLE/BRIEF — no analyser, no
//              role picker.
//
// ── THE SNAPSHOT INVARIANT (same as toolsRunner — do not break it) ────────────
// Every job writes a complete picture of the set as it stands afterwards: the
// full tilePlan, the effective analysis, and finalOutputs merged over the
// source's. "What does this set look like now" is ONE row lookup, not a replay.
// ──────────────────────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const DEFAULT_TILE_COUNT = 8;
const MIN_TILE_COUNT = 4;
const MAX_TILE_COUNT = 10;

// §A7-3: eight simultaneous image calls WILL hit provider rate limits.
const TILE_STAGGER_MS = parseInt(process.env.ECOMM_TILE_STAGGER_MS || '3000', 10);
const TILE_RETRY_ATTEMPTS = parseInt(process.env.ECOMM_TILE_RETRY_ATTEMPTS || '3', 10);

// The image API takes one text field of at most 32,000 characters. A tile over
// that fails at the provider; failing here says why, before any image spend.
const TILE_PROMPT_MAX = parseInt(process.env.ECOMM_TILE_PROMPT_MAX || '32000', 10);

// §A7-6: analysis + N briefs + outputs on one AIJobs row approaches the 400KB
// item cap. Offload above this, exactly like SKU_ANALYSIS_INLINE_MAX.
const INLINE_MAX = parseInt(process.env.ECOMM_INLINE_MAX || '120000', 10);

// §A7-4: if the analyser and the SKU card ever produce different shapes, the
// skip silently feeds the planner a half-empty analysis. One schema, asserted.
const MIN_ANALYSIS_CHARS = 200;

const INHERITING_KINDS = new Set(['regen_all', 'regen_one']);

/* ── DynamoDB plumbing (mirrors toolsRunner) ──────────────────────────────── */

async function updateJobStatus(jobId, updates) {
  const expressions = [], names = {}, values = {};
  for (const [key, val] of Object.entries(updates)) {
    expressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = val;
  }
  await dynamo.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function loadJob(jobId) {
  const r = await dynamo.send(new GetCommand({ TableName: process.env.AI_JOBS_TABLE, Key: { jobId } }));
  if (!r.Item) throw new Error(`Job not found: ${jobId}`);
  return r.Item;
}

async function loadTemplate(templateId) {
  const r = await dynamo.send(new GetCommand({ TableName: process.env.PHASE2_AI_TEMPLATES_TABLE, Key: { templateId } }));
  if (!r.Item) throw new Error(`Template not found: ${templateId}`);
  return r.Item;
}

// v7: the master prompt is a field on the template. No playbook, no fallback —
// a template with no prompt is a template the workbook should never have saved.
function masterPromptOf(template) {
  const mp = String((template && template.masterPrompt) || '');
  if (!mp.trim()) {
    throw new Error(`template "${template && template.templateId}" has no masterPrompt — paste it into the Master prompt field in the workbook and save`);
  }
  return mp;
}

// v7: optional fixed tile roles, one string per tile (was the playbook's tileTaxonomy).
function tileRolesOf(template) {
  const r = template && (template.tileRoles || template.tileTaxonomy);
  return Array.isArray(r) ? r : [];
}

/* ── S3 offload (§A7-6) ───────────────────────────────────────────────────── */

async function persistLarge(jobId, name, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= INLINE_MAX) return { inline: value, key: null };

  const key = `ai-layer-outputs/${jobId}/${name}.json`;
  await uploadBufferToS3(Buffer.from(text, 'utf8'), key, 'application/json');
  console.log(`[ecommRunner] ${name} offloaded to S3 (${text.length} chars > ${INLINE_MAX}) — ${key}`);
  return { inline: null, key };
}

async function rehydrate(inline, s3Key) {
  if (inline != null) return inline;
  if (!s3Key) return null;
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: process.env.AI_OUTPUTS_BUCKET, Key: s3Key }));
  const body = await resp.Body.transformToString();
  try { return JSON.parse(body); } catch (_) { return body; }
}

/* ── small helpers ────────────────────────────────────────────────────────── */

function clampTileCount(n) {
  let v = parseInt(n, 10);
  if (isNaN(v)) v = DEFAULT_TILE_COUNT;
  return Math.max(MIN_TILE_COUNT, Math.min(MAX_TILE_COUNT, v));
}

// Kept for anything that still imports it: the job's image URLs, main photo first.
function resolveUploads(inputFiles) {
  const f = inputs.normaliseInputFiles(inputFiles);
  const main = f[inputs.MAIN_IMAGE_KEY];
  return [main, ...Object.entries(f).filter(([k]) => k !== inputs.MAIN_IMAGE_KEY).map(([, v]) => v)].filter(Boolean);
}

// "Tile 3" → slot 2.
function slotOfLabel(out, fallback) {
  const m = /(\d+)\s*$/.exec(String((out && out.label) || ''));
  return m ? parseInt(m[1], 10) - 1 : fallback;
}

function mergeOutputs(baseOutputs, produced) {
  const bySlot = new Map();
  (baseOutputs || []).forEach((o, i) => bySlot.set(slotOfLabel(o, i) + 1, { ...o }));
  (produced || []).forEach(({ i, url }) => bySlot.set(i + 1, { label: `Tile ${i + 1}`, type: 'image', url }));
  return [...bySlot.keys()].sort((a, b) => a - b).map(k => bySlot.get(k));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function statusFromError(err) {
  const m = /\b(429|500|502|503|504)\b/.exec(String(err && err.message) || '');
  return m ? parseInt(m[1], 10) : null;
}

async function withBackoff(label, fn, attempts = TILE_RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = statusFromError(err);
      if (!status || i === attempts) break;
      const wait = Math.round(2000 * Math.pow(2, i - 1) + Math.random() * 1000);
      console.warn(`[ecommRunner] ${label}: ${status} — retry ${i}/${attempts - 1} in ${wait}ms (shared quota; not your code)`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ── the run's inputs, resolved once per image set ─────────────────────────── */

/**
 * Everything a run needs to know about its inputs:
 *   fields        the fields for this run (the subcategory's, or the fixed list)
 *   allImages     every uploaded image, in attach order (analyser, role picker)
 *   tileImages    the ones sent to tile calls (toTiles)
 *   promptAll     master prompt resolved for a call that sees allImages
 *   promptTiles   master prompt resolved for a tile call
 */
function prepareRunInputs({ template, job }) {
  const { fields, subcategory, error } = inputs.fieldsFor(template, job.subcategory);
  if (error) throw new Error(`inputs: ${error}`);

  const { images: allImages, ignored } = inputs.imagePlan(fields, job.inputFiles);
  const tileImages = allImages.filter((im) => im.toTiles);
  const userInputs = job.userInputs && typeof job.userInputs === 'object' ? job.userInputs : {};

  const check = inputs.checkInputs(fields, job.inputFiles, userInputs);
  check.warnings.forEach((w) => console.warn(`[ecommRunner] inputs: ${w}`));
  ignored.forEach((k) => console.warn(`[ecommRunner] inputs: uploaded file "${k}" has no field on this template — not used`));
  if (check.errors.length && !String(job.skuAnalysis || '').trim()) {
    throw new Error(`inputs: ${check.errors.join('; ')}`);
  }

  const master = masterPromptOf(template);
  const allKeys = inputs.allFieldKeys(template);
  const ctx = { fields, userInputs, subcategory, allKeys };

  const all = inputs.resolveTokens(master, { ...ctx, images: allImages });
  const tiles = inputs.resolveTokens(master, { ...ctx, images: tileImages });
  [...new Set([...all.warnings, ...tiles.warnings])].forEach((w) => console.warn(`[ecommRunner] master prompt: ${w}`));

  const leftover = /\{\{[^}]*\}\}/.exec(tiles.text);
  if (leftover) console.warn(`[ecommRunner] master prompt still contains "${leftover[0]}" after resolving — it is not a valid token`);

  console.log(
    `[ecommRunner] inputs: ${subcategory ? `subcategory "${subcategory.label}"` : 'fixed fields'} · ` +
    `${allImages.length} image(s) [${allImages.map((im) => im.key).join(', ')}] · ` +
    `${tileImages.length} to tiles [${tileImages.map((im) => im.key).join(', ')}] · ` +
    `${Object.keys(userInputs).filter((k) => String(userInputs[k] || '').trim()).length} filled input(s) · ` +
    `master prompt ${master.length} → ${tiles.text.length} chars resolved`
  );

  return {
    fields, subcategory, userInputs, allImages, tileImages,
    promptAll: all.text,
    promptTiles: tiles.text,
    sellerInputs: inputs.sellerInputsBlock(fields, userInputs),
  };
}

const urlsOf = (images) => (images || []).map((im) => im.url);

// A prompt that carries images starts with the image list.
function withImageList(images, text) {
  const list = inputs.imageListBlock(images);
  return list ? `${list}${text}` : text;
}

/* ── the analysis contract (§A7-4) ────────────────────────────────────────── */

function assertAnalysis(value, source) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.trim().length < MIN_ANALYSIS_CHARS) {
    throw new Error(
      `analysis from ${source} is ${text ? text.trim().length : 0} chars — below the ${MIN_ANALYSIS_CHARS} floor. ` +
      `The planner would write 8 briefs about nothing.`
    );
  }

  let obj = null;
  try { obj = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { /* not JSON */ }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      `analysis from ${source} is not a JSON object. Both producers must emit one shape — ` +
      `see §A7-4. Got: ${text.slice(0, 120)}…`
    );
  }

  const identifying = ['productName', 'brand', 'category', 'name', 'title', 'product'];
  if (!identifying.some(k => obj[k])) {
    console.warn(`[ecommRunner] analysis from ${source} names no product — keys: ${Object.keys(obj).slice(0, 12).join(', ')}`);
  }

  console.log(`[ecommRunner] analysis OK — ${source}, ${text.length} chars, ${Object.keys(obj).length} fields`);
  return { text, obj };
}

/* ── source state (regen_one / regen_all) ─────────────────────────────────── */

async function loadSourceState(job) {
  const id = job.sourceJobId || job.parentJobId;
  if (!id) return null;
  let src;
  try {
    src = await loadJob(id);
  } catch (e) {
    throw new Error(`could not load source run ${id}: ${e.message}`);
  }
  return {
    jobId: id,
    analysis: await rehydrate(src.analysisOutput ?? src.skuAnalysis ?? null, src.analysisS3Key),
    tilePlan: await rehydrate(Array.isArray(src.tilePlan) ? src.tilePlan : null, src.tilePlanS3Key) || [],
    finalOutputs: Array.isArray(src.finalOutputs) ? src.finalOutputs : [],
  };
}

/* ── Exported stage functions ─────────────────────────────────────────────── */

const DEFAULT_ANALYSER_PROMPT = `You are a product analyst for an e-commerce creative pipeline.

Study the attached product images. The ATTACHED IMAGES list above says what each one is.

Return ONE JSON object describing the product: its category, subcategory, brand and product name exactly as printed, format, packaging architecture and closure, materials and finish, pack colours, every legible line of label text verbatim, any claims or ingredients actually printed, market positioning, target consumer, the consumer problem it solves, the desired outcome, the usage ritual, its sensory personality, purchase triggers and differentiators.

Report ONLY what you can see, plus what the seller states under SELLER'S INPUTS (if present). Never invent brand names, ingredients, statistics, certifications or claims. Where a field is unknowable, say so rather than guessing.`;

/**
 * STAGE 1 — reads the product; never selects anything.
 * The analyser prompt may use {{tokens}} too. The seller's filled inputs are
 * always attached as SELLER'S INPUTS, so the default prompt sees them.
 */
async function runAnalyser({ template, run }) {
  const a = (template.analyser || (template.agents && template.agents.analyser) || {});
  const { text: prompt } = inputs.resolveTokens(a.prompt || DEFAULT_ANALYSER_PROMPT, {
    fields: run.fields, userInputs: run.userInputs, images: run.allImages, subcategory: run.subcategory,
  });
  return callAgent({
    label: 'analyser',
    prompt: withImageList(run.allImages, prompt),
    model: a.model,
    images: urlsOf(run.allImages),
    attachments: run.sellerInputs ? [{ title: "SELLER'S INPUTS", content: run.sellerInputs }] : [],
    expectJson: true,
    maxOutputTokens: 16384,
  });
}

/**
 * STAGE 2 (planner mode) — the planner sees the master prompt WHOLE, including
 * its 8-image output block: that block is correct here.
 */
async function runPlanner({ template, run, analysisText, tileCount }) {
  const p = template.planner || {};
  const instruction = p.instruction || plannerInstruction(tileCount);

  const call = (correction) => callAgent({
    label: correction ? 'planner-retry' : 'planner',
    prompt: withImageList(run.allImages, run.promptAll),
    model: p.model,
    images: urlsOf(run.allImages),
    attachments: [
      { title: 'PRODUCT ANALYSIS', content: analysisText },
      { title: 'YOUR TASK ON THIS CALL', content: correction ? `${instruction}\n\n### RETRY\n\nYour previous response was rejected: ${correction}\n\nReturn corrected JSON only.` : instruction },
    ],
    expectJson: true,
    maxOutputTokens: 32000,
  });

  let parsed = await call(null);
  let { tiles, errors, warnings } = validateTilePlan(parsed, tileCount);

  if (errors.length) {
    console.warn(`[ecommRunner] planner validation failed:\n  - ${errors.join('\n  - ')}`);
    parsed = await call(errors.join('; '));
    ({ tiles, errors, warnings } = validateTilePlan(parsed, tileCount));
    if (errors.length) {
      throw new Error(`planner failed validation twice:\n  - ${errors.join('\n  - ')}`);
    }
  }

  warnings.forEach(w => console.warn(`[ecommRunner] planner: ${w}`));
  tiles.forEach(t => console.log(`[ecommRunner]   tile ${t.index}. ${t.title} — ${String(t.camera || '').slice(0, 60)}`));
  return tiles;
}

const PROVIDER_FILES = {
  openai: 'openai_image',
  'gpt-image': 'openai_image',
  nanobanana: 'nanabanana',      // note the spelling — it is wrong on disk, deliberately matched
  seedream: 'seedream',
};

function resolveProvider(name) {
  const file = PROVIDER_FILES[String(name || 'openai').toLowerCase()];
  if (!file) throw new Error(`unknown generator provider "${name}" (known: ${Object.keys(PROVIDER_FILES).join(', ')})`);
  let adapter;
  try {
    adapter = require(`../providers/${file}`);
  } catch (e) {
    throw new Error(`generator provider "${name}" → providers/${file}.js could not be loaded: ${e.message}`);
  }
  if (typeof adapter.execute !== 'function') {
    throw new Error(`providers/${file}.js does not export execute() — adapter contract broken`);
  }
  return adapter;
}

/**
 * One image call. The engine writes the image list itself (it knows what each
 * image IS — texture, shade card, …), so the adapter's manifest is switched off.
 */
async function renderTile({ template, jobId, run, prompt, human }) {
  const g = template.generator || {};
  const full = withImageList(run.tileImages, prompt);
  if (full.length > TILE_PROMPT_MAX) {
    throw new Error(
      `tile ${human}: prompt is ${full.length.toLocaleString()} chars — over the ${TILE_PROMPT_MAX.toLocaleString()} limit of the image API. ` +
      `Shorten the master prompt or the analyser output.`
    );
  }
  console.log(`[ecommRunner] tile ${human}: prompt ${full.length} chars, ${run.tileImages.length} image(s)`);

  const adapter = resolveProvider(g.provider);
  const result = await adapter.execute({
    prompt: full,
    imageUrls: urlsOf(run.tileImages),
    model: g.model || 'gpt-image-2',
    quality: g.quality || 'high',
    resolution: g.resolution || '2k',
    inputs: {
      aspectRatio: g.aspectRatio || '1:1',
      imageLabels: run.tileImages.map((im) => im.name),
      suppressManifest: true,
    },
    // ai-outputs/ecomm_<jobId>_t<n>_0_<ts>.<ext>
    stepId: `ecomm_${jobId}`,
    tileIndex: human,
  });

  const url = result && result.outputs && result.outputs[0] && result.outputs[0].url;
  if (!url) throw new Error(`tile ${human}: generator returned no image url`);
  return url;
}

/** STAGE 3 (planner mode) — one tile from its brief. */
async function runGenerator({ template, jobId, run, analysis, brief, index, tileCount }) {
  const human = index + 1;
  const { prompt, warnings } = buildSingleTilePrompt({
    masterPrompt: run.promptTiles, analysis, brief, index: human, tileCount,
  });
  warnings.forEach(w => console.warn(`[ecommRunner] tile ${human}: ${w}`));
  return renderTile({ template, jobId, run, prompt, human });
}

/* ── DIRECT MODE ──────────────────────────────────────────────────────────── */

function pipelineModeOf(template) {
  return String((template && template.pipelineMode) || 'planner').toLowerCase() === 'direct' ? 'direct' : 'planner';
}

function analyserEnabled(template) {
  const a = (template && (template.analyser || (template.agents && template.agents.analyser))) || {};
  return a.enabled !== false;
}

/* ── ROLE PICKER ──────────────────────────────────────────────────────────────
 * One text call reads the master prompt + images (+ analysis) and picks the N
 * best, all-different tile stories for THIS product. Each tile then gets its own.
 * ──────────────────────────────────────────────────────────────────────────── */

function rolePickerInstruction(tileCount, tileImageNames) {
  const names = (tileImageNames || []).length ? tileImageNames.join(', ') : 'FRONT OF PACK';
  return [
    'Do NOT generate any images on this call.',
    '',
    `Your only job right now is to decide the ${tileCount} tiles of this campaign for THIS product — as the creative director described above would. You pick the ${tileCount} most powerful, most different visual stories this specific product needs.`,
    '',
    `Each tile will later be made by a separate image call that sees the full instructions above, some of the images and ONLY its own role. So each role must name one clear story that no other tile tells.`,
    '',
    'RULES',
    `* Exactly ${tileCount} tiles, in the order a shopper should see them.`,
    '* Every tile answers a DIFFERENT shopper question. No two tiles tell the same story, show the same scene, or make the same point.',
    '* If the instructions above fix what a numbered tile must be, keep that tile exactly as stated.',
    '* A role says WHAT the tile shows and WHY (the shopper question it answers). Leave camera, lighting, layout and exact copy to the tile itself.',
    '* Use only facts that are on the pack, in the seller\'s details above, or in the product analysis. Never invent claims.',
    `* The image calls will see ONLY these images: ${names}. Never choose a tile that needs an image they do not get (for example the back of the pack or its printed text).`,
    '* Refer to images by their NAME (e.g. TEXTURE IMAGE), never by number — the numbers differ between calls.',
    '* Each role stands alone. Never write "as above", "same as tile 2", or refer to another tile.',
    '',
    'Return JSON only, nothing before or after it:',
    '{"tiles":[{"index":1,"title":"2–4 word tile name","role":"One or two sentences: what this tile shows and the shopper question it answers."}]}',
  ].join('\n');
}

function validateRoles(parsed, tileCount) {
  const errors = [];
  const tiles = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tiles) ? parsed.tiles : null);
  if (!tiles) return { tiles: null, errors: ['response has no `tiles` array'] };
  if (tiles.length !== tileCount) errors.push(`returned ${tiles.length} tiles, expected exactly ${tileCount}`);
  const seen = new Map();
  tiles.forEach((t, i) => {
    const role = t && typeof t.role === 'string' ? t.role.trim() : '';
    if (!role) { errors.push(`tile ${i + 1}: missing "role"`); return; }
    if (/\b(as above|same as tile|see tile|previous tile|like tile \d)\b/i.test(role)) {
      errors.push(`tile ${i + 1}: refers to another tile — each role must stand alone`);
    }
    const key = role.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) errors.push(`tile ${i + 1} repeats tile ${seen.get(key)}`);
    else seen.set(key, i + 1);
  });
  return { tiles, errors };
}

/** One text call → N different tile roles for this product. One retry, then fail loudly. */
async function runRolePicker({ template, run, analysisText, tileCount }) {
  const p = template.planner || {};
  const instruction = rolePickerInstruction(tileCount, run.tileImages.map((im) => im.name));
  const call = (correction) => callAgent({
    label: correction ? 'role-picker-retry' : 'role-picker',
    prompt: withImageList(run.allImages, run.promptAll),   // WHOLE: it is the brief for choosing
    model: p.model,
    images: urlsOf(run.allImages),
    attachments: [
      ...(analysisText ? [{ title: 'PRODUCT ANALYSIS', content: analysisText }] : []),
      {
        title: 'YOUR TASK ON THIS CALL',
        content: correction
          ? `${instruction}\n\n### RETRY\n\nYour previous answer was rejected: ${correction}\n\nReturn corrected JSON only.`
          : instruction,
      },
    ],
    expectJson: true,
    maxOutputTokens: 16000,
  });

  let { tiles, errors } = validateRoles(await call(null), tileCount);
  if (errors.length) {
    console.warn(`[ecommRunner] role picker rejected:\n  - ${errors.join('\n  - ')}`);
    ({ tiles, errors } = validateRoles(await call(errors.join('; ')), tileCount));
    if (errors.length) throw new Error(`role picker failed twice:\n  - ${errors.join('\n  - ')}`);
  }
  const out = tiles.map((t, i) => ({
    title: (t.title && String(t.title).trim()) || `Tile ${i + 1}`,
    role: String(t.role).trim(),
  }));
  out.forEach((t, i) => console.log(`[ecommRunner]   role ${i + 1}. ${t.title} — ${t.role.slice(0, 90)}`));
  return out;
}

/** DIRECT TILE — master prompt + this tile's role (+ analysis). */
async function runDirectTile({ template, jobId, run, analysis, index, tileCount, slotRole }) {
  const human = index + 1;
  const { prompt, warnings } = buildDirectTilePrompt({ masterPrompt: run.promptTiles, analysis, index: human, tileCount, slotRole });
  warnings.forEach(w => console.warn(`[ecommRunner] tile ${human}: ${w}`));
  return renderTile({ template, jobId, run, prompt, human });
}

function slotRoleOf(slotRoles, slot) {
  const r = Array.isArray(slotRoles) ? slotRoles[slot] : null;
  if (!r) return null;
  if (typeof r === 'string') return r.trim() || null;
  return r.role || r.title || JSON.stringify(r);
}

/**
 * Fan out over the tiles. Staggered, per-tile isolation, partial success still
 * completes the job — one dead tile must never cost the other seven.
 */
async function generateTiles({ template, jobId, run, analysis, tilePlan, targets, tileCount }) {
  console.log(`[ecommRunner] generating ${targets.length} tile(s) in parallel — ${TILE_STAGGER_MS}ms stagger, ${run.tileImages.length} image(s) per tile [${run.tileImages.map((im) => im.name).join(', ')}]`);
  const slotRoles = tileRolesOf(template);

  const settled = await Promise.allSettled(targets.map(async (slot, k) => {
    await sleep(k * TILE_STAGGER_MS);
    const t0 = Date.now();
    const entry = tilePlan[slot];
    const url = await withBackoff(`tile ${slot + 1}`, () => (
      entry && entry.source === 'direct'
        ? runDirectTile({ template, jobId, run, analysis, index: slot, tileCount, slotRole: (entry && entry.role) || slotRoleOf(slotRoles, slot) })
        : runGenerator({ template, jobId, run, analysis, brief: entry, index: slot, tileCount })
    ));
    console.log(`[timing] job=${jobId} tile ${slot + 1} ${Date.now() - t0}ms`);
    return { i: slot, url };
  }));

  return settled.map((r, k) => (
    r.status === 'fulfilled'
      ? { ok: true, ...r.value }
      : { ok: false, i: targets[k], error: r.reason ? r.reason.message : 'unknown error' }
  ));
}

/* ── shared completion ────────────────────────────────────────────────────── */

async function finish({ jobId, startTime, settled, source, targets, verb }) {
  const produced = settled.filter(r => r.ok);
  const tileErrors = {};
  settled.filter(r => !r.ok).forEach(r => {
    tileErrors[String(r.i + 1)] = r.error;
    console.error(`[ecommRunner] tile ${r.i + 1} failed: ${r.error}`);
  });

  const finalOutputs = mergeOutputs(source ? source.finalOutputs : [], produced);
  const jobDurationMs = Date.now() - startTime;

  if (produced.length === 0) {
    await updateJobStatus(jobId, {
      status: 'failed',
      errorMessage: settled[0] && settled[0].error ? `Every tile failed. First error: ${settled[0].error}` : 'Every tile failed to generate',
      tileErrors,
      jobDurationMs,
      completedAt: new Date().toISOString(),
      currentStepLabel: 'Failed',
    });
    console.log(`[ecommRunner] ===== Job ${jobId} ${verb} FAILED (0/${targets.length}) =====\n`);
    return { success: false, jobId, error: 'all tiles failed' };
  }

  await updateJobStatus(jobId, {
    status: 'complete',            // §9: NEVER "completed" — every poller checks for this exact string
    finalOutputs,
    tileErrors,
    jobDurationMs,
    completedAt: new Date().toISOString(),
    currentStepLabel: 'Complete',
  });
  console.log(`[ecommRunner] ===== Job ${jobId} ${verb} COMPLETE — ${produced.length}/${targets.length} in ${jobDurationMs}ms =====\n`);
  return { success: true, jobId, jobDurationMs, tiles: produced.length };
}

/* ── Orchestrator ─────────────────────────────────────────────────────────── */

async function ecommRunner(jobId, messageBody) {
  console.log(`\n[ecommRunner] ===== Starting ecomm job ${jobId} =====`);
  const startTime = Date.now();
  const timings = {};
  const mark = (label, since) => { timings[label] = Date.now() - since; console.log(`[timing] job=${jobId} ${label} ${timings[label]}ms`); };

  try {
    const job = await loadJob(jobId);

    // _testTemplate inline (workbook tests) vs load from DynamoDB (real jobs)
    let template;
    if (messageBody && messageBody._testTemplate) {
      template = messageBody._testTemplate;
      console.log('[ecommRunner] Using test template from SQS message');
    } else {
      template = await loadTemplate(job.templateId);
    }

    if (template.engine && template.engine !== 'ecomm') {
      throw new Error(`engine guard: template.engine="${template.engine}" is not "ecomm"`);
    }

    const kind = job.jobKind || 'full';
    const tileCount = clampTileCount(template.tileCount);
    const scope = (messageBody && messageBody._ecommTestScope) || 'full';   // 'analyser'|'planner'|'tile'|'full'
    const mode = pipelineModeOf(template);
    const useAnalyser = analyserEnabled(template);
    console.log(`[ecommRunner] pipeline mode: ${mode} · analyser ${useAnalyser ? 'ON' : 'OFF'} · ${tileCount} tiles · scope: ${scope}`);

    // v7: master prompt + inputs from the template. Resolved to plain strings here.
    const run = prepareRunInputs({ template, job });

    const fixedRoles = tileRolesOf(template).map((r, i, arr) => slotRoleOf(arr, i)).filter(Boolean);
    if (mode === 'direct') {
      if (fixedRoles.length >= tileCount) console.log(`[ecommRunner] tile roles: ${fixedRoles.length} FIXED on the template`);
      else console.log(`[ecommRunner] tile roles: AUTO — the template has ${fixedRoles.length} fixed role(s), so the role picker will choose ${tileCount}`);
    }
    const source = INHERITING_KINDS.has(kind) ? await loadSourceState(job) : null;

    let analysis, analysisText, tilePlan;

    if (kind === 'regen_one') {
      // Re-render ONE tile from its stored role/brief. No analyser, no role picker.
      if (!source) throw new Error('regen_one job has no sourceJobId or parentJobId');
      if (!source.tilePlan.length) throw new Error(`source run ${source.jobId} has no tilePlan to re-render from`);
      const isDirect = source.tilePlan.every(t => t && t.source === 'direct');
      if (!source.analysis && !isDirect) throw new Error(`source run ${source.jobId} has no analysis to re-render from`);

      if (source.analysis) ({ text: analysisText, obj: analysis } = assertAnalysis(source.analysis, `source run ${source.jobId}`));
      tilePlan = source.tilePlan;

      await updateJobStatus(jobId, {
        status: 'stage_generators',
        currentStepLabel: 'Re-rendering one tile...',
        analysisOutput: source.analysis,
        tilePlan,
      });
      console.log(`[ecommRunner] regen_one — reusing the analysis + role from ${source.jobId}`);

    } else {
      // ── STAGE 1 · analyser, or the SKU-card skip ──────────────────────────
      const card = String(job.skuAnalysis || '').trim();

      if (card) {
        await updateJobStatus(jobId, { status: 'stage_analyser', currentStepLabel: 'Using your saved product details...' });
        ({ text: analysisText, obj: analysis } = assertAnalysis(card, `SKU card ${job.skuAnalysisId || '(unversioned)'}`));
        console.log(`[ecommRunner] analyser SKIPPED — SKU card ${job.skuAnalysisId || '(unversioned)'} (${card.length} chars)`);
      } else if (useAnalyser) {
        if (!run.allImages.length) throw new Error('no product image on the job, and no SKU analysis to fall back on');
        await updateJobStatus(jobId, { status: 'stage_analyser', currentStepLabel: 'Analysing your product...' });
        const t = Date.now();
        const raw = await runAnalyser({ template, run });
        mark('analyser', t);
        ({ text: analysisText, obj: analysis } = assertAnalysis(raw, 'analyser'));
      } else {
        if (!run.allImages.length) throw new Error('no product image on the job');
        if (mode !== 'direct') throw new Error('the analyser is off, but the planner needs an analysis — turn the analyser on or switch to direct mode');
        console.log('[ecommRunner] analyser OFF — tiles get the master prompt + images only');
      }

      if (analysisText) {
        const stored = await persistLarge(jobId, 'analysis', analysisText);
        await updateJobStatus(jobId, {
          ...(stored.inline != null ? { analysisOutput: stored.inline } : { analysisOutput: null, analysisS3Key: stored.key }),
        });
      }

      if (scope === 'analyser') {
        await updateJobStatus(jobId, {
          status: 'complete', currentStepLabel: 'Analyser test complete',
          jobDurationMs: Date.now() - startTime, completedAt: new Date().toISOString(),
        });
        console.log(`[ecommRunner] ===== Job ${jobId} — analyser-only test COMPLETE =====\n`);
        return { success: true, jobId, stage: 'analyser' };
      }

      if (mode === 'direct') {
        // ── STAGE 2 · tile roles: fixed on the template, or picked for this product
        let roles;
        if (fixedRoles.length >= tileCount) {
          roles = fixedRoles.slice(0, tileCount).map((role, i) => ({ title: `Tile ${i + 1}`, role, rolesFrom: 'template' }));
        } else {
          await updateJobStatus(jobId, { status: 'stage_planner', currentStepLabel: `Choosing the ${tileCount} best tiles...` });
          const tPick = Date.now();
          roles = (await runRolePicker({ template, run, analysisText, tileCount }))
            .map((r) => ({ ...r, rolesFrom: 'auto' }));
          mark('role-picker', tPick);
        }
        tilePlan = roles.map((r, i) => ({ index: i + 1, title: r.title, role: r.role, rolesFrom: r.rolesFrom, source: 'direct' }));
        await updateJobStatus(jobId, { tilePlan });

        if (scope === 'planner') {
          await updateJobStatus(jobId, {
            status: 'complete', currentStepLabel: 'Tile roles chosen',
            jobDurationMs: Date.now() - startTime, completedAt: new Date().toISOString(),
          });
          console.log(`[ecommRunner] ===== Job ${jobId} — roles-only test COMPLETE =====\n`);
          return { success: true, jobId, stage: 'roles', tilePlan };
        }
      } else {
        // ── STAGE 2 · planner (v5) ─────────────────────────────────────────
        await updateJobStatus(jobId, { status: 'stage_planner', currentStepLabel: `Planning ${tileCount} tiles...` });
        const tPlan = Date.now();
        tilePlan = await runPlanner({ template, run, analysisText, tileCount });
        mark('planner', tPlan);

        const planStored = await persistLarge(jobId, 'tilePlan', tilePlan);
        await updateJobStatus(jobId, {
          ...(planStored.inline != null ? { tilePlan: planStored.inline } : { tilePlan: [], tilePlanS3Key: planStored.key }),
        });

        if (scope === 'planner') {
          await updateJobStatus(jobId, {
            status: 'complete', currentStepLabel: 'Planner test complete',
            jobDurationMs: Date.now() - startTime, completedAt: new Date().toISOString(),
          });
          console.log(`[ecommRunner] ===== Job ${jobId} — planner-only test COMPLETE =====\n`);
          return { success: true, jobId, stage: 'planner', tilePlan };
        }
      }
    }

    // ── which tiles this run touches ────────────────────────────────────────
    let targets;
    if (kind === 'regen_one') {
      const idx = parseInt(job.tileIndex, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= tilePlan.length) {
        throw new Error(`tileIndex ${job.tileIndex} is not a tile on this run (0..${tilePlan.length - 1})`);
      }
      targets = [idx];
    } else if (scope === 'tile') {
      targets = [0];                                          // workbook single-tile test
    } else {
      targets = Array.from({ length: tilePlan.length }, (_, i) => i);
    }

    // ── STAGE 3 · generators ────────────────────────────────────────────────
    await updateJobStatus(jobId, {
      status: 'stage_generators',
      currentStepLabel: `Generating ${targets.length} image(s)...`,
    });
    const tGen = Date.now();
    const settled = await generateTiles({
      template, jobId, run, analysis: analysisText, tilePlan, targets, tileCount,
    });
    mark('generators', tGen);
    console.log(`[timing] job=${jobId} SUMMARY ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);

    return await finish({
      jobId, startTime, settled, source, targets,
      verb: kind === 'regen_one' ? 'REGEN_ONE' : (kind === 'regen_all' ? 'REGEN_ALL' : 'RUN'),
    });

  } catch (err) {
    console.error(`[ecommRunner] ===== Job ${jobId} FAILED =====`);
    console.error(err);
    await updateJobStatus(jobId, {
      status: 'failed',
      errorMessage: err.message,
      completedAt: new Date().toISOString(),
      currentStepLabel: 'Failed',
    }).catch(e => console.error('[ecommRunner] Failed to update error status:', e));
    return { success: false, jobId, error: err.message };
  }
}

module.exports = {
  ecommRunner,
  runAnalyser, runPlanner, runGenerator,
  runDirectTile, pipelineModeOf, analyserEnabled, runRolePicker, validateRoles,
  // exported for the admin test routes and for unit tests
  clampTileCount, resolveUploads, mergeOutputs, assertAnalysis, prepareRunInputs, masterPromptOf,
};
