const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const FREEPIK_BASE_URL = 'https://api.freepik.com/v1';
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 60; // 3 minutes max

async function execute({ prompt, inputs, model, stepId }) {
  console.log(`[freepik] Starting generation — step: ${stepId}`);

  const modelId = model || 'mystic';

  // Build request body
  const requestBody = {
    prompt,
    model: modelId,
    image: { size: aspectRatioToSize(inputs.aspectRatio) }
  };

  // Add reference image if provided
  if (inputs.referenceImage) {
    requestBody.reference_image = { url: inputs.referenceImage, strength: 0.85 };
  }

  console.log(`[freepik] Submitting job to Freepik Mystic`);

  // POST to submit
  const submitResponse = await axios.post(
    `${FREEPIK_BASE_URL}/ai/text-to-image`,
    requestBody,
    {
      headers: {
        'x-freepik-api-key': process.env.FREEPIK_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const taskId = submitResponse.data?.data?.task_id;
  if (!taskId) throw new Error('[freepik] No task_id in submit response');

  console.log(`[freepik] Job submitted — task_id: ${taskId} — polling...`);

  // Poll until complete
  let polls = 0;
  while (polls < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    polls++;

    const pollResponse = await axios.get(
      `${FREEPIK_BASE_URL}/ai/text-to-image/${taskId}`,
      {
        headers: { 'x-freepik-api-key': process.env.FREEPIK_API_KEY },
        timeout: 15000
      }
    );

    const status = pollResponse.data?.data?.status;
    console.log(`[freepik] Poll ${polls} — status: ${status}`);

    if (status === 'COMPLETED') {
      const imageUrl = pollResponse.data?.data?.generated?.[0]?.url;
      if (!imageUrl) throw new Error('[freepik] No image URL in completed response');

      console.log(`[freepik] Generation complete — downloading`);

      // Download image
      const imgResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      const imageBuffer = Buffer.from(imgResponse.data);
      const s3Key = `ai-outputs/${Date.now()}_${stepId}_freepik.jpg`;

      // Re-upload to S3
      const s3Url = await uploadBufferToS3(imageBuffer, s3Key, 'image/jpeg');
      console.log(`[freepik] Uploaded to S3: ${s3Url}`);

      return s3Url;
    }

    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`[freepik] Generation failed — status: ${status}`);
    }

    // Keep polling for PENDING / PROCESSING
  }

  throw new Error(`[freepik] Timed out after ${MAX_POLLS} polls`);
}

function aspectRatioToSize(ratio) {
  const map = {
    '1:1':  'square_1_1',
    '9:16': 'portrait_9_16',
    '16:9': 'landscape_16_9',
    '4:5':  'portrait_4_5'
  };
  return map[ratio] || 'square_1_1';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { execute };
