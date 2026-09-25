/* ─────────────────────────────────────────────────────────────────────────────
 * ecommInputs.js — Phase 3 · v7 (Sep 25, 2026)
 *
 * The template's customer inputs, and the {{tokens}} that put them into the
 * master prompt. There are no playbooks any more: the master prompt lives on
 * the template, and this file turns it into one plain string per call.
 *
 * KEEP IN SYNC WITH:
 *   app.js           cleanEcommInputSchema / ecommFieldsFor / collectEcommInputs
 *   EcommWorkbook.js resolveTokens (the "Preview resolved prompt" panel)
 *
 * ── The schema (template.inputSchema) ────────────────────────────────────────
 *   { version: 2, mode: "subcategory", subcategories: [{ key, label, masterPrompt, fields: [...] }] }
 *   { version: 2, mode: "fixed",       fields: [...] }
 *
 *   Master prompt: subcategory mode → each subcategory has its OWN masterPrompt.
 *                  fixed mode       → template.masterPrompt.
 *
 *   field = { key, type: "image"|"text"|"select", label, hint, required,
 *             options (select), placeholder (text),
 *             toTiles (image: attach to the image calls), note (image: what the
 *             model is told this image is) }
 *
 *   Every field list starts with the main product photo, key "imageUpload-fop".
 *
 * ── The tokens ───────────────────────────────────────────────────────────────
 *   {{userInputs.<key>}}   a text or select field → the customer's value
 *   {{<imageKey>}}         an image field → "Image 2 (TEXTURE IMAGE)" when that
 *                          image is attached to THIS call, "" when it is not
 *   {{subcategory}}        the subcategory the customer picked, e.g. "Skincare"
 *
 *   Line rule: a line whose tokens ALL came out empty is removed. So
 *     "Hair type: {{userInputs.HairType}}"
 *   disappears for a skincare run, or when the customer left it blank.
 *
 *   Keys are case-sensitive. A token with the wrong case still resolves (the
 *   engine falls back to a case-insensitive match) but it is logged as a warning.
 * ───────────────────────────────────────────────────────────────────────────── */

'use strict';

const MAIN_IMAGE_KEY = 'imageUpload-fop';
const BACK_IMAGE_KEY = 'imageUpload-bop';

// Old job rows and old templates used these names for the two photos.
const LEGACY_FILE_KEYS = {
  fop: MAIN_IMAGE_KEY,
  bop: BACK_IMAGE_KEY,
  userUpload: MAIN_IMAGE_KEY,
  userUpload2: BACK_IMAGE_KEY,
};

const FIELD_TYPES = ['image', 'text', 'select'];
const TEXT_MAX = 2000;

// What each image is, told to every model that sees it. The main photo has a
// fixed line (see imageLine); these are the defaults for the others. A field's
// own `note` wins.
const DEFAULT_IMAGE_NOTES = {
  [BACK_IMAGE_KEY]: 'The back of the same pack. Read it for facts: claims, ingredients, directions, net quantity. It is not a second product.',
  textureImage: "A close-up of the product's texture, out of the pack. Whenever a tile shows the texture, colour or consistency of the product, match this image exactly.",
  shadeCard: "The product's shade range. Whenever a tile shows shades, use exactly these shades and their names. Never invent or add a shade.",
};
const GENERIC_IMAGE_NOTE = 'A reference photo from the seller. Use it only for what its name says. It is not a second product.';

/* ── schema ───────────────────────────────────────────────────────────────── */

function cleanField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || '').trim();
  if (!key) return null;
  let type = String(raw.type || '').toLowerCase();
  if (type === 'file') type = 'image';
  if (type === 'textarea') type = 'text';
  if (!FIELD_TYPES.includes(type)) type = 'text';

  const f = {
    key,
    type,
    label: String(raw.label || key).trim(),
    hint: String(raw.hint || '').trim(),
    required: raw.required === true,
  };
  if (type === 'select') {
    const seen = new Set();
    f.options = (Array.isArray(raw.options) ? raw.options : [])
      .map((o) => String(o == null ? '' : o).trim())
      .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  }
  if (type === 'text') f.placeholder = String(raw.placeholder || '').trim();
  if (type === 'image') {
    f.toTiles = raw.toTiles !== undefined ? raw.toTiles !== false : key !== BACK_IMAGE_KEY;
    f.note = String(raw.note || '').trim();
  }
  if (key === MAIN_IMAGE_KEY) { f.type = 'image'; f.required = true; f.toTiles = true; }
  return f;
}

// Main photo first, then the author's order. Duplicate keys: first one wins.
function cleanFieldList(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((raw) => {
    const f = cleanField(raw);
    if (!f || seen.has(f.key)) return;
    seen.add(f.key);
    out.push(f);
  });
  const main = out.findIndex((f) => f.key === MAIN_IMAGE_KEY);
  if (main > 0) out.unshift(out.splice(main, 1)[0]);
  return out;
}

// A template saved before v7 has an array (or map) of userUpload / userUpload2.
function legacyFields(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? Object.entries(raw).map(([key, v]) => ({ key, ...(v || {}) })) : []);
  const hasBack = list.some((f) => f && (f.key === 'userUpload2' || f.key === 'bop' || f.key === BACK_IMAGE_KEY));
  const fields = [{ key: MAIN_IMAGE_KEY, type: 'image', label: 'Front of pack', required: true }];
  if (hasBack || !list.length) fields.push({ key: BACK_IMAGE_KEY, type: 'image', label: 'Back of pack', required: false, toTiles: false });
  return cleanFieldList(fields);
}

/** The template's schema, always in the v2 shape. */
function schemaOf(template) {
  const raw = template && template.inputSchema;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.version === 2 || raw.mode)) {
    if (raw.mode === 'subcategory') {
      const subs = (Array.isArray(raw.subcategories) ? raw.subcategories : [])
        .map((s) => ({
          key: String((s && s.key) || '').trim(),
          label: String((s && (s.label || s.key)) || '').trim(),
          masterPrompt: typeof (s && s.masterPrompt) === 'string' ? s.masterPrompt : '',
          fields: cleanFieldList(s && s.fields),
        }))
        .filter((s) => s.key);
      return { version: 2, mode: 'subcategory', subcategories: subs };
    }
    return { version: 2, mode: 'fixed', fields: cleanFieldList(raw.fields) };
  }
  return { version: 2, mode: 'fixed', fields: legacyFields(raw), legacy: true };
}

/**
 * The fields and the master prompt that apply to this run.
 * Subcategory mode: the subcategory's own fields and master prompt.
 * Fixed mode: the template's fields and template.masterPrompt.
 * @returns {{ fields: object[], subcategory: {key,label}|null, masterPrompt: string, error: string|null }}
 */
function fieldsFor(template, subcategoryKey) {
  const schema = schemaOf(template);
  if (schema.mode === 'fixed') {
    return { fields: schema.fields, subcategory: null, masterPrompt: String((template && template.masterPrompt) || ''), error: null };
  }

  const want = String(subcategoryKey || '').trim().toLowerCase();
  const sub = schema.subcategories.find((s) => s.key.toLowerCase() === want);
  if (!sub) {
    const known = schema.subcategories.map((s) => s.key).join(', ') || '(none)';
    return { fields: [], subcategory: null, masterPrompt: '', error: want ? `unknown subcategory "${subcategoryKey}" (this template has: ${known})` : `a subcategory is required (this template has: ${known})` };
  }
  return { fields: sub.fields, subcategory: { key: sub.key, label: sub.label || sub.key }, masterPrompt: sub.masterPrompt, error: null };
}

/* ── the job's files ──────────────────────────────────────────────────────── */

/** { fieldKey: url }. Accepts the v7 map, the old { fop, bop } map, or an array. */
function normaliseInputFiles(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    const [a, b] = raw.filter((u) => typeof u === 'string' && u.trim());
    if (a) out[MAIN_IMAGE_KEY] = a.trim();
    if (b) out[BACK_IMAGE_KEY] = b.trim();
    return out;
  }
  if (typeof raw === 'object') {
    Object.entries(raw).forEach(([k, v]) => {
      if (typeof v !== 'string' || !v.trim()) return;
      const key = LEGACY_FILE_KEYS[k] || k;
      if (!out[key]) out[key] = v.trim();
    });
  }
  return out;
}

/**
 * The images on this job, in the order they are attached: main photo first,
 * then the schema's order. Only images that were actually uploaded.
 * An uploaded file with no field in the schema is ignored (and reported).
 */
function imagePlan(fields, inputFiles) {
  const files = normaliseInputFiles(inputFiles);
  const images = (fields || [])
    .filter((f) => f.type === 'image' && files[f.key])
    .map((f) => ({
      key: f.key,
      label: f.label || f.key,
      name: String(f.label || f.key).toUpperCase(),
      url: files[f.key],
      toTiles: f.key === MAIN_IMAGE_KEY ? true : f.toTiles !== false,
      isMain: f.key === MAIN_IMAGE_KEY,
      note: f.note || DEFAULT_IMAGE_NOTES[f.key] || GENERIC_IMAGE_NOTE,
    }));
  const main = images.findIndex((im) => im.isMain);
  if (main > 0) images.unshift(images.splice(main, 1)[0]);
  const known = new Set((fields || []).map((f) => f.key));
  const ignored = Object.keys(files).filter((k) => !known.has(k));
  return { images, ignored };
}

/* ── the image list (replaces the image adapter's own manifest) ───────────── */

function imageLine(im, n) {
  if (im.isMain) {
    return `Image ${n} = ${im.name}. This is the product itself and the single source of truth for its packaging, shape, label artwork, logo, lettering, colours, material and finish. Reproduce it exactly. Never redesign it, never re-letter it, never invent branding that is not on it.`;
  }
  return `Image ${n} = ${im.name}. ${im.note}`;
}

/** The block that opens every prompt that carries images. '' when there are none. */
function imageListBlock(images) {
  if (!images || !images.length) return '';
  return [
    'ATTACHED IMAGES',
    '',
    ...images.map((im, i) => imageLine(im, i + 1)),
    '',
    images.length > 1 ? 'All of these images show the same ONE product. Never treat an extra image as a second product.' : null,
    '------',
    '',
    '',
  ].filter((l) => l !== null).join('\n');
}

/* ── the seller's inputs as plain text (for the analyser) ─────────────────── */

function sellerInputsBlock(fields, userInputs) {
  const ui = userInputs || {};
  return (fields || [])
    .filter((f) => f.type !== 'image')
    .map((f) => {
      const v = valueOf(ui, f.key).value;
      return v ? `${f.label}: ${v}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

/* ── token resolution ─────────────────────────────────────────────────────── */

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  if (typeof v === 'object') return '';
  return String(v).trim();
}

// Exact key first; a different-case key still resolves, but says so.
function valueOf(values, key) {
  if (Object.prototype.hasOwnProperty.call(values, key)) return { value: asText(values[key]), caseMismatch: null };
  const lower = key.toLowerCase();
  const hit = Object.keys(values).find((k) => k.toLowerCase() === lower);
  return hit ? { value: asText(values[hit]), caseMismatch: hit } : { value: '', caseMismatch: null };
}

/**
 * Resolve every {{token}} in `text` to a plain string for ONE call.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {object[]} ctx.fields      the run's fields (fieldsFor(...).fields)
 * @param {object}   ctx.userInputs  { key: value }
 * @param {object[]} ctx.images      the images attached to THIS call, in order (from imagePlan)
 * @param {{key,label}|null} ctx.subcategory
 * @param {Set<string>} [ctx.allKeys] every key in every subcategory — a token for a
 *        field in ANOTHER subcategory is normal, not a typo
 * @returns {{ text: string, warnings: string[] }}
 */
function resolveTokens(text, ctx) {
  const c = ctx || {};
  const fields = c.fields || [];
  const ui = c.userInputs || {};
  const attached = new Map((c.images || []).map((im, i) => [im.key, `Image ${i + 1} (${im.name})`]));
  const fieldKeys = new Set(fields.map((f) => f.key));
  const allKeys = c.allKeys || fieldKeys;
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };

  const resolveOne = (name) => {
    if (name === 'subcategory') return (c.subcategory && c.subcategory.label) || '';
    if (name.startsWith('userInputs.')) {
      const key = name.slice('userInputs.'.length);
      const { value, caseMismatch } = valueOf(ui, key);
      if (caseMismatch) warn(`{{${name}}} matched the input "${caseMismatch}" only by ignoring case — fix the token's case`);
      else if (!fieldKeys.has(key) && !allKeys.has(key)) warn(`{{${name}}} matches no field for this run — it resolved to nothing`);
      return value;
    }
    // Image token. Case-insensitive fallback, same as inputs.
    if (attached.has(name)) return attached.get(name);
    const hit = [...attached.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit) { warn(`{{${name}}} matched the image "${hit}" only by ignoring case — fix the token's case`); return attached.get(hit); }
    const known = [...allKeys].some((k) => k.toLowerCase() === name.toLowerCase());
    if (!known) warn(`{{${name}}} matches no field for this run — it resolved to nothing`);
    return '';   // a real image that is not on this call (not uploaded, or not sent to tiles)
  };

  const lines = String(text || '').split('\n');
  const out = [];
  lines.forEach((line) => {
    let tokens = 0;
    let filled = 0;
    const resolved = line.replace(TOKEN_RE, (_, name) => {
      tokens++;
      const v = resolveOne(name);
      if (v) filled++;
      return v;
    });
    if (tokens > 0 && filled === 0) return;          // every token on this line was empty → drop it
    out.push(tokens > 0 ? resolved.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '') : resolved);
  });

  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: joined, warnings };
}

/** Every token in a text, e.g. ["userInputs.TextInput", "textureImage"]. */
function tokensIn(text) {
  const found = new Set();
  String(text || '').replace(TOKEN_RE, (_, name) => { found.add(name); return ''; });
  return [...found];
}

/** Every field key across every subcategory (or the fixed list). */
function allFieldKeys(template) {
  const s = schemaOf(template);
  const lists = s.mode === 'subcategory' ? s.subcategories.map((x) => x.fields) : [s.fields];
  return new Set(lists.flat().map((f) => f.key));
}

/**
 * Check the run's inputs against its fields. The Lambda already did this for
 * customer runs; the engine repeats the cheap parts so a hand-queued job fails
 * with a clear message instead of a half-empty prompt.
 */
function checkInputs(fields, inputFiles, userInputs) {
  const files = normaliseInputFiles(inputFiles);
  const ui = userInputs || {};
  const errors = [];
  const warnings = [];
  (fields || []).forEach((f) => {
    const has = f.type === 'image' ? !!files[f.key] : !!valueOf(ui, f.key).value;
    if (f.required && !has) (f.key === MAIN_IMAGE_KEY ? errors : warnings).push(`required input "${f.label}" (${f.key}) is empty`);
    if (f.type === 'select' && has) {
      const v = valueOf(ui, f.key).value;
      if (f.options && f.options.length && !f.options.includes(v)) warnings.push(`"${f.label}" has "${v}", which is not one of its options`);
    }
  });
  return { errors, warnings };
}

module.exports = {
  MAIN_IMAGE_KEY,
  BACK_IMAGE_KEY,
  TEXT_MAX,
  DEFAULT_IMAGE_NOTES,
  schemaOf,
  fieldsFor,
  normaliseInputFiles,
  imagePlan,
  imageListBlock,
  sellerInputsBlock,
  resolveTokens,
  tokensIn,
  allFieldKeys,
  checkInputs,
};