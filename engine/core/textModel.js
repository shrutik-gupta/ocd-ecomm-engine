const axios = require('axios');

// ─── core/textModel.js ────────────────────────────────────────────────────────
// Single dispatch point for TEXT/vision LLM calls used by the analyzer (productScan)
// and the prompt composer (promptComposer). Both of those modules used to hardcode
// gemini-2.5-flash; now they pass a modelId and this router picks the backend.
//
// Supported model ids (keep in sync with the workbook TEXT_MODELS list):
//   gemini-2.5-flash      -> Google Generative Language REST  (GEMINI_API_KEY)
//   claude-opus-4-7       -> Anthropic Messages API           (ANTHROPIC_API_KEY)
//   gpt-5.4               -> OpenAI Chat Completions API       (OPENAI_API_KEY)
//
// Returns a plain string (the model's text output). Throws on failure — callers
// decide their own fallback (scan returns a tagged fallback; composer rethrows).
//
// NOTE on model ids: these are the literal strings the workbook emits. If a provider
// rejects one as "model not found", it is almost certainly a listed-≠-callable case
// (same lesson as Gemini/Seedance) — fix the id here in MODEL_ROUTING, not upstream.

// Map a workbook modelId to { backend, apiModelId }. apiModelId is the literal string
// sent to the provider — override here if the provider's callable id differs from the
// workbook id.
const MODEL_ROUTING = {
  'gemini-2.5-flash': { backend: 'gemini',    apiModelId: 'gemini-2.5-flash' },
  'claude-opus-4-7':  { backend: 'anthropic', apiModelId: 'claude-opus-4-7' },
  'gpt-5.4':          { backend: 'openai',    apiModelId: 'gpt-5.4' },
  'gpt-5.4-2026-03-05': { backend: 'openai',    apiModelId: 'gpt-5.4-2026-03-05' },
};

const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';

function resolveRouting(modelId) {
  return MODEL_ROUTING[modelId] || MODEL_ROUTING[DEFAULT_TEXT_MODEL];
}

// Download an image URL → { mimeType, base64 }. Shared by the vision-capable backends.
async function fetchImageAsBase64(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const base64 = Buffer.from(resp.data).toString('base64');
  const mimeType = (resp.headers['content-type'] || 'image/jpeg').split(';')[0];
  return { mimeType, base64 };
}

// ── Gemini (Google Generative Language REST) ──────────────────────────────────
async function callGemini({ apiModelId, promptText, imageUrls, maxOutputTokens, temperature }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const parts = [{ text: promptText }];
  for (const url of (imageUrls || [])) {
    const { mimeType, base64 } = await fetchImageAsBase64(url);
    parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${apiModelId}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxOutputTokens || 16384, temperature: temperature ?? 0.5 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
  );

  const candidate = response.data?.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('text output truncated (finishReason MAX_TOKENS) — raise maxOutputTokens or shorten the input');
  }
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('').trim();
  return text;
}

// ── OpenAI (Chat Completions) ─────────────────────────────────────────────────
async function callOpenAI({ apiModelId, promptText, imageUrls, maxOutputTokens, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  // Vision via image_url with public (presigned) URLs — same approach as the image
  // adapters; OpenAI fetches the URL itself, so no base64 download needed.
  const content = [{ type: 'text', text: promptText }];
  for (const url of (imageUrls || [])) {
    content.push({ type: 'image_url', image_url: { url } });
  }

  let response;
  try {
    response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: apiModelId,
        messages: [{ role: 'user', content }],
        max_completion_tokens: maxOutputTokens || 16384,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 180000,
      }
    );
  } catch (e) {
    console.error('[textModel/openai] BODY:', JSON.stringify(e.response?.data));
    console.error('[textModel/openai] sent: model=' + apiModelId + ' max_tokens=' + (maxOutputTokens || 16384) + ' temp=' + (temperature ?? 0.5) + ' content_blocks=' + content.length + ' image_blocks=' + content.filter(c => c.type === 'image_url').length);
    throw e;
  }

  const choice = response.data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('text output truncated (finish_reason length) — raise max_tokens or shorten the input');
  }
  return (choice?.message?.content || '').trim();
}

// ── Anthropic (Messages API) ──────────────────────────────────────────────────
async function callAnthropic({ apiModelId, promptText, imageUrls, maxOutputTokens, temperature }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
const ANTHROPIC_MAX_OUTPUT = 8192;

  // Anthropic images are base64 blocks (no URL fetch), so download each first.
  const content = [];
  for (const url of (imageUrls || [])) {
    const { mimeType, base64 } = await fetchImageAsBase64(url);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: base64 },
    });
  }
  content.push({ type: 'text', text: promptText });

  let response;
  try {
    response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: apiModelId,
        max_tokens: maxOutputTokens || 16384,
        messages: [{ role: 'user', content }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 180000,
      }
    );
  } catch (e) {
    console.error('[textModel/anthropic] 400 BODY:', JSON.stringify(e.response?.data));
    console.error('[textModel/anthropic] sent: model=' + apiModelId + ' max_tokens=' + (maxOutputTokens || 16384) + ' content_blocks=' + content.length + ' image_blocks=' + content.filter(c => c.type === 'image').length);
    throw e;
  }

  if (response.data?.stop_reason === 'max_tokens') {
    throw new Error('text output truncated (stop_reason max_tokens) — raise max_tokens or shorten the input');
  }
  // content is an array of blocks; concatenate the text blocks.
  const blocks = response.data?.content || [];
  return blocks.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

// Public entry point. promptText is the full single-turn text (instruction + body).
// imageUrls is an optional array (used by the analyzer; the composer passes none).
async function callTextModel({ modelId, promptText, imageUrls, maxOutputTokens, temperature }) {
  const { backend, apiModelId } = resolveRouting(modelId);
  console.log(`[textModel] modelId=${modelId || DEFAULT_TEXT_MODEL} → backend=${backend} (${apiModelId})${(imageUrls && imageUrls.length) ? `, ${imageUrls.length} image(s)` : ''}`);

  const args = { apiModelId, promptText, imageUrls, maxOutputTokens, temperature };
  if (backend === 'openai')    return callOpenAI(args);
  if (backend === 'anthropic') return callAnthropic(args);
  return callGemini(args);
}

module.exports = { callTextModel, MODEL_ROUTING, DEFAULT_TEXT_MODEL };
