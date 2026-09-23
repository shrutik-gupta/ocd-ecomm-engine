const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { productScan } = require('./productScan');
const { executeStep } = require('./stepExecutor');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

function aliasUploadKeys(imageUrls) {
    for (const [k, v] of Object.entries({ ...imageUrls })) {
        if (k.startsWith("userUpload")) {
            const nk = k.replace("userUpload", "imageUpload");
            if (imageUrls[nk] === undefined) imageUrls[nk] = v;
        } else if (k.startsWith("imageUpload")) {
            const ok = k.replace("imageUpload", "userUpload");
            if (imageUrls[ok] === undefined) imageUrls[ok] = v;
        }
    }
    return imageUrls;
}

// Update job status in DynamoDB
async function updateJobStatus(jobId, updates) {
  const expressions = [];
  const names = {};
  const values = {};

  for (const [key, val] of Object.entries(updates)) {
    expressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = val;
  }

  await dynamo.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}

// Load template from DynamoDB
async function loadTemplate(templateId) {
  const result = await dynamo.send(new GetCommand({
    TableName: process.env.PHASE2_AI_TEMPLATES_TABLE,
    Key: { templateId }
  }));
  if (!result.Item) throw new Error(`Template not found: ${templateId}`);
  return result.Item;
}

// Load marketplace record if needed
async function loadMarketplace(marketplaceId) {
  if (!marketplaceId) return null;
  const result = await dynamo.send(new GetCommand({
    TableName: process.env.MARKETPLACE_INTELLIGENCE_TABLE,
    Key: { marketplaceId }
  }));
  return result.Item || null;
}

// Load job from DynamoDB
async function loadJob(jobId) {
  const result = await dynamo.send(new GetCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId }
  }));
  if (!result.Item) throw new Error(`Job not found: ${jobId}`);
  return result.Item;
}

// Assemble finalOutputs from outputSchema
function assembleFinalOutputs(outputSchema, stepOutputs) {
  const results = [];
  for (const outputDef of outputSchema) {
    const path = outputDef.from.replace('steps.', '');
    const parts = path.split('.');
    const stepId = parts[0];
    const keyWithIndex = parts[1];
    const stepData = stepOutputs[stepId];
    if (!stepData) { results.push({ label: outputDef.label, type: outputDef.type, url: null }); continue; }
    // Parallel: stepData is array of {outputs,caption,model}
    if (Array.isArray(stepData)) {
      stepData.forEach((run, i) => { (run.outputs || []).forEach(o => { results.push({ label: o.label || outputDef.label + ' ' + (i+1), type: o.type || outputDef.type, url: o.url || null }); }); });
      continue;
    }
    // Key points to parallel array
    const baseKey = keyWithIndex ? keyWithIndex.replace(/\[\d+\]$/, '') : null;
    const keyData = baseKey ? stepData[baseKey] : null;
    if (Array.isArray(keyData)) {
      keyData.forEach((run, i) => { (run.outputs || []).forEach(o => { results.push({ label: o.label || outputDef.label + ' ' + (i+1), type: o.type || outputDef.type, url: o.url || null }); }); });
      continue;
    }
    // Single step with outputs array
    const val = keyWithIndex ? stepData[keyWithIndex] : stepData;
    if (val && Array.isArray(val.outputs)) {
      val.outputs.forEach((o, i) => { results.push({ label: o.label || outputDef.label + ' ' + (i+1), type: o.type || outputDef.type, url: o.url || null }); });
    } else {
      const arrayMatch = keyWithIndex && keyWithIndex.match(/^(.+)\[(\d+)\]$/);
      let value;
      if (arrayMatch) { value = stepData[arrayMatch[1]] && stepData[arrayMatch[1]][parseInt(arrayMatch[2])]; }
      else { value = val; }
      results.push({ label: outputDef.label, type: outputDef.type, url: value || null });
    }
  }
  return results;
}

// Main entry point — called by the SQS poller
async function runWorkflow(jobId, messageBody) {
  console.log(`\n[workflowRunner] ===== Starting job ${jobId} =====`);
  const startTime = Date.now();

  try {
    // Load job
    const job = await loadJob(jobId);
    console.log(`[workflowRunner] Job loaded — template: ${job.templateId}`);

    // Load template — use _testTemplate from SQS message if this is a workbook test
    let template;
    if (messageBody && messageBody._testTemplate) {
      template = messageBody._testTemplate;
      console.log(`[workflowRunner] Using test template from SQS message — type: ${template.templateType}`);
    } else {
      template = await loadTemplate(job.templateId);
      console.log(`[workflowRunner] Template loaded from DynamoDB — type: ${template.templateType}`);
    }

    // Load marketplace if tile_pack
    const marketplaceRecord = await loadMarketplace(template.marketplaceId);

    // --- Normalize inputs: support BOTH the old flat array ["url", ...]
    // --- AND the new keyed map { userUpload:"url", userUploadBack:"url" }.
    // imageUrls = { fieldName: url }   (named map)
    // imageUrlList = ["url", ...]      (ordered, for productScan + {{userUpload}} array)
    let imageUrls = {};
    let imageUrlList = [];

    if (Array.isArray(job.inputFiles)) {
      // Old shape: flat array. First → userUpload, rest → userUpload2, userUpload3...
      imageUrlList = job.inputFiles.filter(Boolean);
      imageUrlList.forEach((url, i) => {
        imageUrls[i === 0 ? 'userUpload' : `userUpload${i + 1}`] = url;
      });
    } else if (job.inputFiles && typeof job.inputFiles === 'object') {
      // New shape: keyed map. Preserve names; userUpload first in the ordered list.
      imageUrls = { ...job.inputFiles };
      const keys = Object.keys(imageUrls);
      const ordered = keys.includes('userUpload')
        ? ['userUpload', ...keys.filter(k => k !== 'userUpload')]
        : keys;
      imageUrlList = ordered.map(k => imageUrls[k]).filter(Boolean);
    }

    if (imageUrlList.length === 0) throw new Error('No input file found on job');

    aliasUploadKeys(imageUrls);

    // Backward-compat single value (first image)
    const userUpload = imageUrlList[0];

    // Stage 1 — Product Scan / Analyzer.
    // analyzerEnabled defaults to TRUE when absent (existing templates always scanned),
    // so only an explicit `false` skips it. When skipped, NO analysis runs and
    // productContext is left empty — {{productContext.*}} tokens resolve to nothing,
    // and the composer (if on) falls back to standard assembly (see stepExecutor).
    const analyzerEnabled = template.analyzerEnabled !== false;
    let productContext = {};

    if (analyzerEnabled) {
      console.log(`[workflowRunner] Stage 1 — Product Scan (model: ${template.scanModel || 'default'})`);
      await updateJobStatus(jobId, { status: 'processing', currentStepLabel: 'Scanning product image...' });
      // Scan ALL uploaded images (front/back) for richer productContext.
      productContext = await productScan(imageUrlList, template.scanPrompt, template.scanModel);
      await updateJobStatus(jobId, { productContext });
      console.log(`[workflowRunner] Product scan complete (${imageUrlList.length} image(s))`);
    } else {
      console.log('[workflowRunner] Stage 1 — Analyzer DISABLED (analyzerEnabled=false) — skipping scan entirely');
      await updateJobStatus(jobId, { status: 'processing', currentStepLabel: 'Preparing...', productContext: {} });
    }

    // Build execution context
    const context = {
      userUpload,          // first image (back-compat for {{userUpload}} as single)
      imageUrls,           // { fieldName: url } — named map for multi-image
      imageUrlList,        // ordered array — for {{userUpload}} array + {{userUpload[i]}}
      userInputs: job.userInputs || {},
      productContext,
      stepOutputs: job.stepOutputs || {},
      _composerMeta: {}
    };
    // Stage 2+3 — Tier execution
    const executionOrder = template.workflow.executionOrder;
    const steps = template.workflow.steps;
    const totalTiers = executionOrder.length;

    console.log(`[workflowRunner] ${totalTiers} tier(s) to execute`);

    for (let tierIndex = 0; tierIndex < executionOrder.length; tierIndex++) {
      const tierNumber = tierIndex + 1;
      const tierStepIds = executionOrder[tierIndex];

      console.log(`[workflowRunner] Tier ${tierNumber}/${totalTiers} — steps: ${tierStepIds.join(', ')}`);

      // Get step configs for this tier
      const tierSteps = tierStepIds.map(stepId => {
        const step = steps.find(s => s.stepId === stepId);
        if (!step) throw new Error(`Step ${stepId} not found in template workflow`);
        return step;
      });

      // Update status
      const firstStepLabel = tierSteps[0].label || `Processing tier ${tierNumber}`;
      await updateJobStatus(jobId, {
        status: `tier_${tierNumber}_of_${totalTiers}`,
        currentTier: tierNumber,
        totalTiers,
        currentStepLabel: firstStepLabel
      });

      // Execute all steps in this tier in parallel
      const tierResults = await Promise.all(
        tierSteps.map(step => executeStep(step, template, marketplaceRecord, context))
      );

      // Merge tier results into stepOutputs
      for (const result of tierResults) {
        const stepId = tierStepIds[tierResults.indexOf(result)];
        context.stepOutputs[stepId] = result;
      }

      // Checkpoint — save stepOutputs to DynamoDB after every tier
      await updateJobStatus(jobId, { stepOutputs: context.stepOutputs });
      console.log(`[workflowRunner] Tier ${tierNumber} complete — checkpoint saved`);
    }

    // Stage 4 — Assemble final outputs
    console.log(`[workflowRunner] Assembling final outputs`);
    const finalOutputs = assembleFinalOutputs(template.workflow.outputSchema, context.stepOutputs);

    const jobDurationMs = Date.now() - startTime;

    // Mark job complete
    await updateJobStatus(jobId, {
      status: 'completed',
      finalOutputs,
      jobDurationMs,
      completedAt: new Date().toISOString(),
      currentStepLabel: 'Complete',
      composedPrompt: context._composerMeta.composedPrompt || null,
      composedPrompts: context._composerMeta.composedPrompts || null,
      composerSkippedReason: context._composerMeta.reason || null
    });

    console.log(`[workflowRunner] ===== Job ${jobId} COMPLETE in ${jobDurationMs}ms =====\n`);
    return { success: true, jobId, jobDurationMs };

  } catch (err) {
    console.error(`[workflowRunner] ===== Job ${jobId} FAILED =====`);
    console.error(err);

    await updateJobStatus(jobId, {
      status: 'failed',
      errorMessage: err.message,
      completedAt: new Date().toISOString(),
      currentStepLabel: 'Failed'
    }).catch(e => console.error('[workflowRunner] Failed to update error status:', e));

    return { success: false, jobId, error: err.message };
  }
}

module.exports = { runWorkflow };
