const { callTextModel } = require('../core/textModel');

// ─── providers/anthropic.js ───────────────────────────────────────────────────
// Anthropic TEXT generation (Claude Opus 4.7) as a workflow step provider. Matches
// the engine adapter contract:
//   execute({ prompt, inputs, imageUrls, model, stepId, tileIndex })
//   -> { outputs:[{label,type:'text',text}], caption, model }
//
// For text steps. The analyzer + composer reach Claude through core/textModel
// directly, not this adapter.
async function execute({ prompt, inputs, imageUrls, model, stepId, tileIndex }) {
  console.log(`[anthropic] Text generation — step: ${stepId}${tileIndex !== undefined ? ` tile ${tileIndex}` : ''}`);

  const modelId = model || 'claude-opus-4-7';

  const refs = [];
  const addUrl = (v) => { if (!v) return; if (Array.isArray(v)) v.forEach(addUrl); else if (typeof v === 'string') refs.push(v); };
  addUrl(imageUrls);
  addUrl(inputs && inputs.referenceImage);

  const text = await callTextModel({
    modelId,
    promptText: prompt,
    imageUrls: refs,
    maxOutputTokens: 16384,
    temperature: 0.7,
  });

  if (!text) throw new Error('[anthropic] Empty text returned');

  return {
    outputs: [{ label: 'Text', type: 'text', text }],
    caption: text,
    model: modelId,
  };
}

module.exports = { execute };
