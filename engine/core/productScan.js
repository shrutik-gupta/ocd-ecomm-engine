const { callTextModel, DEFAULT_TEXT_MODEL } = require('./textModel');

const PRODUCT_SCAN_PROMPT = `You are a product analyst. Analyse the product image(s) and return a JSON object with exactly these fields:

{
  "category": "the product type e.g. handbag, lipstick, shampoo bottle, sneaker",
  "material": "primary material e.g. tan leather, plastic, fabric",
  "color": "full color description e.g. warm brown with gold accents",
  "heroFeature": "the single most distinctive visual feature e.g. structured gold buckle hardware",
  "shape": "shape description e.g. structured tote, cylindrical bottle, low-top sneaker",
  "audience": "target audience e.g. women 25-40, men 18-30, unisex",
  "mood": "brand mood e.g. premium aspirational, playful youthful, minimal clean",
  "packagingVisible": true or false
}

If multiple images are provided (e.g. front and back of the same product), use all of them together to describe the single product. Return ONLY the JSON object. No explanation, no markdown, no code blocks. Just the raw JSON.`;

// Accepts a single URL (back-compat) or an array of URLs (front, back, ...).
// 2nd arg (optional): a per-template scan prompt. Falls back to the hardcoded
//   PRODUCT_SCAN_PROMPT when not provided, so existing templates are unaffected.
// 3rd arg (optional): the per-template scan model id (gemini-2.5-flash | gpt-5.4 |
//   claude-opus-4-7). Falls back to the default text model when not provided.
async function productScan(imageInput, scanPromptOverride, scanModel) {
  const imageUrls = Array.isArray(imageInput)
    ? imageInput.filter(Boolean)
    : (imageInput ? [imageInput] : []);

  const scanPrompt = (typeof scanPromptOverride === 'string' && scanPromptOverride.trim())
    ? scanPromptOverride
    : PRODUCT_SCAN_PROMPT;

  if (scanPromptOverride && scanPrompt === scanPromptOverride) {
    console.log('[productScan] Using per-template scanPrompt override');
  } else {
    console.log('[productScan] Using default hardcoded scan prompt');
  }

  const modelId = (typeof scanModel === 'string' && scanModel.trim()) ? scanModel : DEFAULT_TEXT_MODEL;

  try {
    // Single vision text call via the shared router (Gemini / OpenAI / Anthropic).
    // maxOutputTokens kept high: large schema scans (100+ field profiles) produce
    // very long JSON and must not truncate mid-object (that would fail JSON.parse
    // and drop into the fallback). temperature low for stable structured output.
    const responseText = await callTextModel({
      modelId,
      promptText: scanPrompt,
      imageUrls,
      maxOutputTokens: 65536,
      temperature: 0.4,
    });

    const cleaned = (responseText || '')
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let productContext;
    try {
      productContext = JSON.parse(cleaned);
    } catch (parseErr) {
      // GPT sometimes appends text after the JSON, or wraps it. Extract the first
      // balanced {...} object and parse that instead of the whole blob.
      console.error('[productScan] direct parse failed:', parseErr.message);
      console.error('[productScan] tail near 17200:', JSON.stringify(cleaned.slice(17150, 17320)));
      const start = cleaned.indexOf('{');
      let depth = 0, end = -1;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (start === -1 || end === -1) throw parseErr;
      productContext = JSON.parse(cleaned.slice(start, end + 1));
      console.log('[productScan] recovered via balanced-brace extraction');
    }

    // Only backfill the small default-schema fields when the result actually looks
    // like that small schema. Large custom schemas (nested Product Intelligence
    // profiles) are returned as-is and must NOT be polluted with flat defaults.
    const looksLikeDefaultSchema = ['category', 'material', 'color', 'heroFeature']
      .some(f => f in productContext);
    if (looksLikeDefaultSchema) {
      const requiredFields = ['category', 'material', 'color', 'heroFeature', 'shape', 'audience', 'mood', 'packagingVisible'];
      const missing = requiredFields.filter(f => !(f in productContext));
      if (missing.length > 0) {
        console.warn(`[productScan] Missing default-schema fields: ${missing.join(', ')} — filling defaults`);
        missing.forEach(f => { productContext[f] = f === 'packagingVisible' ? false : 'unknown'; });
      }
    } else {
      console.log('[productScan] Custom schema detected — returning as-is (no default backfill)');
    }

    const fieldCount = Object.keys(productContext).length;
    console.log(`[productScan] Success — ${fieldCount} top-level field(s), model: ${modelId}`);
    return productContext;

  } catch (err) {
    // Scan FAILED. Return the fallback BUT tag it so downstream (composer / UI) can
    // detect the failure instead of silently treating garbage as a real analysis.
    console.error('[productScan] Error:', err.message, '— returning tagged fallback (_scanFailed)');
    return {
      category: 'product', material: 'unknown', color: 'unknown', heroFeature: 'unknown',
      shape: 'unknown', audience: 'general', mood: 'professional', packagingVisible: false,
      _scanFailed: true, _scanError: err.message
    };
  }
}

module.exports = { productScan };
