/* ─────────────────────────────────────────────────────────────────────────────
 * singleTileEnvelope.js — Phase 3 / v5 §A3
 *
 * ⚠️ THE SILENT FAILURE THIS FILE EXISTS TO PREVENT.
 * The stored master prompt ends with "Generate EXACTLY 8 SINGLE, STANDALONE
 * IMAGES … DO NOT generate one collage / one contact sheet / eight panels in one
 * image." That is correct for a chat and for the planner call. Send it verbatim
 * to a PER-TILE generator call and a good number of models will dutifully
 * attempt all 8 in one frame. You get 8 collages, and it reads as a
 * prompt-quality problem rather than a wiring bug.
 *
 * So: the authored master prompt is the BRAIN and is never edited — authors keep
 * pasting exactly what the strategist wrote. The engine wraps it per call here.
 *
 * KEEP     role stack · category intelligence · fidelity rules · colour,
 *          typography and photography discipline · anti-generic command ·
 *          conversion psychology
 * OVERRIDE everything from "### OUTPUT REQUIREMENT" onward — that whole tail is
 *          eight-images-at-once instruction ("MAKE THE 8 STRONGEST POSSIBLE
 *          PDP/A+ IMAGES…" sits after the block too, and is just as dangerous)
 * APPEND   the analysis + this tile's brief
 *
 * This module is written dependency-free so it can be copied verbatim into
 * ~/ocd-ecomm-engine/engine/core/ when E2/E3 land.
 * ───────────────────────────────────────────────────────────────────────────── */

'use strict';

// The heading the authored prompts use to open their multi-image output block.
// Both shipped prompts (beauty, other) carry it; a category prompt that does not
// is flagged rather than silently mis-wrapped.
const OUTPUT_REQUIREMENT_HEADING = '### OUTPUT REQUIREMENT';

/**
 * Split the master prompt into the part that survives into a per-tile call and
 * the discarded multi-image tail.
 * @returns {{ brain: string, tail: string, found: boolean }}
 */
// Also accept the strategist's newer heading style: a line that is just
// "# OUTPUT", "## OUTPUT" or "### OUTPUT REQUIREMENT" (any 1–4 #'s).
const OUTPUT_HEADING_RE = /^#{1,4}[ \t]*OUTPUT(?:[ \t]+REQUIREMENT)?[ \t]*$/m;

function stripOutputRequirement(masterPrompt) {
  const src = String(masterPrompt || '');
  const m = OUTPUT_HEADING_RE.exec(src);
  const idx = m ? m.index : -1;
  if (idx === -1) {
    // No heading to cut at. Returning the whole prompt is the honest thing to do
    // — but the caller MUST surface `found:false`, because this is the exact
    // shape of the failure that produces collages.
    return { brain: src.trimEnd(), tail: '', found: false };
  }
  return {
    brain: src.slice(0, idx).trimEnd(),
    tail: src.slice(idx).trimEnd(),
    found: true,
  };
}

/** The replacement output block. §A3, verbatim intent. */
function singleTileOutputBlock(index, tileCount) {
  return [
    '### OUTPUT REQUIREMENT — SINGLE TILE',
    '',
    `Generate ONE single standalone image: tile ${index} of ${tileCount}. Its brief follows. Do not render any other tile, panel, collage or variation.`,
    '',
    'This call produces exactly ONE finished Amazon PDP/A+ creative — the one described in the brief below.',
    '',
    `Everything above describes the ${tileCount}-image campaign this tile belongs to. That campaign has already been planned, and the other tiles are already being made. Read it as context for the standard this one tile must meet — not as an instruction to produce ${tileCount} images now.`,
    '',
    'DO NOT generate:',
    '',
    '* A collage',
    '* A contact sheet',
    '* Multiple panels in one image',
    '* Multiple concepts inside one image',
    '* A grid, sheet, strip or comparison of variations',
    '* Any of the other tiles in this campaign',
    '',
    'One frame. One idea. The brief below and nothing else.',
    '',
    'The other tiles in this campaign are being generated separately and are not your concern — do not reference them, summarise them, or try to leave room for them.',
    '',
    'Do not explain the concept first.',
    'Do not ask for approval.',
    'Do not ask the user to choose a layout.',
    '',
    'ANALYZE → ART DIRECT → CREATE.',
    '',
    'MAXIMUM PRODUCT FIDELITY. MAXIMUM PREMIUM PERCEPTION. ZERO GENERIC DESIGN.',
  ].join('\n');
}

/**
 * DIRECT MODE output block: no brief. The tile knows only its slot number and
 * decides the concept itself from the master prompt. Numbered-tile rules in the
 * master prompt (e.g. "TILE 1 — FOP on white") still apply to that slot.
 */
function directTileOutputBlock(index, tileCount, slotRole) {
  // slotRole = this slot's line from the playbook's tileTaxonomy[]. Without it,
  // 8 separate calls each pick "the strongest" idea — the same one — and the
  // set comes back as 8 near-identical heroes. The role is what keeps them apart.
  const roleLines = slotRole
    ? [
      `THIS TILE'S ROLE — fixed for slot ${index} of ${tileCount}:`,
      '',
      String(slotRole).trim(),
      '',
      'Deliver exactly this role. Within it, you decide the concept, composition, camera, setting, copy and art direction, to the standard set above.',
      'Every other tile in the set has a different role, so do not drift into a general hero shot of the product.',
    ]
    : [
      `If the instructions above fix what a numbered tile must be, follow them exactly for tile ${index}.`,
      `Otherwise, you are the creative director for this tile. Choose the strongest concept for position ${index} of ${tileCount} in the shopper journey: the first tiles stop the shopper and show the product, the middle tiles explain and build desire, the last tiles build trust and close the sale.`,
    ];
  return [
    '### OUTPUT REQUIREMENT — SINGLE TILE',
    '',
    `Generate ONE single standalone image: tile ${index} of ${tileCount} in the campaign described above.`,
    '',
    ...roleLines,
    '',
    `The other ${tileCount - 1} tiles are made in separate calls at the same time. Do not try to show them.`,
    '',
    'DO NOT generate:',
    '',
    '* A collage',
    '* A contact sheet',
    '* Multiple panels in one image',
    '* A grid, sheet or strip of variations',
    '',
    'One frame. One idea. One finished Amazon PDP/A+ creative.',
    '',
    'Do not explain the concept first. Do not ask for approval.',
  ].join('\n');
}

/**
 * DIRECT MODE prompt: master prompt (its own 8-image output block replaced) →
 * the single-tile block → the analysis at the very end, if the analyser ran.
 */
function buildDirectTilePrompt({ masterPrompt, analysis, index, tileCount, slotRole }) {
  const warnings = [];
  if (!slotRole) warnings.push(`no tile role for slot ${index} — without one, tiles tend to repeat the same idea.`);
  const { brain, found } = stripOutputRequirement(masterPrompt);
  if (!found) {
    warnings.push('masterPrompt has no OUTPUT heading — its 8-image block could not be replaced, so this tile may come back as a collage.');
  }
  const analysisText = renderAnalysis(analysis);
  const parts = [brain, '', directTileOutputBlock(index, tileCount, slotRole)];  
  if (analysisText) {
    parts.push(
      '',
      '### PRODUCT ANALYSIS',
      '',
      'This is what the product is. The attached photographs are the authority on how it looks — where the two disagree, the photographs win.',
      '',
      analysisText,
    );
  }
  return { prompt: parts.join('\n'), warnings };
}

/** Render the analysis as prompt text, whichever shape it arrived in. */
function renderAnalysis(analysis) {
  if (analysis == null) return '';
  if (typeof analysis === 'string') return analysis.trim();
  return JSON.stringify(analysis, null, 2);
}

/** Render one tile brief as readable directive text (not raw JSON). */
function renderBrief(brief) {
  if (typeof brief === 'string') return brief.trim();
  const b = brief || {};
  const line = (label, value) => {
    if (value == null || value === '') return null;
    return `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  };
  const copy = b.copy || {};
  return [
    line('TITLE', b.title),
    line('SHOPPER QUESTION THIS TILE ANSWERS', b.shopperQuestion),
    line('CONCEPT', b.concept),
    line('CAMERA', b.camera),
    line('COMPOSITION', b.composition),
    line('PRODUCT PLACEMENT', b.productPlacement),
    line('ENVIRONMENT', b.environment),
    line('LIGHTING', b.lighting),
    line('PALETTE', b.palette),
    line('HEADLINE (set this type on the image, verbatim)', copy.headline),
    line('SUBHEAD (set this type on the image, verbatim)', copy.sub),
    line('TYPOGRAPHY', b.typographyNote),
    line('CONVERSION PURPOSE', b.conversionPurpose),
  ].filter(Boolean).join('\n');
}

/**
 * Build the full per-tile generator prompt.
 *
 * @param {object}  args
 * @param {string}  args.masterPrompt  the category's stored masterPrompt, verbatim
 * @param {object|string} args.analysis the product analysis (analyser or SKU card)
 * @param {object|string} args.brief    this tile's brief from tilePlan[i]
 * @param {number}  args.index          1-based tile number, for the human-readable "tile i of N"
 * @param {number}  args.tileCount      N
 * @returns {{ prompt: string, warnings: string[] }}
 */
function buildSingleTilePrompt({ masterPrompt, analysis, brief, index, tileCount }) {
  const warnings = [];
  const { brain, found } = stripOutputRequirement(masterPrompt);

  if (!found) {
    warnings.push(
      `masterPrompt has no "${OUTPUT_REQUIREMENT_HEADING}" heading — the multi-image output block could not be`
      + ' replaced, so this call may return a collage. Fix the stored prompt before trusting the output.'
    );
  }
  if (!brain.trim()) warnings.push('masterPrompt is empty after stripping the output block.');
  if (!brief) warnings.push(`tile ${index} has no brief — the generator has nothing to differentiate it from the others.`);

  const analysisText = renderAnalysis(analysis);
  if (!analysisText) warnings.push(`tile ${index} was built with no product analysis.`);

  const prompt = [
    brain,
    '',
    singleTileOutputBlock(index, tileCount),
    '',
    '### PRODUCT ANALYSIS',
    '',
    'This is what the product is. The attached reference photographs are the authority on how it looks — where the two disagree, the photographs win.',
    '',
    analysisText || '(none supplied)',
    '',
    `### YOUR BRIEF — TILE ${index} OF ${tileCount}`,
    '',
    `Execute this brief. It was written as part of a coherent ${tileCount}-tile campaign; your job is this one tile, rendered at the highest possible level.`,
    '',
    renderBrief(brief) || '(none supplied)',
  ].join('\n');

  return { prompt, warnings };
}

module.exports = {
  OUTPUT_REQUIREMENT_HEADING,
  stripOutputRequirement,
  singleTileOutputBlock,
  renderAnalysis,
  renderBrief,
  buildSingleTilePrompt,
  directTileOutputBlock,
  buildDirectTilePrompt,
};
