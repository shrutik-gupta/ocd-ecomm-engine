const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

function collectImageUrls({ imageUrls, inputs }) {
  const urls = [];
  const add = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'string') urls.push(v);
  };
  add(imageUrls);
  add(inputs && inputs.referenceImages);
  add(inputs && inputs.referenceImage);
  return [...new Set(urls.filter(Boolean))];
}

async function execute({ prompt, inputs, imageUrls, model, stepId, tileIndex }) {
  console.log(`[nanabanana] Starting generation — step: ${stepId}${tileIndex !== undefined ? ` tile ${tileIndex}` : ''}`);

  const modelId = model || 'gemini-2.5-flash-image';
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('[nanabanana] GEMINI_API_KEY not set');

  const refUrls = collectImageUrls({ imageUrls, inputs });
  console.log(`[nanabanana] ${refUrls.length} reference image(s)`);

  const parts = [];

  // Pass reference images as image_url (URL fetched by Google, not downloaded here).
  // Keeps request bodies tiny — avoids 429s from large inline_data on parallel runs.
  // Presigned S3 GET URLs are publicly readable for 1h so this works fine.
 for (const url of refUrls) {
    console.log(`[nanabanana] Downloading reference image: ${url.slice(0, 80)}...`);
    const imgResponse = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const base64 = Buffer.from(imgResponse.data).toString('base64');
    const mimeType = (imgResponse.headers['content-type'] || 'image/jpeg').split(';')[0];
    parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }

  // Stagger parallel tile requests to avoid hitting Gemini concurrency limits.
  // tileIndex is 0-based; each tile waits tileIndex * 3s before calling the API.
  parts.push({ text: prompt });

  const aspectRatio = inputs.aspectRatio || inputs.aspect_ratio || '1:1';
  const generationConfig = {
    responseModalities: ['IMAGE', 'TEXT'],
    imageConfig: { aspectRatio }
  };
  console.log(`[nanabanana] aspectRatio: ${aspectRatio}`);

  console.log(`[nanabanana] Calling REST API — model: ${modelId}`);
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    { contents: [{ parts }], generationConfig },
    { headers: { 'Content-Type': 'application/json' }, timeout: 300000 }
  );

  const candidates = response.data?.candidates || [];
  if (!candidates.length) throw new Error('[nanabanana] No candidates returned');

  const outParts = candidates[0]?.content?.parts || [];
  const imageParts = outParts.filter(p => p.inlineData);
  const textParts = outParts.filter(p => p.text);

  console.log(`[nanabanana] Got ${imageParts.length} image(s), finishReason: ${candidates[0]?.finishReason}`);

  if (!imageParts.length) {
    const reason = candidates[0]?.finishReason || 'unknown';
    throw new Error(`[nanabanana] No images returned. finishReason: ${reason}`);
  }

  const outputs = [];
  for (let i = 0; i < imageParts.length; i++) {
    const { data: b64, mimeType } = imageParts[i].inlineData;
    if (!b64 || b64.length < 100) throw new Error(`[nanabanana] Image ${i + 1} empty`);
    const ext = (mimeType || 'image/png').includes('png') ? 'png' : 'jpeg';
    const buffer = Buffer.from(b64, 'base64');
    const tileTag = tileIndex !== undefined ? `t${tileIndex}_` : '';
    const s3Key = `ai-outputs/${stepId}_${tileTag}${i}_${Date.now()}.${ext}`;
    const url = await uploadBufferToS3(buffer, s3Key, mimeType || 'image/png');
    outputs.push({ label: `Image ${i + 1}`, type: 'image', url });
    console.log(`[nanabanana] Uploaded output ${i + 1}: ${url}`);
  }

  return {
    outputs,
    caption: textParts[0]?.text || '',
    model: modelId
  };
}

module.exports = { execute };
