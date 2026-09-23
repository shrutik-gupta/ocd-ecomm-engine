const { callTextModel } = require('../core/textModel');

// ─── providers/openai.js ──────────────────────────────────────────────────────
// OpenAI TEXT generation (GPT 5.4) as a workflow step provider. Matches the engine
// adapter contract:
//   execute({ prompt, inputs, imageUrls, model, stepId, tileIndex })
//   -> { outputs:[{label,type:'text',text}], caption, model }
//
// This is for text steps (e.g. generating copy/captions inside a workflow). The
// analyzer + composer reach GPT through core/textModel directly, not this adapter.
async function execute({ prompt, inputs, imageUrls, model, stepId, tileIndex }) {
  console.log(`[openai] Text generation — step: ${stepId}${tileIndex !== undefined ? ` tile ${tileIndex}` : ''}`);

  const modelId = model || 'gpt-5.4';

  // Optionally pass reference images if the step provided any (GPT is vision-capable).
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

  if (!text) throw new Error('[openai] Empty text returned');

  return {
    outputs: [{ label: 'Text', type: 'text', text }],
    caption: text,
    model: modelId,
  };
}

module.exports = { execute };
