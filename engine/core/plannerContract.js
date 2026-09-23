/* ─────────────────────────────────────────────────────────────────────────────
 * plannerContract.js — Phase 3 / v5 §A2
 *
 * The planner is the one stage that makes parallel generation work.
 *
 * In a chat, "determine the 8 most powerful visual stories … YOU decide
 * everything" works, because the model decides all 8 once and remembers what it
 * already made. Eight independent API calls share NO memory: give all 8 the same
 * prompt and each independently picks *the strongest* story and renders that.
 * You get eight hero shots, not a campaign. This module is that shared memory,
 * made explicit, once, in text — one cheap call that writes 8 briefs, after
 * which each generator owns exactly one.
 *
 * Dependency-free so it can be copied verbatim into
 * ~/ocd-ecomm-engine/engine/core/ when E2 lands.
 * ───────────────────────────────────────────────────────────────────────────── */

'use strict';

/** Every field §A1 requires on a brief. Order is the order they are rendered. */
const BRIEF_FIELDS = [
  'index', 'title', 'shopperQuestion', 'concept', 'camera', 'composition',
  'productPlacement', 'environment', 'lighting', 'palette',
  'copy', 'typographyNote', 'conversionPurpose',
];

/** Fields that must be present and non-empty for a brief to be usable. */
const REQUIRED_FIELDS = [
  'title', 'shopperQuestion', 'concept', 'camera', 'composition',
  'productPlacement', 'environment', 'lighting', 'conversionPurpose',
];

/**
 * The instruction appended after the master prompt + analysis on the planner
 * call. The master prompt does the thinking; this only fixes the output shape.
 */
function plannerInstruction(tileCount) {
  return [
    '### YOUR TASK ON THIS CALL — PLAN ONLY, DO NOT GENERATE',
    '',
    `You are NOT generating images on this call. You are writing the campaign plan: exactly ${tileCount} tile briefs.`,
    '',
    `Each of the ${tileCount} briefs will be handed to a SEPARATE image generation call that sees this plan entry, the product analysis and the product photographs — and NOTHING ELSE. It will not see the other briefs. It cannot tell what the other tiles look like.`,
    '',
    'That has three consequences you must design around:',
    '',
    `1. **The briefs carry all the differentiation.** If two briefs are similar, two tiles will be near-identical. Make all ${tileCount} genuinely different in concept, camera, composition, product placement, environment and lighting.`,
    '2. **The briefs carry the campaign consistency too.** State the shared treatment explicitly in each brief — the lighting philosophy, the palette, the typographic system — because no generator can infer it from tiles it never sees.',
    '3. **Every brief must be self-sufficient.** Never write "same background as tile 3", "as above", "continue the previous look" or any cross-reference. Spell it out each time.',
    '',
    'Apply everything above — the category intelligence, the fidelity rules, the colour and typography discipline, the anti-generic command, the conversion psychology — to decide what these specific tiles should BE for this specific product. Do not fall back on a default hero/benefits/ingredients/lifestyle sequence unless this product genuinely needs it.',
    '',
    'Copy rules still apply: keep it short, and use ONLY claims supported by the supplied product information. Invent no statistics, certifications or performance claims.',
    '',
    '### OUTPUT FORMAT',
    '',
    'Return ONE JSON object and nothing else — no preamble, no commentary, no markdown fence:',
    '',
    '{',
    '  "tiles": [',
    '    {',
    '      "index": 1,',
    '      "title": "short internal label for this tile",',
    '      "shopperQuestion": "the question in the shopper\'s head that this tile answers",',
    '      "concept": "the art-direction idea, specific to THIS product — 2-4 sentences",',
    '      "camera": "camera language: lens, angle, crop, distance",',
    '      "composition": "how the frame is built: balance, negative space, depth",',
    '      "productPlacement": "where the product sits and how it meets the frame",',
    '      "environment": "surface, set, materials, props — or the absence of them",',
    '      "lighting": "quality, direction, contrast, colour of light",',
    '      "palette": "the colours, derived from the product itself",',
    '      "copy": { "headline": "on-image headline, or empty string", "sub": "supporting line, or empty string" },',
    '      "typographyNote": "type treatment, placement and hierarchy for this tile",',
    '      "conversionPurpose": "what this tile does commercially"',
    '    }',
    `    // … through index ${tileCount}`,
    '  ]',
    '}',
    '',
    `Exactly ${tileCount} entries, indexes 1 through ${tileCount}, every field present.`,
  ].join('\n');
}

/**
 * Pull the first balanced-brace JSON object out of a model response.
 * GPT-5.x in particular likes to append trailing prose after valid JSON, and
 * models of every family like to wrap it in a ```json fence.
 */
function parseBalancedJson(text) {
  const src = String(text || '');
  const start = src.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in planner response');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(src.slice(start, i + 1));
    }
  }

  throw new Error('Unbalanced JSON in planner response (response was probably truncated — raise max_completion_tokens)');
}

/** Normalise a word-ish string for duplicate detection. */
function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate a parsed planner response against §A1: count === N, no duplicate
 * concepts, required fields present.
 * @returns {{ tiles: object[]|null, errors: string[], warnings: string[] }}
 */
function validateTilePlan(parsed, tileCount) {
  const errors = [];
  const warnings = [];

  const tiles = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed && parsed.tiles) ? parsed.tiles
    : null;

  if (!tiles) {
    return { tiles: null, errors: ['Planner response has no `tiles` array'], warnings };
  }
  if (tiles.length !== tileCount) {
    errors.push(`Planner returned ${tiles.length} briefs, expected exactly ${tileCount}`);
  }

  tiles.forEach((t, i) => {
    const where = `tile ${i + 1}`;
    if (!t || typeof t !== 'object') { errors.push(`${where}: not an object`); return; }
    for (const f of REQUIRED_FIELDS) {
      if (!t[f] || !String(t[f]).trim()) errors.push(`${where}: missing required field "${f}"`);
    }
    if (t.copy && typeof t.copy !== 'object') errors.push(`${where}: "copy" must be an object with headline/sub`);

    // A brief that points at another tile cannot be executed alone — this is the
    // exact failure the planner exists to prevent, so it is an error, not a nit.
    const blob = JSON.stringify(t);
    if (/\b(as above|same as tile|see tile|previous tile|like tile \d)\b/i.test(blob)) {
      errors.push(`${where}: cross-references another tile — each brief must stand alone (the generator never sees the others)`);
    }
  });

  // Duplicate detection: the collapse-to-8-heroes failure mode.
  const seen = new Map();
  tiles.forEach((t, i) => {
    const key = normalise(t && t.concept).slice(0, 120);
    if (!key) return;
    if (seen.has(key)) errors.push(`tile ${i + 1}: concept duplicates tile ${seen.get(key) + 1}`);
    else seen.set(key, i);
  });

  // Softer signal: the same camera language everywhere means the tiles will
  // look alike even when the concepts read differently.
  const cameras = new Set(tiles.map((t) => normalise(t && t.camera).split(' ').slice(0, 4).join(' ')).filter(Boolean));
  if (tiles.length > 2 && cameras.size <= Math.ceil(tiles.length / 3)) {
    warnings.push(`only ${cameras.size} distinct camera approaches across ${tiles.length} tiles — expect visual sameness`);
  }

  // Renumber defensively: models drift on index even when the rest is perfect.
  const fixed = tiles.map((t, i) => ({ ...t, index: i + 1 }));

  return { tiles: errors.length ? null : fixed, errors, warnings };
}

module.exports = {
  BRIEF_FIELDS,
  REQUIRED_FIELDS,
  plannerInstruction,
  parseBalancedJson,
  validateTilePlan,
};
