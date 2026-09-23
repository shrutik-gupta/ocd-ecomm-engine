const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { uploadBufferToS3 } = require('../core/s3Uploader');
const OPENAI_IMAGE_MODEL_OVERRIDE = 'gpt-image-2';
const MAX_INPUT_EDGE = 1536;
const INPUT_JPEG_QUALITY = 90;
const OUTPUT_FORMAT = (() => {
  const v = String(process.env.OPENAI_IMAGE_OUTPUT_FORMAT || 'jpeg').toLowerCase();
  return ['jpeg', 'png', 'webp'].includes(v) ? v : 'jpeg';
})();
const OUTPUT_COMPRESSION = 90;
const SEND_INPUT_FIDELITY = process.env.OPENAI_IMAGE_INPUT_FIDELITY !== 'off';
const s3 = new S3Client({ region: process.env.AWS_REGION });
function resolveSize(aspectRatio, resolution) {
  const ar = String(aspectRatio || '1:1');
  const res = String(resolution || '1k').toLowerCase();
  const table = {
    '1:1':  { '1k': '1024x1024', '2k': '2048x2048', '4k': '3840x3840' },
    '9:16': { '1k': '1024x1792', '2k': '2048x3584', '4k': '2160x3840' },
    '16:9': { '1k': '1792x1024', '2k': '3584x2048', '4k': '3840x2160' },
    '2:3':  { '1k': '1024x1536', '2k': '2048x3072', '4k': '2560x3840' },
    '3:2':  { '1k': '1536x1024', '2k': '3072x2048', '4k': '3840x2560' },
    '4:5':  { '1k': '1024x1280', '2k': '2048x2560', '4k': '3072x3840' },
    '5:4':  { '1k': '1280x1024', '2k': '2560x2048', '4k': '3840x3072' },
    '3:4':  { '1k': '1024x1360', '2k': '2048x2720', '4k': '2880x3840' },
    '4:3':  { '1k': '1360x1024', '2k': '2720x2048', '4k': '3840x2880' },
  };
  const byRatio = table[ar] || table['1:1'];
  return byRatio[res] || byRatio['1k'] || '1024x1024';
}

// Normalize quality to OpenAI's accepted values. The Images API for the GPT image
// model accepts 'high' | 'medium' | 'low' (and 'auto'); pass through, default high.
function normalizeQuality(q) {
  const v = (q || 'medium').toLowerCase();
  return ['high', 'medium', 'low', 'auto'].includes(v) ? v : 'medium';
}
// Gather every image URL this call should attach, in a DETERMINISTIC order:
//   [ ...product images (front, back, ...), ...template reference creatives ]
// Order is the contract the prompt manifest describes, so it must not drift:
// references always come LAST, in slot order.
function collectRefs({ imageUrls, inputs }) {
  const product = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === 'string' && v.trim()) product.push(v.trim());
  };
  push(imageUrls);
  push(inputs && inputs.referenceImages);
  push(inputs && inputs.referenceImage);

  // Template reference creatives — up to 3 { url, role } pairs (role may be '').
  // New array key first; legacy single-string key as a fallback / dedupe.
  const templateRefs = [];
  const seenRef = new Set();
  const pushRef = (entry) => {
    if (!entry) return;
    const url = typeof entry === 'string' ? entry : entry.url;
    const role = (entry && typeof entry === 'object' && typeof entry.role === 'string') ? entry.role.trim() : '';
    const u = (typeof url === 'string') ? url.trim() : '';
    if (!u || seenRef.has(u)) return;
    seenRef.add(u);
    templateRefs.push({ url: u, role });
  };
  if (inputs && Array.isArray(inputs.templateRefImages)) inputs.templateRefImages.forEach(pushRef);
  pushRef(inputs && inputs.templateRefImage);

  // dedupe products, and never let a template ref double as a "product" slot
  const productRefs = [...new Set(product)].filter(u => !seenRef.has(u));
  const all = [...productRefs, ...templateRefs.map(r => r.url)];
  return { productRefs, templateRefs, all };
}

function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const sig = buf.slice(0, 4).toString('hex');
  if (sig.startsWith('ffd8ff')) return true;                       // jpeg
  if (sig === '89504e47') return true;                             // png
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return true;   // webp
  return false;
}

// Split an S3 https URL into { bucket, key }. Handles virtual-hosted
// (<bucket>.s3.<region>.amazonaws.com/<key>) and path-style
// (s3.<region>.amazonaws.com/<bucket>/<key>). Returns null for anything else.
function parseS3Url(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (!/\.amazonaws\.com$/i.test(u.hostname)) return null;

  const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (!path) return null;

  const hostParts = u.hostname.split('.');
  const s3Idx = hostParts.findIndex(p => p === 's3' || p.startsWith('s3-'));
  if (s3Idx === -1) return null;

  if (s3Idx === 0) {
    // path-style: the bucket is the first path segment
    const slash = path.indexOf('/');
    if (slash < 1) return null;
    return { bucket: path.slice(0, slash), key: path.slice(slash + 1) };
  }
  // virtual-hosted: everything before ".s3" is the bucket
  return { bucket: hostParts.slice(0, s3Idx).join('.'), key: path };
}

// Fetch an object with the instance role. Used when plain HTTPS is denied,
// which is the normal case for a stored (non-presigned) referenceImageUrl.
async function getFromS3(url) {
  const loc = parseS3Url(url);
  if (!loc) return null;
  const resp = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
  if (resp.Body && typeof resp.Body.transformToByteArray === 'function') {
    return Buffer.from(await resp.Body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Private S3 object URL (not presigned) → SDK first, HTTPS fallback.
// Presigned / public / external URLs → HTTPS first, SDK fallback.
// Then: validate → flatten on white → sRGB → cap long edge → JPEG.
async function fetchImagePart(url, index, label) {
  let raw = null;
  let via = '';
  let diag = '';
  const sdkFirst = !!parseS3Url(url) && !/X-Amz-Signature=/i.test(url);

  const tryHttps = async () => {
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true,
      });
      const buf = Buffer.from(resp.data);
      if (resp.status === 200 && looksLikeImage(buf)) {
        raw = buf;
        via = 'https';
      } else {
        diag += ` | http ${resp.status}: ${buf.slice(0, 160).toString('utf8').replace(/\s+/g, ' ')}`;
      }
    } catch (e) {
      diag += ` | http error: ${e.message}`;
    }
  };

  const trySdk = async () => {
    try {
      const buf = await getFromS3(url);
      if (buf && looksLikeImage(buf)) {
        raw = buf;
        via = 's3-sdk';
      } else if (buf) {
        diag += ' | s3sdk: object fetched but is not a png/jpg/webp';
      }
    } catch (e) {
      diag += ` | s3sdk: ${e.name || 'Error'}: ${e.message}`;
    }
  };

  const t0 = Date.now();
  if (sdkFirst) { await trySdk(); if (!raw) await tryHttps(); }
  else          { await tryHttps(); if (!raw) await trySdk(); }
  const fetchMs = Date.now() - t0;

  if (!raw) {
    throw new Error(
      `[openai_image] ${label} (image ${index + 1}) could not be fetched — ` +
      `url ${String(url).split('?')[0]}${diag}`
    );
  }

  let meta = {};
  try { meta = await sharp(raw).metadata(); } catch (_) { meta = {}; }

  const t1 = Date.now();
  const clean = await sharp(raw)
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .resize({
      width: MAX_INPUT_EDGE,
      height: MAX_INPUT_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: INPUT_JPEG_QUALITY, mozjpeg: false })
    .toBuffer();
  const encodeMs = Date.now() - t1;

  console.log(
    `[openai_image]   image ${index + 1} = ${label} — ` +
    `${meta.width || '?'}x${meta.height || '?'} src ${raw.length} bytes → ${clean.length} bytes jpeg — ` +
    `via ${via} (fetch ${fetchMs}ms, encode ${encodeMs}ms)${diag ? ` [fallback:${diag}]` : ''} — ` +
    `${String(url).split('?')[0]}`
  );
  return { buffer: clean, filename: `img_${index + 1}.jpg`, contentType: 'image/jpeg' };
}

function buildImageManifest(all, templateRefs, opts = {}) {
  if (opts.suppress) return '';
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  const rowCount = parseInt(opts.rowCount, 10) || 0;
  if (all.length < 2 && rowCount === 0) return '';
  const refByUrl = new Map(templateRefs.map((r, k) => [r.url, { url: r.url, role: r.role, ordinal: k + 1 }]));
  const multiRef = templateRefs.length > 1;
  const lines = all.map((url, i) => {
    const ref = refByUrl.get(url);
    if (ref) {
      const name = multiRef ? `REFERENCE CREATIVE ${ref.ordinal}` : 'REFERENCE CREATIVE';
      if (!multiRef && !ref.role) {
        // exact session-15 wording — keeps single-reference templates unchanged
        return `Image ${i + 1} = REFERENCE CREATIVE. This is the single source of truth for ` +
          `composition, layout, framing, camera angle and height, perspective, model pose and ` +
          `expression, prop/object placement, lighting direction, shadows, typography hierarchy ` +
          `and overall colour direction. Recreate it faithfully.`;
      }
      if (ref.role) {
        return `Image ${i + 1} = ${name} — role: ${ref.role}. This image is the source of truth ` +
          `for exactly that role and nothing else. Follow it faithfully for ${ref.role}, and ` +
          `ignore every other aspect of it. Never copy its product, packaging or branding.`;
      }
      return `Image ${i + 1} = ${name}. General style reference — follow it for composition, ` +
        `layout, lighting, typography hierarchy and colour direction wherever the other ` +
        `reference creatives' stated roles do not already apply. Never copy its product, ` +
        `packaging or branding.`;
    }
    if (rowCount > 0 && i < rowCount) {
      // These are DISTINCT products, not extra views of one. The brief refers to
      // this exact ordinal as [PRODUCT IMAGE n].
      return `Image ${i + 1} = PRODUCT IMAGE ${i + 1}. This is one of ${rowCount} SEPARATE ` +
        `products in this creative, and the brief refers to it as [PRODUCT IMAGE ${i + 1}]. ` +
        `It is the single source of truth for that product: packaging, silhouette, label ` +
        `artwork, logo, lettering, colours, material and finish. Reproduce it exactly. Any ` +
        `text the brief attaches to [PRODUCT IMAGE ${i + 1}] describes THIS image and no ` +
        `other. Never merge these products, never duplicate one to stand in for another, ` +
        `never treat them as different angles of a single item.`;
    }
    const which = i === 0 ? 'PRODUCT' : `PRODUCT (additional view ${i + 1})`;
    const named = labels[i] ? `${which} — ${labels[i]}` : which;
    return `Image ${i + 1} = ${named}. This is the single source of truth for the product ` +
      `itself: packaging, silhouette, label artwork, logo, lettering, colours, material and ` +
      `finish. Reproduce it exactly. Never redesign it, never re-letter it, never invent ` +
      `branding that is not visible on it.`;
  });

  const rowRule = rowCount > 0
    ? `PRODUCT COUNT RULE: exactly ${rowCount} distinct product${rowCount === 1 ? '' : 's'} ` +
      `must appear in the final image — one per PRODUCT IMAGE above. Count them before ` +
      `rendering. Never add, omit, merge or duplicate a product.`
    : '';
  // The brief's model spec must beat both the reference's person and the
  // product's implied audience — stated once whenever a reference is attached.
  const castingRule = templateRefs.length > 0
    ? `CASTING RULE: if the brief below specifies the human model's gender, ethnicity, age, ` +
      `or appearance, those specifications are ABSOLUTE — they override the person shown in ` +
      `any REFERENCE CREATIVE and anything implied by the product or its branding. From a ` +
      `reference, copy the person's pose, placement, framing, styling and expression — never ` +
      `their identity, face, gender, ethnicity or age. Never infer the model's demographics ` +
      `from the product, its packaging, or its target audience.`
    : '';

  let task = '';
  if (templateRefs.length === 1) {
    task = templateRefs[0].role
      ? `TASK: generate the scene described in the brief below. Apply the REFERENCE CREATIVE ` +
        `strictly for its stated role, and show the PRODUCT exactly as it appears in the ` +
        `PRODUCT image(s), adapting copy and palette to that product.`
      : `TASK: rebuild the scene shown in the REFERENCE CREATIVE, replacing its product with the PRODUCT image, and adapting copy and palette to that product.`;
  } else if (multiRef) {
    task = `TASK: generate the scene described in the brief below, combining the REFERENCE ` +
      `CREATIVE images strictly according to their stated roles. The PRODUCT image(s) alone ` +
      `define the product — show it exactly as supplied, adapting copy and palette to it.`;
  }
  return [
    `ATTACHED IMAGES (in the order supplied):`,
    ...lines,
    rowRule,
    castingRule,
    task,
    '',
    '------------------------------------------------',
    '',
  ].filter(Boolean).join('\n');
}

function detectOutputType(buf) {
  const hex = buf.slice(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return { ext: 'webp', contentType: 'image/webp' };
  return { ext: 'png', contentType: 'image/png' };
}

async function execute({ prompt, inputs, imageUrls, model, quality, resolution, userInputs, stepId, tileIndex }) {
  const tStart = Date.now();
  console.log(`[openai_image] Starting generation — step: ${stepId}${tileIndex !== undefined ? ` tile ${tileIndex}` : ''}`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('[openai_image] OPENAI_API_KEY not set');

  const modelId = OPENAI_IMAGE_MODEL_OVERRIDE || model || 'gpt-image-2';
  const qualityVal = normalizeQuality(quality);

  const aspectRatio =
    (inputs && (inputs.aspectRatio || inputs.aspect_ratio)) ||
    (userInputs && (userInputs.aspectRatio || userInputs.aspect_ratio)) ||
    '1:1';
  const resolutionVal =
    resolution ||
    (inputs && inputs.resolution) ||
    (userInputs && userInputs.resolution) ||
    '1k';
  const size = resolveSize(aspectRatio, resolutionVal);

  console.log(`[openai_image] model: ${modelId}, quality: ${qualityVal}, aspectRatio: ${aspectRatio}, resolution: ${resolutionVal}, size: ${size}`);

  // ── Collect + attach reference images ───────────────────────────────────────
  // /generations does not accept input images; when any exist we use
  // /images/edits (multipart) instead.
  const { productRefs, templateRefs, all: uniqueRefs } = collectRefs({ imageUrls, inputs });

  let response;
  let finalPrompt = prompt;

  if (uniqueRefs.length > 0) {
    console.log(
      `[openai_image] ${uniqueRefs.length} reference image(s) → using /images/edits ` +
      `(${productRefs.length} product + ${templateRefs.length} templateRefImage(s))`
    );
    if (templateRefs.length === 0) {
      console.log('[openai_image] NOTE: no inputs.templateRefImage(s) on this step — if this template has Section-3.5 reference creatives, they are NOT being sent.');
    }

    const customLabels = (inputs && Array.isArray(inputs.imageLabels)) ? inputs.imageLabels : null;
    const labelFor = (url) => {
      if (customLabels) {
        const i = uniqueRefs.indexOf(url);
        if (i !== -1 && customLabels[i]) return String(customLabels[i]);
      }
      const k = templateRefs.findIndex(r => r.url === url);
      if (k === -1) {
        const rc = parseInt(inputs && inputs.productRowCount, 10) || 0;
        const i = uniqueRefs.indexOf(url);
        return (rc > 0 && i > -1 && i < rc) ? `PRODUCT IMAGE ${i + 1}` : 'PRODUCT';
      }
      return templateRefs.length > 1 ? `REFERENCE CREATIVE ${k + 1}` : 'REFERENCE CREATIVE';
    };
    // Fetch sequentially so the per-image log lines stay in attachment order.
    const tFetch = Date.now();
    const parts = [];
    for (let i = 0; i < uniqueRefs.length; i++) {
      parts.push(await fetchImagePart(uniqueRefs[i], i, labelFor(uniqueRefs[i])));
    }
    console.log(`[timing] ${stepId} t${tileIndex} inputs ready ${Date.now() - tFetch}ms`);
    const manifest = buildImageManifest(uniqueRefs, templateRefs, {
      suppress: !!(inputs && inputs.suppressManifest),
      rowCount: (inputs && inputs.productRowCount) || 0,
      labels: (inputs && Array.isArray(inputs.imageLabels)) ? inputs.imageLabels : null,
    });
    finalPrompt = manifest ? `${manifest}${prompt}` : prompt;

    const totalBytes = parts.reduce((n, p) => n + p.buffer.length, 0);
    console.log(`[openai_image] multipart payload: ${parts.length} image(s), ${totalBytes} bytes, prompt ${finalPrompt.length} chars`);

    // form-data streams cannot be safely replayed, so rebuild per attempt.
    const buildForm = (withFidelity, withFormat) => {
      const form = new FormData();
      form.append('model', modelId);
      form.append('prompt', finalPrompt);
      form.append('quality', qualityVal);
      form.append('size', size);
      if (withFidelity) form.append('input_fidelity', 'high');
      if (withFormat) {
        form.append('output_format', OUTPUT_FORMAT);
        form.append('output_compression', String(OUTPUT_COMPRESSION));
      }
      for (const p of parts) {
        form.append('image[]', p.buffer, { filename: p.filename, contentType: p.contentType });
      }
      return form;
    };
    const doPost = (form) => axios.post('https://api.openai.com/v1/images/edits', form, {
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const fail = (e) => {
      console.error('[openai_image] edits ERROR BODY:', JSON.stringify(e.response?.data));
      console.error(`[openai_image] sent: model=${modelId} quality=${qualityVal} size=${size} refs=${uniqueRefs.length} fidelity=${sendFidelity} format=${sendFormat ? OUTPUT_FORMAT : 'png'}`);
      throw new Error('[openai_image] OpenAI ' + (e.response?.status || '') + ': ' + JSON.stringify(e.response?.data?.error?.message || e.response?.data));
    };
    let sendFidelity = SEND_INPUT_FIDELITY;
    let sendFormat = OUTPUT_FORMAT !== 'png';
    const tApi = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await doPost(buildForm(sendFidelity, sendFormat));
        break;
      } catch (e) {
        const body = JSON.stringify(e.response?.data || '');
        if (sendFidelity && /input_fidelity/i.test(body)) {
          console.warn('[openai_image] input_fidelity rejected by the API — retrying without it');
          sendFidelity = false;
          continue;
        }
        if (sendFormat && /output_format|output_compression/i.test(body)) {
          console.warn('[openai_image] output_format rejected by the API — retrying with default (png) output');
          sendFormat = false;
          continue;
        }
        fail(e);
      }
    }
    console.log(`[openai_image] [timing] edits call ${((Date.now() - tApi) / 1000).toFixed(1)}s (format=${sendFormat ? OUTPUT_FORMAT : 'png'})`);
  } else {
    // ── Plain generation (no references) ──────────────────────────────────────
    console.log('[openai_image] 0 reference image(s) → using /images/generations');
    const genBody = (withFormat) => ({
      model: modelId, prompt: finalPrompt, quality: qualityVal, size, n: 1,
      ...(withFormat ? { output_format: OUTPUT_FORMAT, output_compression: OUTPUT_COMPRESSION } : {}),
    });
    const postGen = (withFormat) => axios.post(
      'https://api.openai.com/v1/images/generations',
      genBody(withFormat),
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 300000,
      }
    );
    const genFail = (e) => {
      console.error('[openai_image] gen ERROR BODY:', JSON.stringify(e.response?.data));
      console.error(`[openai_image] sent: model=${modelId} quality=${qualityVal} size=${size}`);
      throw new Error('[openai_image] OpenAI ' + (e.response?.status || '') + ': ' + JSON.stringify(e.response?.data?.error?.message || e.response?.data));
    };

    const tApi = Date.now();
    const withFormat = OUTPUT_FORMAT !== 'png';
    try {
      response = await postGen(withFormat);
    } catch (e) {
      const body = JSON.stringify(e.response?.data || '');
      if (withFormat && /output_format|output_compression/i.test(body)) {
        console.warn('[openai_image] output_format rejected by the API — retrying with default (png) output');
        try { response = await postGen(false); } catch (e2) { genFail(e2); }
      } else {
        genFail(e);
      }
    }
    console.log(`[openai_image] [timing] generations call ${((Date.now() - tApi) / 1000).toFixed(1)}s`);
  }

  // GPT image models return base64 (b64_json). Some configs return a url; handle both.
  const dataArr = response.data?.data || [];
  if (!dataArr.length) throw new Error('[openai_image] No image data in response');

  // image_tokens in this line is the regression test for multi-image: ~544 for a
  // single attached image, roughly N x that for N images. If it does not move
  // after wiring reference images, they are NOT being attached.
  console.log(
    '[openai_image] usage:', JSON.stringify(response.data?.usage),
    'quality_sent:', qualityVal,
    'size_sent:', size,
    'images_sent:', uniqueRefs.length,
    'templateRef_sent:', templateRefs.length > 0,
    'templateRefs_sent:', templateRefs.length
  );

  const outputs = [];
  for (let i = 0; i < dataArr.length; i++) {
    const item = dataArr[i];
    let buffer;
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const imgResp = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
      buffer = Buffer.from(imgResp.data);
    } else {
      throw new Error(`[openai_image] Image ${i + 1} had neither b64_json nor url`);
    }
    if (!buffer || buffer.length < 100) throw new Error(`[openai_image] Image ${i + 1} empty`);

    const tileTag = tileIndex !== undefined ? `t${tileIndex}_` : '';
    const { ext, contentType } = detectOutputType(buffer);
    const s3Key = `ai-outputs/${stepId}_${tileTag}${i}_${Date.now()}.${ext}`;
    const tUp = Date.now();
    const url = await uploadBufferToS3(buffer, s3Key, contentType);
    console.log(`[timing] ${stepId} t${tileIndex} s3 upload ${Date.now() - tUp}ms (${buffer.length} bytes)`);
    outputs.push({ label: `Image ${i + 1}`, type: 'image', url });
    console.log(`[openai_image] Uploaded output ${i + 1}: ${url}`);
  }
  console.log(`[timing] ${stepId} t${tileIndex} TILE TOTAL ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
  return {
    outputs,
    caption: '',
    model: modelId,
  };
}

module.exports = { execute };
