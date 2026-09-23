const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { callAgent } = require('./agentCall');
const { uploadBufferToS3 } = require('./s3Uploader');
const { buildSingleTilePrompt, buildDirectTilePrompt } = require('./singleTileEnvelope');
const { plannerInstruction, validateTilePlan } = require('./plannerContract');

// ─── core/ecommRunner.js ─────────────────────────────────────────── Phase 3 ──
// The v5 ecomm pipeline: Analyser → Planner → N × Generator (parallel, briefed).
//
//   analyser   FOP + BOP → product analysis        (SKIPPED on the SKU-card path)
//   planner    masterPrompt + analysis → N briefs  (the campaign, decided ONCE)
//   generators N image calls in parallel, each carrying ONE brief + the photos
//
// ── WHY THE PLANNER EXISTS (§A2 — read before removing it) ────────────────────
// The master prompt says "determine the 8 most powerful visual stories … YOU
// decide everything". In a CHAT that works: the model decides all 8 once and
// remembers what it already made. Eight independent API calls share no memory.
// Give all 8 the same prompt and each independently picks *the strongest* story
// and renders that — eight hero shots, not a campaign. The planner is that
// shared memory, made explicit, once, in text, for ~15s and one text call.
//
// This is the tools engine inverted. Tools runs N IDENTICAL branches to get N
// variants of one design; ecomm runs N DISTINCT branches to get one campaign of
// N designs. Same fan-out machinery, different assignment step — which is why
// this file reads like toolsRunner.js and should keep doing so.
//
// ── WHY THE ENVELOPE EXISTS (§A3 — the silent one) ────────────────────────────
// The stored master prompt ends with "Generate EXACTLY 8 SINGLE, STANDALONE
// IMAGES". Correct for the planner, WRONG for a per-tile call: send it verbatim
// to 8 generators and a good number will attempt all 8 in one frame. You get 8
// collages and it reads as a prompt-quality problem. singleTileEnvelope.js wraps
// the authored prompt per call — the authored text itself is never edited.
//
// ── THREE JOB KINDS ──────────────────────────────────────────────────────────
//   full       first run. Analyser → planner → all N tiles.
//   regen_all  the whole thing again from the top; outputs merge into the set.
//   regen_one  ONE tile again, FROM ITS STORED BRIEF — no analyser, no planner.
//              This is the thing the Magnific sheet flow could never do, and the
//              reason tilePlan[] is persisted rather than thrown away.
//
// ── THE SNAPSHOT INVARIANT (same as toolsRunner — do not break it) ────────────
// Every job writes a complete picture of the set as it stands afterwards: the
// full tilePlan, the effective analysis, and finalOutputs merged over the
// source's. "What does this set look like now" is ONE row lookup, not a replay.
//
// Exported stage functions (runAnalyser / runPlanner / runGenerator) so that
// per-tile routing stays pure routing and never becomes a rebuild.
// ──────────────────────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const ECOMM_PLAYBOOKS_TABLE = process.env.ECOMM_PLAYBOOKS_TABLE || 'EcommPlaybooks';

const DEFAULT_TILE_COUNT = 8;
const MIN_TILE_COUNT = 4;
const MAX_TILE_COUNT = 10;

// §A7-3: eight simultaneous image calls WILL hit provider rate limits.
const TILE_STAGGER_MS = parseInt(process.env.ECOMM_TILE_STAGGER_MS || '3000', 10);
const TILE_RETRY_ATTEMPTS = parseInt(process.env.ECOMM_TILE_RETRY_ATTEMPTS || '3', 10);

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

// The category's master prompt. Falls back to the `other` row, which §A7-5 says
// must exist as a REAL row — a dropdown that offers a category with no prompt
// behind it is a dropdown that lies.
async function loadPlaybook(category) {
  const key = String(category || '').trim() || 'other';
  const r = await dynamo.send(new GetCommand({ TableName: ECOMM_PLAYBOOKS_TABLE, Key: { category: key } }));
  let row = r.Item;

  if (!row && key !== 'other') {
    console.warn(`[ecommRunner] no playbook for category "${key}" — falling back to "other"`);
    const f = await dynamo.send(new GetCommand({ TableName: ECOMM_PLAYBOOKS_TABLE, Key: { category: 'other' } }));
    row = f.Item;
  }
  if (!row) throw new Error(`No playbook for category "${key}", and no "other" fallback row exists`);
  if (!row.masterPrompt || !String(row.masterPrompt).trim()) {
    throw new Error(`Playbook "${row.category}" has no masterPrompt — a v4 row that was never migrated to v5`);
  }

  console.log(`[ecommRunner] playbook "${row.category}" — masterPrompt ${row.masterPrompt.length} chars`);
  return row;
}

/* ── S3 offload (§A7-6) ───────────────────────────────────────────────────── */

// Big values live in S3 and leave a pointer on the row. The reader below
// rehydrates transparently, so nothing downstream has to know which it got.
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
  // Read back through the adapter's own bucket. Lazily required so a runner
  // that never offloads does not pay for the S3 client.
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

// FOP first, BOP second — the order IS the contract, because the role manifest
// the image adapter builds labels them by position.
const IMAGE_ROLES = ['FRONT OF PACK', 'BACK OF PACK'];

function resolveUploads(inputFiles) {
  if (Array.isArray(inputFiles)) return inputFiles.filter(Boolean).slice(0, 2);
  if (inputFiles && typeof inputFiles === 'object') {
    return ['fop', 'bop'].map(k => inputFiles[k]).filter(Boolean);
  }
  return [];
}

// "Tile 3" → slot 2. Labels are the only slot marker that survives a round trip
// through DynamoDB and the status routes (toolsRunner learned this the hard way).
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

// The provider adapters throw Errors whose message carries the HTTP status
// ("[openai_image] OpenAI 429: …"). Nothing structured is available, so the
// status is read back out of the message — ugly, but honest about what we have.
function statusFromError(err) {
  const m = /\b(429|500|502|503|504)\b/.exec(String(err && err.message) || '');
  return m ? parseInt(m[1], 10) : null;
}

// §A7-3 / the gemini_omni v3 pattern. And the hard-won lesson worth repeating in
// the logs: preview models run on a DYNAMIC SHARED quota, so a paid project
// still 429s under global load. That is not your code.
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

/* ── the analysis contract (§A7-4) ────────────────────────────────────────── */

// Both producers must emit the SAME SHAPE — that equality is the only reason
// skipping the analyser is legal. `resolveSkuAnalysisForEcomm` (Lambda side)
// stamps job.skuAnalysis as a JSON STRING, so the pinned schema is "a JSON
// object, serialised". Assert it here, at the join, where a mismatch is cheap
// to see; a half-empty analysis reaching the planner is not.
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

  // Not fatal: key names differ between the SKU card's 9-part analysis and a
  // template's own analyser prompt. Worth saying out loud when both are thin.
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

Study the attached product photograph(s). The first is the FRONT of pack; a second, if present, is the BACK of pack.

Return ONE JSON object describing the product: its category, subcategory, brand and product name exactly as printed, format, packaging architecture and closure, materials and finish, pack colours, every legible line of label text verbatim, any claims or ingredients actually printed, market positioning, target consumer, the consumer problem it solves, the desired outcome, the usage ritual, its sensory personality, purchase triggers and differentiators.

Report ONLY what you can see. Never invent brand names, ingredients, statistics, certifications or claims. Where a field is unknowable from the photographs, say so rather than guessing.`;

/** STAGE 1 — Path A only. Reads the product; never selects anything. */
async function runAnalyser({ template, uploads }) {
  const a = (template.analyser || (template.agents && template.agents.analyser) || {});
  return callAgent({
    label: 'analyser',
    prompt: a.prompt || DEFAULT_ANALYSER_PROMPT,
    model: a.model,
    images: uploads || [],
    expectJson: true,
    maxOutputTokens: 16384,
  });
}

/**
 * STAGE 2 — the campaign, decided once. The planner sees the master prompt
 * WHOLE, including its 8-image output block: that block is correct here and is
 * only wrong on a per-tile call.
 */
async function runPlanner({ template, masterPrompt, analysisText, uploads, tileCount }) {
  const p = template.planner || {};
  const instruction = p.instruction || plannerInstruction(tileCount);

  const call = (correction) => callAgent({
    label: correction ? 'planner-retry' : 'planner',
    prompt: masterPrompt,
    model: p.model,
    images: uploads || [],
    attachments: [
      { title: 'PRODUCT ANALYSIS', content: analysisText },
      { title: 'YOUR TASK ON THIS CALL', content: correction ? `${instruction}\n\n### RETRY\n\nYour previous response was rejected: ${correction}\n\nReturn corrected JSON only.` : instruction },
    ],
    expectJson: true,
    // gpt-5.x counts reasoning tokens against this budget — too small a cap
    // returns EMPTY content with finish_reason:"length". Be generous.
    maxOutputTokens: 32000,
  });

  let parsed = await call(null);
  let { tiles, errors, warnings } = validateTilePlan(parsed, tileCount);

  if (errors.length) {
    // ONE stricter retry, then fail loudly — a bad plan makes 8 bad tiles, and
    // discovering that after the image spend is the expensive way to find out.
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

// Adapters share one contract:
//   execute({ prompt, inputs, imageUrls, model, quality, resolution, stepId, tileIndex })
//     → { outputs: [{ label, type, url }], caption, model }
// Lazily required so a missing adapter names itself instead of crashing the
// whole worker at boot. ⚠️ §9: generate-verify seedream/nanobanana FROM THIS
// ENGINE before enabling either — this folder's copies have drifted before.
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

/** STAGE 3 — one tile. Its brief, the analysis, and the real product photos. */
async function runGenerator({ template, jobId, masterPrompt, analysis, brief, uploads, index, tileCount }) {
  const g = template.generator || {};
  const slot = index;             // 0-based
  const human = index + 1;        // the brief's own 1-based index

  const { prompt, warnings } = buildSingleTilePrompt({
    masterPrompt, analysis, brief, index: human, tileCount,
  });
  // A warning here is not cosmetic: "no OUTPUT REQUIREMENT heading" means the
  // multi-image block survived and this tile may come back as a collage.
  warnings.forEach(w => console.warn(`[ecommRunner] tile ${human}: ${w}`));

  const adapter = resolveProvider(g.provider);
  const result = await adapter.execute({
    prompt,
    imageUrls: uploads || [],
    model: g.model || 'gpt-image-2',
    quality: g.quality || 'high',
    resolution: g.resolution || '2k',
    inputs: {
      aspectRatio: g.aspectRatio || '1:1',
      // Name the two photos by role so the adapter's manifest says
      // "Image 1 = PRODUCT — FRONT OF PACK" rather than "additional view 2".
      imageLabels: IMAGE_ROLES.slice(0, (uploads || []).length),
    },
    // The adapter derives the S3 key from stepId + tileIndex, giving
    // ai-outputs/ecomm_<jobId>_t<n>_0_<ts>.<ext> — §A1's naming, adapter-shaped.
    stepId: `ecomm_${jobId}`,
    tileIndex: human,
  });

  const url = result && result.outputs && result.outputs[0] && result.outputs[0].url;
  if (!url) throw new Error(`tile ${human}: generator returned no image url`);
  return url;
}

/* ── DIRECT MODE ──────────────────────────────────────────────────────────────
 *   FOP + BOP → analyser (optional) → master prompt → N tiles in parallel.
 *   No planner, no briefs. Each tile gets the master prompt, its slot number,
 *   the analysis at the end (if the analyser ran) and both photos.
 * template.pipelineMode: 'direct' | 'planner' (v5).  Missing = 'planner', so
 * saved templates keep working exactly as before.
 * template.analyser.enabled: false skips the analyser call (default true).
 * ──────────────────────────────────────────────────────────────────────────── */

function pipelineModeOf(template) {
  return String((template && template.pipelineMode) || 'planner').toLowerCase() === 'direct' ? 'direct' : 'planner';
}

function analyserEnabled(template) {
  const a = (template && (template.analyser || (template.agents && template.agents.analyser))) || {};
  return a.enabled !== false;
}

/** DIRECT TILE — master prompt + slot number (+ analysis) + both photos. */
async function runDirectTile({ template, jobId, masterPrompt, analysis, uploads, index, tileCount }) {
  const g = template.generator || {};
  const human = index + 1;
  const { prompt, warnings } = buildDirectTilePrompt({ masterPrompt, analysis, index: human, tileCount });
  warnings.forEach(w => console.warn(`[ecommRunner] tile ${human}: ${w}`));

  const adapter = resolveProvider(g.provider);
  const result = await adapter.execute({
    prompt,
    imageUrls: uploads || [],
    model: g.model || 'gpt-image-2',
    quality: g.quality || 'high',
    resolution: g.resolution || '2k',
    inputs: {
      aspectRatio: g.aspectRatio || '1:1',
      imageLabels: IMAGE_ROLES.slice(0, (uploads || []).length),
    },
    stepId: `ecomm_${jobId}`,
    tileIndex: human,
  });

  const url = result && result.outputs && result.outputs[0] && result.outputs[0].url;
  if (!url) throw new Error(`tile ${human}: generator returned no image url`);
  return url;
}

/**
 * Fan out over the tiles. Staggered, per-tile isolation, partial success still
 * completes the job — one dead tile must never cost the other seven.
 * An entry with source:'direct' is rendered from the master prompt alone;
 * any other entry is a planner brief.
 */
async function generateTiles({ template, jobId, masterPrompt, analysis, tilePlan, uploads, targets, tileCount }) {
  console.log(`[ecommRunner] generating ${targets.length} tile(s) in parallel — ${TILE_STAGGER_MS}ms stagger, ${(uploads || []).length} reference image(s)`);

  const settled = await Promise.allSettled(targets.map(async (slot, k) => {
    await sleep(k * TILE_STAGGER_MS);
    const t0 = Date.now();
    const entry = tilePlan[slot];
    const url = await withBackoff(`tile ${slot + 1}`, () => (
      entry && entry.source === 'direct'
        ? runDirectTile({ template, jobId, masterPrompt, analysis, uploads, index: slot, tileCount })
        : runGenerator({ template, jobId, masterPrompt, analysis, brief: entry, uploads, index: slot, tileCount })
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
      errorMessage: 'Every tile failed to generate',
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
    const uploads = resolveUploads(job.inputFiles);
    const category = job.category || job.selectedPlaybookKey || template.category;

    const scope = (messageBody && messageBody._ecommTestScope) || 'full';   // 'analyser'|'planner'|'tile'|'full'
    const mode = pipelineModeOf(template);
    const useAnalyser = analyserEnabled(template);
    console.log(`[ecommRunner] pipeline mode: ${mode} · analyser ${useAnalyser ? 'ON' : 'OFF'} · ${tileCount} tiles · scope: ${scope}`);

    const { masterPrompt } = await loadPlaybook(category);
    const source = INHERITING_KINDS.has(kind) ? await loadSourceState(job) : null;

    let analysis, analysisText, tilePlan;

    if (kind === 'regen_one') {
      // ── The whole point of persisting tilePlan[]: re-render ONE tile from its
      // stored brief. No analyser, no planner, no re-deciding the campaign.
      if (!source) throw new Error('regen_one job has no sourceJobId or parentJobId');
      if (!source.tilePlan.length) throw new Error(`source run ${source.jobId} has no tilePlan to re-render from`);
      const isDirect = source.tilePlan.every(t => t && t.source === 'direct');
      if (!source.analysis && !isDirect) throw new Error(`source run ${source.jobId} has no analysis to re-render from`);

      // A direct run with the analyser off has no analysis — that is fine.
      if (source.analysis) ({ text: analysisText, obj: analysis } = assertAnalysis(source.analysis, `source run ${source.jobId}`));
      tilePlan = source.tilePlan;

      await updateJobStatus(jobId, {
        status: 'stage_generators',
        currentStepLabel: 'Re-rendering one tile...',
        analysisOutput: source.analysis,
        tilePlan,
      });
      console.log(`[ecommRunner] regen_one — reusing the analysis + brief from ${source.jobId}`);

    } else {
      // ── STAGE 1 · analyser, or the SKU-card skip ──────────────────────────
      const card = String(job.skuAnalysis || '').trim();

      if (card) {
        await updateJobStatus(jobId, { status: 'stage_analyser', currentStepLabel: 'Using your saved product details...' });
        ({ text: analysisText, obj: analysis } = assertAnalysis(card, `SKU card ${job.skuAnalysisId || '(unversioned)'}`));
        console.log(`[ecommRunner] analyser SKIPPED — SKU card ${job.skuAnalysisId || '(unversioned)'} (${card.length} chars)`);
      } else if (useAnalyser) {
        if (!uploads.length) throw new Error('no product image on the job, and no SKU analysis to fall back on');
        await updateJobStatus(jobId, { status: 'stage_analyser', currentStepLabel: 'Analysing your product...' });
        const t = Date.now();
        const raw = await runAnalyser({ template, uploads });
        mark('analyser', t);
        ({ text: analysisText, obj: analysis } = assertAnalysis(raw, 'analyser'));
      } else {
        if (!uploads.length) throw new Error('no product image on the job');
        if (mode !== 'direct') throw new Error('the analyser is off, but the planner needs an analysis — turn the analyser on or switch to direct mode');
        console.log('[ecommRunner] analyser OFF — tiles get the master prompt + photos only');
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

      // ── STAGE 2 · planner (v5 only — direct mode has no briefs) ───────────
      if (mode === 'direct') {
        // One placeholder per slot, so regen_one, /set and the status routes
        // (which read tilePlan titles) work unchanged.
        tilePlan = Array.from({ length: tileCount }, (_, i) => ({ index: i + 1, title: `Tile ${i + 1}`, source: 'direct' }));
        await updateJobStatus(jobId, { tilePlan });
        if (scope === 'planner') {
          // Direct mode has no planner. Never let this button spend 8 images.
          await updateJobStatus(jobId, {
            status: 'complete', currentStepLabel: 'Direct mode has no planner step',
            jobDurationMs: Date.now() - startTime, completedAt: new Date().toISOString(),
          });
          return { success: true, jobId, stage: 'planner', skipped: true };
        }
      } else {
        // ── STAGE 2 · planner ─────────────────────────────────────────────────
        await updateJobStatus(jobId, { status: 'stage_planner', currentStepLabel: `Planning ${tileCount} tiles...` });
        const tPlan = Date.now();
        tilePlan = await runPlanner({ template, masterPrompt, analysisText, uploads, tileCount });
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
      template, jobId, masterPrompt, analysis: analysisText, tilePlan, uploads, targets, tileCount,
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
  runDirectTile, pipelineModeOf, analyserEnabled,
  // exported for the admin test routes and for unit tests
  clampTileCount, resolveUploads, mergeOutputs, assertAnalysis, loadPlaybook,
};
