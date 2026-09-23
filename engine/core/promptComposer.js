const { callTextModel, DEFAULT_TEXT_MODEL } = require('./textModel');

// Default composer instruction — used when a template doesn't supply its own.
// Tells the text LLM HOW to fuse the product analysis + master prompt into one
// finished image-generation prompt.
const DEFAULT_COMPOSER_INSTRUCTION = `You are an expert prompt engineer for an AI image generation model.

You are given:
1. A PRODUCT ANALYSIS (structured facts about the exact product in the user's uploaded image).
2. A CREATIVE BRIEF (the master prompt describing the desired shot, style, and constraints).

Write ONE single, detailed image-generation prompt that:
- Preserves the EXACT product identity from the analysis (shape, colour, material, branding, features). Never invent or alter product details.
- Faithfully applies the creative brief's style, composition, and constraints.
- Reads as a clean, coherent instruction to an image model.

Output ONLY the final prompt text. No preamble, no explanation, no markdown, no quotes.`;

// Build the user-content text block that carries the analysis + brief into the LLM.
function buildComposerInput(productContext, masterPrompt) {
  const analysisText = (productContext && typeof productContext === 'object')
    ? JSON.stringify(productContext, null, 2)
    : String(productContext || '{}');

  return `PRODUCT ANALYSIS:\n${analysisText}\n\nCREATIVE BRIEF (master prompt):\n${masterPrompt || '(none provided)'}`;
}

// Compose the final image-generation prompt via a TEXT LLM call.
// Returns the AI-written prompt string. Throws on failure — caller decides fallback.
// composerModel (optional): gemini-2.5-flash | gpt-5.4 | claude-opus-4-7.
async function composeFinalPrompt({ productContext, masterPrompt, composerInstruction, composerModel }) {
  const instruction = (typeof composerInstruction === 'string' && composerInstruction.trim())
    ? composerInstruction
    : DEFAULT_COMPOSER_INSTRUCTION;

  if (composerInstruction && instruction === composerInstruction) {
    console.log('[promptComposer] Using per-template composerInstruction');
  } else {
    console.log('[promptComposer] Using default composer instruction');
  }

  const modelId = (typeof composerModel === 'string' && composerModel.trim()) ? composerModel : DEFAULT_TEXT_MODEL;

  const userBlock = buildComposerInput(productContext, masterPrompt);
  // Single text turn: instruction + the analysis/brief block. No images for the composer.
  const promptText = `${instruction}\n\n${userBlock}`;

  const composed = await callTextModel({
    modelId,
    promptText,
    imageUrls: [],
    maxOutputTokens: 16384,
    temperature: 0.7,
  });

  if (!composed) {
    throw new Error('Composer returned empty text');
  }

  // Strip accidental code fences / surrounding quotes the model might add.
  const cleaned = composed
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  console.log(`[promptComposer] Composed final prompt (${cleaned.length} chars, model: ${modelId})`);
  return cleaned;
}

module.exports = { composeFinalPrompt, DEFAULT_COMPOSER_INSTRUCTION };
