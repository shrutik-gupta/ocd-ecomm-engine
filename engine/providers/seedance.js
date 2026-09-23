// ============================================================================
// seedance.js — Dreamina Seedance 2.0 (BytePlus ModelArk) video adapter
//
// ASYNC flow: create task -> poll retrieve -> download video -> re-upload to S3.
// Same ARK_API_KEY and same base URL as the working /api/seedream/generate
// route in app.js. Supports BOTH text-to-video and image-to-video (image
// optional) per the agreed design.
//
// RETURN SHAPE: { outputs: [{label, type:"video", url}], caption, model }
//   — this matches what stepExecutor/assembleFinalOutputs/frontend expect
//   (the same shape nanabanana.js returns). NOTE: the old seedream.js adapter
//   returned a bare string — that is WRONG for this engine. Do not copy it.
//
// ── TWO VALUES YOU MUST CONFIRM FROM YOUR MODELARK CONSOLE ──────────────────
//   1. SEEDANCE_MODEL_ID  — the exact API model-id string for Dreamina
//      Seedance 2.0 (NOT the console display name). Check: Console ->
//      Model activation, or API Explorer. The model row passed from the
//      workbook (step.model) OVERRIDES this default when set, so once you
//      seed AIProviders with the right modelId you may never touch this.
//   2. The create-task BODY SHAPE below (content array). It matches ModelArk's
//      documented video API (text part + optional image_url part). If your
//      API Explorer shows a different field, change it in ONE place: buildContent().
//
// Because both are uncertain, this adapter LOGS the full request body and the
// full error response on failure — so the very first Run Step tells you
// immediately if the model id or body shape is wrong, instead of failing
// silently. (This is the nanobanana lesson applied.)
// ============================================================================

const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const ARK_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';

// ── CONFIRM #1: default model id (overridden by step.model from the workbook) ─
const SEEDANCE_MODEL_ID_DEFAULT = 'dreamina-seedance-2-0-260128';

// ModelArk video task endpoints (standard ModelArk async video shape)
const CREATE_TASK_URL   = `${ARK_BASE_URL}/contents/generations/tasks`;
const RETRIEVE_TASK_URL = (taskId) => `${ARK_BASE_URL}/contents/generations/tasks/${taskId}`;

// Polling — video gen is slow. 5s interval, up to ~6 min.
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS        = 72; // 72 * 5s = 360s

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── CONFIRM #2: build the create-task content array ──────────────────────────
// text part always; one image_url part per reference image (image optional).
// inputs.imageUrls is the engine's array of S3 URLs (front, back, ...).
function buildContent(prompt, imageUrls) {
  const content = [{ type: 'text', text: prompt || '' }];
  for (const url of imageUrls) {
    content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  }
  return content;
}

// Collect + dedupe reference image URLs from the various shapes the engine uses
function collectImageUrls(inputs) {
  const set = new Set();
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach((u) => typeof u === 'string' && u.startsWith('http') && set.add(u));
    else if (typeof v === 'string' && v.startsWith('http')) set.add(v);
  };
  push(inputs.imageUrls);
  push(inputs.referenceImages);
  push(inputs.referenceImage);
  return [...set];
}

async function execute({ prompt, inputs = {}, model, stepId, tileIndex }) {
  const tag = `[seedance]${tileIndex != null ? ` tile ${tileIndex}` : ''}`;
  const modelId = model || SEEDANCE_MODEL_ID_DEFAULT;

  if (!process.env.ARK_API_KEY) throw new Error(`${tag} ARK_API_KEY not set`);

  const imageUrls = collectImageUrls(inputs);
  const content = buildContent(prompt, imageUrls);

  const requestBody = {
    model: modelId,
    content,
    // pass through optional knobs only when present (avoids sending nulls)
    ...(inputs.aspectRatio ? { ratio: inputs.aspectRatio } : {}),
    ...(inputs.duration ? { duration: Number(inputs.duration) } : {}),
    ...(inputs.resolution ? { resolution: inputs.resolution } : {}),
  };

  const headers = {
    Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    'Content-Type': 'application/json',
  };

  console.log(`${tag} create task — model: ${modelId}, images: ${imageUrls.length}, prompt: ${(prompt || '').slice(0, 100)}`);
  console.log(`${tag} request body:`, JSON.stringify(requestBody).slice(0, 600));

  // 1) Create the task
  let taskId;
  try {
    const createRes = await axios.post(CREATE_TASK_URL, requestBody, { headers, timeout: 60000 });
    taskId = createRes.data?.id || createRes.data?.task_id || createRes.data?.data?.id;
    if (!taskId) {
      console.error(`${tag} create response had no task id:`, JSON.stringify(createRes.data).slice(0, 600));
      throw new Error('No task id in create response');
    }
    console.log(`${tag} task created: ${taskId}`);
  } catch (err) {
    console.error(`${tag} CREATE failed:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
    throw new Error(`seedance create-task failed: ${err.response?.data?.error?.message || err.response?.data?.message || err.message}`);
  }

  // 2) Poll until the task finishes
  let videoUrl = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let data;
    try {
      const res = await axios.get(RETRIEVE_TASK_URL(taskId), { headers, timeout: 30000 });
      data = res.data || {};
    } catch (err) {
      console.error(`${tag} poll ${i + 1} error:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
      continue; // transient — keep polling
    }

    const status = data.status || data.task_status; // tolerate both field names
    if (i % 4 === 0) console.log(`${tag} poll ${i + 1}/${MAX_POLLS} — status: ${status}`);

    if (status === 'succeeded' || status === 'succeed' || status === 'success') {
      // The finished video URL lives in content.video_url on ModelArk video tasks.
      // Fall back across the shapes seen in their docs.
      videoUrl =
        data.content?.video_url ||
        data.content?.[0]?.video_url ||
        data.video_url ||
        data.result?.video_url ||
        data.task_result?.videos?.[0]?.url ||
        null;
      if (!videoUrl) {
        console.error(`${tag} succeeded but no video url found:`, JSON.stringify(data).slice(0, 800));
        throw new Error('seedance task succeeded but no video url in response');
      }
      console.log(`${tag} succeeded — provider video url obtained`);
      break;
    }
    if (status === 'failed' || status === 'fail' || status === 'error') {
      console.error(`${tag} task failed:`, JSON.stringify(data).slice(0, 800));
      throw new Error(`seedance task failed: ${data.error?.message || data.failure_reason || 'unknown'}`);
    }
    // otherwise: queued / running / processing — keep polling
  }

  if (!videoUrl) throw new Error(`seedance task timed out after ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`);

  // 3) Download the provider video (provider URLs expire) and re-upload to S3
  console.log(`${tag} downloading provider video`);
  const videoResp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
  const videoBuffer = Buffer.from(videoResp.data);
  const contentType = (videoResp.headers['content-type'] || 'video/mp4').split(';')[0];

  const idx = tileIndex != null ? `_${tileIndex}` : '';
  const s3Key = `ai-outputs/${stepId || 'seedance'}${idx}_${Date.now()}_seedance.mp4`;
  const s3Url = await uploadBufferToS3(videoBuffer, s3Key, contentType);
  console.log(`${tag} uploaded to S3: ${s3Url}`);

  // 4) Return the engine-standard shape
  return {
    outputs: [{ label: 'Product Video', type: 'video', url: s3Url }],
    caption: '',
    model: modelId,
  };
}

module.exports = { execute };
