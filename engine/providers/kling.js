const axios = require('axios');
const jwt = require('jsonwebtoken');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const KLING_BASE_URL = 'https://api.klingai.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 72; // 6 minutes max

// Generate Kling JWT token
function generateKlingToken() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;

  if (!accessKey || !secretKey) throw new Error('[kling] Missing KLING_ACCESS_KEY or KLING_SECRET_KEY');

  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 min expiry
    nbf: Math.floor(Date.now() / 1000) - 5
  };

  return jwt.sign(payload, secretKey, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: 'JWT' }
  });
}

async function execute({ prompt, inputs, model, stepId }) {
  console.log(`[kling] Starting generation — step: ${stepId}`);

  const modelId = model || 'kling-v2';
  const token = generateKlingToken();

  // Determine if this is image-to-video or product replacement
  const isVideo = inputs.outputType === 'video' || stepId.includes('video');

  let submitUrl;
  let requestBody;

  if (isVideo) {
    // Image to video
    submitUrl = `${KLING_BASE_URL}/v1/videos/image2video`;
    requestBody = {
      model_name: modelId,
      prompt,
      image: inputs.referenceImage,
      aspect_ratio: inputs.aspectRatio || '16:9',
      duration: inputs.duration || '5'
    };
  } else {
    // Product replacement — multi-elements API
    submitUrl = `${KLING_BASE_URL}/v1/images/generations`;
    requestBody = {
      model_name: modelId,
      prompt,
      image_reference: inputs.referenceImage,
      image_reference_type: 'subject',
      aspect_ratio: inputs.aspectRatio || '1:1',
      n: 1
    };
  }

  console.log(`[kling] Submitting job — model: ${modelId}, type: ${isVideo ? 'video' : 'image'}`);

  // POST to submit
  const submitResponse = await axios.post(
    submitUrl,
    requestBody,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const taskId = submitResponse.data?.data?.task_id;
  if (!taskId) throw new Error('[kling] No task_id in submit response');

  console.log(`[kling] Job submitted — task_id: ${taskId} — polling...`);

  // Poll until complete
  const pollUrl = isVideo
    ? `${KLING_BASE_URL}/v1/videos/image2video/${taskId}`
    : `${KLING_BASE_URL}/v1/images/generations/${taskId}`;

  let polls = 0;
  while (polls < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    polls++;

    // Regenerate token on long jobs to avoid expiry
    const pollToken = generateKlingToken();

    const pollResponse = await axios.get(pollUrl, {
      headers: { 'Authorization': `Bearer ${pollToken}` },
      timeout: 15000
    });

    const taskStatus = pollResponse.data?.data?.task_status;
    console.log(`[kling] Poll ${polls} — status: ${taskStatus}`);

    if (taskStatus === 'succeed') {
      let mediaUrl;

      if (isVideo) {
        mediaUrl = pollResponse.data?.data?.task_result?.videos?.[0]?.url;
      } else {
        mediaUrl = pollResponse.data?.data?.task_result?.images?.[0]?.url;
      }

      if (!mediaUrl) throw new Error('[kling] No media URL in completed response');

      console.log(`[kling] Generation complete — downloading`);

      // Download media
      const mediaResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 120000
      });

      const mediaBuffer = Buffer.from(mediaResponse.data);
      const ext = isVideo ? 'mp4' : 'jpg';
      const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
      const s3Key = `ai-outputs/${Date.now()}_${stepId}_kling.${ext}`;

      // Re-upload to S3
      const s3Url = await uploadBufferToS3(mediaBuffer, s3Key, mimeType);
      console.log(`[kling] Uploaded to S3: ${s3Url}`);

      return s3Url;
    }

    if (taskStatus === 'failed') {
      const errMsg = pollResponse.data?.data?.task_status_msg || 'unknown error';
      throw new Error(`[kling] Generation failed — ${errMsg}`);
    }

    // Keep polling for submitted / processing
  }

  throw new Error(`[kling] Timed out after ${MAX_POLLS} polls`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { execute };
