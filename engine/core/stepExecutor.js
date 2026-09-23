const BASE_PROMPT = `You are a professional commercial product photographer. Generate photorealistic, commercially viable images. Maintain exact product appearance — do not alter the product's shape, colour, material, or features. Output must be print-ready quality with accurate lighting, sharp focus, and no visible AI artefacts.`;

const { composeFinalPrompt } = require('./promptComposer');

// Resolve {{variable}} references inside a STRING (interpolation — always returns a string)
function resolveVariables(str, context) {
  if (typeof str !== 'string') return str;

  return str.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = lookup(path.trim(), context);
    if (value === undefined || value === null) return match;
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  });
}

// Resolve a value reference. Unlike resolveVariables, if the ENTIRE string is a
// single {{...}} token, this returns the raw resolved value (array/object/string),
// not a stringified version. Used for step.inputs so {{userUpload}} -> array.
function resolveValue(val, context) {
  if (typeof val !== 'string') return val;
  const whole = val.trim().match(/^\{\{([^}]+)\}\}$/);
  if (whole) {
    const resolved = lookup(whole[1].trim(), context);
    return resolved === undefined ? val : resolved;
  }
  // Mixed string with embedded tokens -> string interpolation
  return resolveVariables(val, context);
}

// Walk a dotted path (with optional [index]) through the context object.
function lookup(path, context) {
  const parts = path.split('.');
  let value = context;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      value = value[arrayMatch[1]];
      if (Array.isArray(value)) value = value[parseInt(arrayMatch[2])];
      else return undefined;
    } else {
      value = value[part];
    }
  }
  return value;
}

// Assemble the full Layer 2 master prompt (resolved against context).
function assembleMasterPrompt(template, marketplaceRecord, context) {
  let masterPrompt = '';

  if (template.templateType === 'tile_pack' && marketplaceRecord) {
    masterPrompt = marketplaceRecord.promptInjection + '\n\n' + template.masterPromptSupplement;
  } else {
    // product_replacement and product_video — use masterPromptSupplement directly
    masterPrompt = template.masterPromptSupplement || '';
  }

  return resolveVariables(masterPrompt, context);
}

// Execute a single step
async function executeStep(step, template, marketplaceRecord, context) {
  console.log(`[stepExecutor] Executing step ${step.stepId}: ${step.label}`);

  // ordered array of all uploaded image URLs (front, back, ...)
  const imageUrlList = context.imageUrlList || (context.userUpload ? [context.userUpload] : []);
  // named map { userUpload, userUploadBack, ... }
  const imageUrls = context.imageUrls || (context.userUpload ? { userUpload: context.userUpload } : {});

  // Build the resolution context.
  const resolutionContext = {
    ...imageUrls,
    userUpload: imageUrlList,
    imageUpload: imageUrlList,
    userInputs: context.userInputs,
    productContext: context.productContext,
    steps: context.stepOutputs || {}
  };

  // Assemble master prompt (Layer 2)
  const masterPrompt = assembleMasterPrompt(template, marketplaceRecord, resolutionContext);
  resolutionContext.masterPrompt = masterPrompt;

  // ── Prompt Composer mode (opt-in per template) ──────────────────────────────
  // When ON: an AI text call fuses the product analysis + master prompt into a
  // single final image prompt (Call 2). That composed prompt is used for the
  // image call, replacing the BASE+master+tile assembly. When OFF: original path.
  const isParallel = step.executionType === 'parallel' && step.parallelCount > 1;
  const tileCount = isParallel ? step.parallelCount : 1;

  // Resolve each tile's own master/brief text (the per-tile prompt boxes in the
  // Step Builder). Single steps have one prompt; parallel steps have step.prompts[i].
  const tileMasterText = (tileIndex) => {
    if (isParallel) {
      const arr = Array.isArray(step.prompts) ? step.prompts : [];
      const raw = arr[tileIndex] !== undefined ? arr[tileIndex] : (arr[0] || step.prompt || '');
      return resolveVariables(raw, resolutionContext);
    }
    return resolveVariables(step.prompt || '', resolutionContext);
  };

  // composedPrompts[tileIndex] holds the AI-composed final prompt for that tile.
  // For a single step it's just composedPrompts[0]. null entry => fall back to
  // standard assembly for that tile.
  let composedPrompts = new Array(tileCount).fill(null);

  if (template.promptComposerMode) {
    const scanFailed = context.productContext && context.productContext._scanFailed;
    // When the analyzer is OFF there is no analysis to fuse — productContext is
    // absent/empty. The composer can still run (brief-only), but if the analyzer
    // was explicitly disabled we skip composing and fall back to standard assembly,
    // matching the "no analysis at all" semantics.
    const analyzerDisabled = template.analyzerEnabled === false;
    if (scanFailed) {
      // GUARD: scan failed → analysis is garbage. Skip the composer entirely and
      // fall back to standard assembly for all tiles.
      console.error(`[stepExecutor] promptComposerMode ON but SCAN FAILED (${context.productContext._scanError}) — skipping composer, using standard assembly`);
      if (context._composerMeta) {
        context._composerMeta.skipped = true;
        context._composerMeta.reason = `scan failed: ${context.productContext._scanError}`;
      }
    } else if (analyzerDisabled) {
      console.log('[stepExecutor] promptComposerMode ON but analyzer is DISABLED — no analysis to fuse, using standard assembly');
      if (context._composerMeta) {
        context._composerMeta.skipped = true;
        context._composerMeta.reason = 'analyzer disabled (no product analysis to compose from)';
      }
    } else {
      // Compose per tile. For each tile, the "master" fed to the composer is the
      // template-level masterPrompt (shared brief) PLUS that tile's own prompt box.
      // Single step => one tile => composes once (current behaviour).
      console.log(`[stepExecutor] promptComposerMode ON — composing ${tileCount} prompt(s) for step ${step.stepId} (${isParallel ? 'per-tile' : 'single'})`);
      const composeOne = async (tileIndex) => {
        const tileMaster = tileMasterText(tileIndex);
        // Shared template brief + this tile's specific brief.
        const combinedMaster = [masterPrompt, tileMaster].filter(Boolean).join('\n\n');
        try {
          const result = await composeFinalPrompt({
            productContext: context.productContext,
            masterPrompt: combinedMaster,
            composerInstruction: template.composerInstruction,
            composerModel: template.composerModel
          });
          console.log(`[stepExecutor] tile ${tileIndex} composed (${result.length} chars)`);
          return result;
        } catch (err) {
          console.error(`[stepExecutor] tile ${tileIndex} composer FAILED: ${err.message} — that tile falls back to standard assembly`);
          if (context._composerMeta) {
            context._composerMeta.skipped = true;
            context._composerMeta.reason = `composer error (tile ${tileIndex}): ${err.message}`;
          }
          return null;
        }
      };
      // Run all tile composes in parallel.
      composedPrompts = await Promise.all(
        Array.from({ length: tileCount }, (_, i) => composeOne(i))
      );
      // Surface composed prompt(s) for the UI: array for parallel, single string for one tile.
      if (context._composerMeta) {
        if (isParallel) context._composerMeta.composedPrompts = composedPrompts;
        else context._composerMeta.composedPrompt = composedPrompts[0];
      }
    }
  }

  // Resolve step inputs (array-aware: {{userUpload}} -> array, {{userUpload[0]}} -> one)
  const resolvedInputs = {};
  if (step.inputs) {
    for (const [key, val] of Object.entries(step.inputs)) {
      resolvedInputs[key] = resolveValue(val, resolutionContext);
    }
  }

  // Load the correct provider adapter
  const adapter = loadAdapter(step.provider);

  // Build one tile's call args. If this tile has a composed prompt, use it verbatim
  // (it already incorporates the analysis + that tile's brief). Otherwise fall back
  // to BASE + master + per-tile prompt.
  const buildArgs = (tileIndex) => {
    let finalPrompt;
    if (composedPrompts[tileIndex]) {
      finalPrompt = composedPrompts[tileIndex];
    } else {
      const rawPrompt = (Array.isArray(step.prompts) && step.prompts.length > 0)
        ? (step.prompts[tileIndex] !== undefined ? step.prompts[tileIndex] : step.prompts[0])
        : (step.prompt || '');
      const perTilePrompt = resolveVariables(rawPrompt, resolutionContext);
      finalPrompt = `${BASE_PROMPT}\n\n${masterPrompt}\n\n${perTilePrompt}`.trim();
    }
    console.log(`[stepExecutor] ===== ${step.stepId} tile ${tileIndex} FULL PROMPT =====\n${finalPrompt}\n[stepExecutor] ===== end ${step.stepId} tile ${tileIndex} =====`);
    return {
      prompt: finalPrompt,
      inputs: resolvedInputs,
      imageUrls: imageUrlList,   // every adapter receives the full array
      model: step.model,
resolution: step.resolution,
userInputs: context.userInputs,
      quality: step.quality,     // image-quality tier (high|medium|low) for adapters that support it
      stepId: step.stepId,
      tileIndex
    };
  };

  // Execute — single or parallel
  let output;
  if (isParallel) {
    const promises = Array.from({ length: step.parallelCount }, (_, i) =>
      new Promise(resolve => setTimeout(resolve, i * 4000)).then(() => adapter.execute(buildArgs(i)))
    );
    output = await Promise.all(promises);
    console.log(`[stepExecutor] Parallel step ${step.stepId} complete — ${output.length} outputs`);
  } else {
    output = await adapter.execute(buildArgs(0));
    console.log(`[stepExecutor] Single step ${step.stepId} complete`);
  }

  return { [step.outputKey]: output };
}

function loadAdapter(providerId) {
  const adapters = {
    freepik:      require('../providers/freepik'),
    nanabanana:   require('../providers/nanabanana'),
    seedream:     require('../providers/seedream'),
    kling:        require('../providers/kling'),
    runway:       require('../providers/runway'),
    seedance:     require('../providers/seedance'),
    veo3:         require('../providers/veo3'),
    // Session 13 additions:
    openai:       require('../providers/openai'),        // GPT 5.4 (text)
    anthropic:    require('../providers/anthropic'),     // Claude Opus 4.7 (text)
    openai_image: require('../providers/openai_image')   // GPT Image 2.0 (image + quality)
  };

  const adapter = adapters[providerId];
  if (!adapter) throw new Error(`[stepExecutor] Unknown provider: ${providerId}`);
  return adapter;
}

module.exports = { executeStep, resolveVariables, resolveValue, assembleMasterPrompt };
