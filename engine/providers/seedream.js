const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const ARK_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';

async function execute({ prompt, inputs, model, stepId }) {
  console.log(`[seedream] Starting generation — step: ${stepId}`);

  const modelId = model || 'seedream-3-0';

  // Build messages with optional reference image
  const userContent = [];

  if (inputs.referenceImage) {
    userContent.push({
      type: 'image_url',
      image_url: { url: inputs.referenceImage }
    });
  }

  userContent.push({ type: 'text', text: prompt });

  // Build request body
  const requestBody = {
    model: modelId,
    messages: [{ role: 'user', content: userContent }],
    size: inputs.aspectRatio ? aspectRatioToSize(inputs.aspectRatio) : '1024x1024'
  };

  console.log(`[seedream] Calling BytePlus ModelArk — model: ${modelId}`);

  // Synchronous — URL is in the response body immediately
  const response = await axios.post(
    `${ARK_BASE_URL}/images/generations`,
    requestBody,
    {
      headers: {
        'Authorization': `Bearer ${process.env.ARK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );

  const imageUrl = response.data?.data?.[0]?.url;
  if (!imageUrl) throw new Error('[seedream] No image URL in response');

  console.log(`[seedream] Got image URL — downloading`);

  // Download image
  const imgResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000
  });

  const imageBuffer = Buffer.from(imgResponse.data);
  const s3Key = `ai-outputs/${Date.now()}_${stepId}_seedream.jpg`;

  // Re-upload to S3 (provider URLs expire)
  const s3Url = await uploadBufferToS3(imageBuffer, s3Key, 'image/jpeg');
  console.log(`[seedream] Uploaded to S3: ${s3Url}`);

  return s3Url;
}

function aspectRatioToSize(ratio) {
  const map = {
    '1:1':  '1024x1024',
    '9:16': '768x1360',
    '16:9': '1360x768',
    '4:5':  '819x1024'
  };
  return map[ratio] || '1024x1024';
}

module.exports = { execute };
