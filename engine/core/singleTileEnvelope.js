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
function stripOutputRequirement(masterPrompt) {
  const src = String(masterPrompt || '');
  const idx = src.indexOf(OUTPUT_REQUIREMENT_HEADING);
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
};
