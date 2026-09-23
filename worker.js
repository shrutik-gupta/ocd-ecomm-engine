const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { ecommRunner } = require('./engine/core/ecommRunner');
const sqs = new SQSClient({ region: process.env.AWS_REGION });

// ─── worker.js — ocd-ecomm-engine ─────────────────────────────────── Phase 3 ─
// Byte-for-byte the tools worker, with one line changed: it runs ecommRunner.
//
// There is deliberately NO dispatch or discriminator in here. The QUEUE is what
// separates the engines — this process polls ONLY ocd-ecomm-jobs-queue and
// always runs ecommRunner. (`engine:"ecomm"` lives on the DynamoDB rows, for
// filtering, not for routing.)
//
// ⚠️ THE QUEUE-STEAL INCIDENT (July 16). The variable the worker reads is
// AI_JOBS_SQS_QUEUE_URL — not SQS_QUEUE_URL. Editing the wrong one changes
// nothing, and this process will happily poll the Phase 2 queue and complete a
// live Phase 2 job. Before every start:
//     grep -n "ocd-ai-jobs-queue" ecosystem.config.js   # must print NOTHING
// And remember `pm2 restart` does NOT re-read ecosystem env:
//     pm2 delete ocd-ecomm-engine && pm2 start ecosystem.config.js && pm2 save
// ──────────────────────────────────────────────────────────────────────────────

const QUEUE_URL = process.env.AI_JOBS_SQS_QUEUE_URL;
const POLL_WAIT_SECONDS = 20; // Long polling — reduces empty receives
const MAX_MESSAGES = 1; // Process one job at a time

console.log('[worker] OCD Ecomm Engine starting...');
console.log(`[worker] Queue: ${QUEUE_URL}`);
console.log(`[worker] Region: ${process.env.AWS_REGION}`);

// Boot-time guard for the incident above: refuse to poll another engine's queue.
if (QUEUE_URL && !/ocd-ecomm-jobs-queue/.test(QUEUE_URL)) {
  console.error(`[worker] REFUSING TO START — AI_JOBS_SQS_QUEUE_URL is not the ecomm queue:\n  ${QUEUE_URL}`);
  console.error('[worker] Fix ecosystem.config.js, then pm2 delete + pm2 start (restart does not re-read env).');
  process.exit(1);
}
if (!QUEUE_URL) {
  console.error('[worker] REFUSING TO START — AI_JOBS_SQS_QUEUE_URL is not set.');
  process.exit(1);
}

let isProcessing = false;

async function pollQueue() {
  if (isProcessing) {
    // Already processing a job — skip this poll cycle
    setTimeout(pollQueue, 5000);
    return;
  }

  try {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: MAX_MESSAGES,
      WaitTimeSeconds: POLL_WAIT_SECONDS, // Long polling
      VisibilityTimeout: 1800 // 30 minutes — matches the queue setting (E0)
    }));

    const messages = response.Messages || [];

    if (messages.length === 0) {
      // No jobs — poll again immediately (long poll already waited 20s)
      setImmediate(pollQueue);
      return;
    }

    const message = messages[0];
    let jobId;
    let messageBody;

    try {
      messageBody = JSON.parse(message.Body);
      jobId = messageBody.jobId;
    } catch (parseErr) {
      console.error('[worker] Failed to parse message body:', message.Body);
      await deleteMessage(message.ReceiptHandle);
      setImmediate(pollQueue);
      return;
    }

    if (!jobId) {
      console.error('[worker] Message has no jobId — discarding');
      await deleteMessage(message.ReceiptHandle);
      setImmediate(pollQueue);
      return;
    }

    console.log(`[worker] picked up job: ${jobId}`);
    isProcessing = true;

    try {
      await ecommRunner(jobId, messageBody);
    } catch (err) {
      console.error(`[worker] ecommRunner threw for job ${jobId}:`, err.message);
      // ecommRunner handles its own error status updates.
      // We still delete the message so it doesn't get reprocessed.
    } finally {
      // Delete message from queue regardless of success/failure
      await deleteMessage(message.ReceiptHandle);
      isProcessing = false;
      console.log(`[worker] Job ${jobId} done — resuming poll`);
    }

    setImmediate(pollQueue);

  } catch (err) {
    console.error('[worker] SQS poll error:', err.message);
    // Wait 10s before retrying on SQS errors
    setTimeout(pollQueue, 10000);
  }
}

async function deleteMessage(receiptHandle) {
  try {
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle
    }));
  } catch (err) {
    console.error('[worker] Failed to delete SQS message:', err.message);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[worker] SIGINT received — shutting down gracefully');
  process.exit(0);
});

// Start polling
pollQueue();
