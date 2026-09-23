const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const AIML_BASE_URL = 'https://api.aimlapi.com/v2';
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 60; // 5 minutes max

async function execute({ prompt, inputs, model, stepId }) {
  console.log(`[runway] Starting generation — step: ${stepId}`);

  const modelId = model || 'runway-gen4-turbo';

  // Build request body
  const requestBody = {
    model: modelId,
    prompt_text: prompt,
    ratio: inputs.aspectRatio || '1280:720'
  };

  // Add reference image if provided
  if (inputs.referenceImage) {
    requestBody.prompt_image = inputs.referenceImage;
  }

  console.log(`[runway] Submitting job via AIML API — model: ${modelId}`);

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
  if (!generationId) throw new Error('[runway] No generation id in submit response');

  console.log(`[runway] Job submitted — id: ${generationId} — polling...`);

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
    console.log(`[runway] Poll ${polls} — status: ${status}`);

    if (status === 'completed' || status === 'succeeded') {
      // Runway via AIML may return video as string or array[0]
      const videoData = pollResponse.data?.video;
      let videoUrl;

      if (typeof videoData === 'string') {
        videoUrl = videoData;
      } else if (Array.isArray(videoData) && videoData.length > 0) {
        videoUrl = videoData[0];
      } else if (videoData?.url) {
        videoUrl = videoData.url;
      }

      if (!videoUrl) throw new Error('[runway] No video URL in completed response');

      console.log(`[runway] Generation complete — downloading`);

      // Download video
      const videoResponse = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120000
      });

      const videoBuffer = Buffer.from(videoResponse.data);
      const s3Key = `ai-outputs/${Date.now()}_${stepId}_runway.mp4`;

      // Re-upload to S3
      const s3Url = await uploadBufferToS3(videoBuffer, s3Key, 'video/mp4');
      console.log(`[runway] Uploaded to S3: ${s3Url}`);

      return s3Url;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`[runway] Generation failed — status: ${status}`);
    }

    // Keep polling for queued / processing
  }

  throw new Error(`[runway] Timed out after ${MAX_POLLS} polls`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { execute };
