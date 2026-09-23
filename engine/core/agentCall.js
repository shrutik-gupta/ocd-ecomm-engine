const { callTextModel, DEFAULT_TEXT_MODEL } = require('./textModel');

// ─── core/agentCall.js ──────────────────────────────────────────── Phase 3 ───
// One uniform entry point for every TEXT agent in the v4 ecomm chain:
// Analyzer, Architect A, Architect B, Art Director, Copywriter, Prompt Writers.
//
// Wraps core/textModel the same way promptComposer does, adding:
//   • labeled attachment blocks — upstream agents' outputs, in chain order
//   • an optional user-text block (v4: only the Analyzer receives user text)
//   • optional JSON parsing with the balanced-brace recovery from productScan
//   • clean error surfaces — provider messages, never raw axios dumps
//
// callAgent({
//   label:            'architectA'          — log + error prefix (required)
//   prompt:           string                — full role + playbook prompt (required)
//   model:            'claude-opus-4-7' | 'gpt-5.4' | 'gemini-2.5-flash'
//   images:           [url, ...]            — product photos; EVERY v4 stage gets them
//   text:             string | null         — optional user-provided product notes
//   attachments:      [{ title, content }]  — upstream outputs, e.g.
//                                             { title: 'ANALYZER OUTPUT', content: '…' }
//   expectJson:       false (default)       — v4 agents are plain text; set true only
//                                             when a playbook explicitly demands JSON
//   maxOutputTokens:  16384 (default)       — Analyzer should pass 65536 like productScan
//   temperature:      0.7 (default)         — ignored by the Anthropic backend (textModel
//                                             never sends temperature to Claude), so
//                                             passing it is safe for every model.
//   cacheBasePrompt:  false (default)       — put `prompt`, plus any leading run of
//                                             attachments marked { cache: true },
//                                             behind an Anthropic cache breakpoint.
//                                             The bytes handed to the model are
//                                             unchanged; only the split is new.
//   prewarm:          false (default)       — write the cache entry and return ''
//                                             without generating. Fire this once
//                                             before a parallel fan-out over the
//                                             same prefix (see toolsRunner).
// }) → string (plain text)  |  object/array (when expectJson)
//
// Timeouts live in textModel (180s per backend call) — nothing extra needed here.
// ──────────────────────────────────────────────────────────────────────────────

const SEP = '════════════════════════════════════════';

// Returns { cachePrefix, promptText }. The split is purely a cache breakpoint:
//     cachePrefix + '\n' + promptText   ===   the single string this used to return
// so the model's input is byte-for-byte what it was before. cachePrefix is null
// unless cacheBasePrompt is set.
//
// Only a CONTIGUOUS LEADING run can be a prefix — caching is a prefix match, so an
// attachment marked { cache: true } that sits behind an uncached one cannot join it.
function buildPromptText({ prompt, attachments, text, cacheBasePrompt }) {
  const sections = [String(prompt || '').trim()];
  let prefixCount = cacheBasePrompt ? 1 : 0;

  for (const a of (attachments || [])) {
    if (!a || !a.content) continue;
    const title = String(a.title || 'ATTACHMENT').toUpperCase();
    sections.push(`\n${SEP}\n${title}\n${SEP}\n${String(a.content).trim()}`);
    // Extend the prefix only while it is still unbroken up to this section.
    if (a.cache && prefixCount === sections.length - 1) prefixCount = sections.length;
  }

  if (text && String(text).trim()) {
    sections.push(`\n${SEP}\nUSER-PROVIDED PRODUCT NOTES\n${SEP}\n${String(text).trim()}`);
  }

  if (!prefixCount) return { cachePrefix: null, promptText: sections.join('\n') };
  return {
    cachePrefix: sections.slice(0, prefixCount).join('\n'),
    promptText: sections.slice(prefixCount).join('\n'),
  };
}

// Strip a single wrapping code fence if the model added one. Deliberately does
// NOT strip surrounding quotes (unlike promptComposer) — the Copywriter's output
// may legitimately begin or end with quotation marks.
function stripFences(s) {
  return String(s || '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// Extract the first balanced {...} or [...] block — productScan's recovery,
// generalised to arrays. Returns null if no balanced block found.
function extractBalanced(str) {
  const openers = { '{': '}', '[': ']' };
  let start = -1, open = null;
  for (let i = 0; i < str.length; i++) {
    if (openers[str[i]]) { start = i; open = str[i]; break; }
  }
  if (start === -1) return null;
  const close = openers[open];
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

async function callAgent({
  label,
  prompt,
  model,
  images,
  text,
  attachments,
  expectJson = false,
  maxOutputTokens,
  temperature,
  cacheBasePrompt = false,
  prewarm = false,
}) {
  if (!label) throw new Error('[agentCall] label is required');
  if (!prompt || !String(prompt).trim()) throw new Error(`[${label}] prompt is required`);

  const modelId = (typeof model === 'string' && model.trim()) ? model.trim() : DEFAULT_TEXT_MODEL;
  const imageUrls = (images || []).filter(Boolean);
  const { cachePrefix, promptText } = buildPromptText({ prompt, attachments, text, cacheBasePrompt });
  const totalChars = cachePrefix
    ? (promptText ? cachePrefix.length + 1 + promptText.length : cachePrefix.length)
    : promptText.length;

  console.log(`[agentCall:${label}] model=${modelId} images=${imageUrls.length} attachments=${(attachments || []).length} promptChars=${totalChars} cachedPrefixChars=${cachePrefix ? cachePrefix.length : 0} expectJson=${expectJson}${prewarm ? ' [prewarm]' : ''}`);

  let raw;
  try {
    raw = await callTextModel({
      modelId,
      promptText,
      cachePrefix,
      imageUrls,
      maxOutputTokens: maxOutputTokens || 16384,
      temperature: temperature ?? 0.7,
      prewarm,
    });
  } catch (e) {
    // Surface the provider's own message — never the raw axios error object.
    const providerMsg =
      e.response?.data?.error?.message ||
      e.response?.data?.message ||
      e.message ||
      'unknown provider error';
    throw new Error(`[${label}] ${modelId} call failed: ${providerMsg}`);
  }
  if (prewarm) {
    console.log(`[agentCall:${label}] cache prefix warmed`);
    return '';
  }

  const cleaned = stripFences(raw);
  if (!cleaned) throw new Error(`[${label}] ${modelId} returned empty output`);

  if (!expectJson) {
    console.log(`[agentCall:${label}] done — ${cleaned.length} chars (plain text)`);
    return cleaned;
  }

  // JSON mode: direct parse → balanced-block recovery → clean failure.
  try {
    const parsed = JSON.parse(cleaned);
    console.log(`[agentCall:${label}] done — parsed JSON directly`);
    return parsed;
  } catch (directErr) {
    const block = extractBalanced(cleaned);
    if (block) {
      try {
        const parsed = JSON.parse(block);
        console.log(`[agentCall:${label}] done — recovered JSON via balanced-block extraction`);
        return parsed;
      } catch (_) { /* fall through to the clean error below */ }
    }
    throw new Error(`[${label}] expected JSON but could not parse output (${cleaned.length} chars): ${directErr.message}`);
  }
}

module.exports = { callAgent };
