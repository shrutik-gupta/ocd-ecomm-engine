const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function uploadBufferToS3(buffer, s3Key, contentType) {
  const bucket = process.env.AI_OUTPUTS_BUCKET;
  if (!bucket) throw new Error('[s3Uploader] AI_OUTPUTS_BUCKET env var not set');

  console.log(`[s3Uploader] Uploading to s3://${bucket}/${s3Key} — size: ${buffer.length} bytes`);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));

  // Return permanent public S3 URL
  const url = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`[s3Uploader] Upload complete: ${url}`);

  return url;
}

module.exports = { uploadBufferToS3 };
