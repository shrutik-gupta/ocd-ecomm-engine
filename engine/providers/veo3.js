const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const AIML_BASE_URL = 'https://api.aimlapi.com/v2';
const POLL_INTERVAL_MS = 8000;
const MAX_POLLS = 60; // 8 minutes max — Veo3 takes 2-5 min

async function execute({ prompt, inputs, model, stepId }) {
  console.log(`[veo3] Starting generation — step: ${stepId}`);

  const modelId = model || 'google/veo3';

  // Build request body
  const requestBody = {
    model: modelId,
    prompt_text: prompt,
    aspect_ratio: inputs.aspectRatio || '16:9'
  };

  // Add reference image if provided
  if (inputs.referenceImage) {
    requestBody.prompt_image = inputs.referenceImage;
  }

  console.log(`[veo3] Submitting job via AIML API — model: ${modelId}`);

  // POST to submit
  const submitResponse = await axios.post(
    `${AIML_BASE_URL}/generate/video`,
    requestBody,
    {
      headers: {
        'Authorization': `Bearer ${process.env.AIML_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const generationId = submitResponse.data?.id;
  if (!generationId) throw new Error('[veo3] No generation id in submit response');

  console.log(`[veo3] Job submitted — id: ${generationId} — polling...`);

  // Poll until complete
  let polls = 0;
  while (polls < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    polls++;

    const pollResponse = await axios.get(
      `${AIML_BASE_URL}/generate/video`,
      {
        params: { generation_id: generationId },
        headers: {
          'Authorization': `Bearer ${process.env.AIML_API_KEY}`
        },
        timeout: 15000
      }
    );

    const status = pollResponse.data?.status;
    console.log(`[veo3] Poll ${polls} — status: ${status}`);

    if (status === 'completed' || status === 'succeeded') {
      // Veo3 returns video as an object with .url — not a string
      const videoData = pollResponse.data?.video;
      let videoUrl;

      if (videoData?.url) {
        // Expected format — object with url field
        videoUrl = videoData.url;
      } else if (typeof videoData === 'string') {
        // Fallback in case format changes
        videoUrl = videoData;
      } else if (Array.isArray(videoData) && videoData.length > 0) {
        videoUrl = videoData[0]?.url || videoData[0];
      }

      if (!videoUrl) throw new Error('[veo3] No video URL in completed response');

      console.log(`[veo3] Generation complete — downloading`);

      // Download video
      const videoResponse = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 180000 // 3 min download timeout — Veo3 videos are large
      });

      const videoBuffer = Buffer.from(videoResponse.data);
      const s3Key = `ai-outputs/${Date.now()}_${stepId}_veo3.mp4`;

      // Re-upload to S3
      const s3Url = await uploadBufferToS3(videoBuffer, s3Key, 'video/mp4');
      console.log(`[veo3] Uploaded to S3: ${s3Url}`);

      return s3Url;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`[veo3] Generation failed — status: ${status}`);
    }

    // Keep polling for queued / processing
  }

  throw new Error(`[veo3] Timed out after ${MAX_POLLS} polls`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { execute };
