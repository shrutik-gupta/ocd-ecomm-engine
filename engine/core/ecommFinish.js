const axios = require('axios');
const sharp = require('sharp');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

// ─── core/ecommFinish.js ─────────────────────────────────────────── Phase 3 ──
//
// MARKETPLACE ADAPT — the parts that need no model.
//
// An adapted tile goes through two different kinds of work:
//   1. (sometimes) an image-model call that re-makes the tile for the target
//      marketplace — a new canvas shape, a white main image, text removed, …
//      This file only WRITES THE PROMPT for that call (buildAdaptPrompt).
//   2. (always) a finishing pass in code: exact pixels, file format, sRGB, file
//      weight, and — for a main image on white — a true 255 background and the
//      product re-framed to the fill the marketplace asks for. Then it MEASURES
//      the result and returns a list of checks.
//
// The model is bad at exact numbers (85% fill, RGB 255, 2000 px). Code is exact.
// So everything that can be done in code is done here, after the model.
//
// The Lambda decides WHAT to do with each tile (job.adaptPlan) and what the
// finished file must be (job.outputSpec). This file never re-decides either.
//
//   outputSpec = {
//     marketplaceId, label, specVersion,
//     aspectRatio,                 ratio to ask the image model for (one it supports)
//     width, height,               exact delivery pixels
//     format: 'jpeg' | 'png',
//     maxBytes, minLongEdgePx,
//     main: { background: 'pure-white' | 'white-or-light-grey' | 'light-grey' | 'any', productFillPct },
//     rules: { main: '…', other: '…' }   standing rules, reused by later edits
//   }
// ──────────────────────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: process.env.AWS_REGION });

// A pixel counts as background when its darkest channel is at least this.
const WHITE_SNAP_AT = parseInt(process.env.ECOMM_WHITE_SNAP_AT || '244', 10);
// The corners must already be about this white before we treat a tile as "on white".
const WHITE_CORNER_MIN = parseInt(process.env.ECOMM_WHITE_CORNER_MIN || '236', 10);
// How far the re-frame may scale the product, relative to a plain resize.
const REFRAME_MIN = parseFloat(process.env.ECOMM_REFRAME_MIN || '0.6');
const REFRAME_MAX = parseFloat(process.env.ECOMM_REFRAME_MAX || '1.5');
const JPEG_STEPS = [92, 88, 82, 76, 70, 62];

/* ── the prompt for the model call ────────────────────────────────────────── */

/**
 * instruction   the requirement lines the Lambda wrote for THIS tile
 * role          'main' | 'other'
 * productCount  how many product photos follow the tile (0..3)
 */
function buildAdaptPrompt(instruction, { label = 'the target marketplace', role = 'other', productCount = 0 } = {}) {
  const total = 1 + productCount;
  const one = productCount === 1;
  const productLabel = productCount ? (one ? 'IMAGE 2' : `IMAGES 2–${total}`) : '';

  const intro = [
    `You are given ${total} image${total === 1 ? '' : 's'}.`,
    'IMAGE 1 is a finished marketplace listing tile. It is the subject of this task and the basis of the output.',
  ];
  if (productCount) {
    intro.push(
      `${productLabel} ${one ? 'is the original product photo' : 'are the original product photos'}, attached ONLY so you can ` +
      'see the product clearly: its shape, proportions, packaging, label artwork, logo, lettering, materials, colour and finish. ' +
      `Take nothing else from ${one ? 'it' : 'them'} — not the background, the crop, the angle or the lighting. ` +
      `Never paste ${one ? 'it' : 'them'} into the result and never add a second product.`
    );
  }

  const task = role === 'main'
    ? `Re-make IMAGE 1 as the MAIN listing image for ${label}. The main image is the one shoppers see in search results, so ${label} has strict rules for it.`
    : `Re-make IMAGE 1 so it meets the image rules of ${label}. It must stay the same tile: the same product, the same story, the same visual style and colour grade.`;

  const how = role === 'main'
    ? [
      'Show the product exactly as it is in IMAGE 1 — same pack, same angle, same label — complete and uncropped, sharp and evenly lit.',
      'Centre it. Leave an even margin on all four sides.',
      'Remove everything the requirements do not allow. Do not add anything new.',
    ]
    : [
      'Change only what the requirements above need. Everything else stays as it is in IMAGE 1.',
      'If the canvas shape changes, re-compose the layout for the new shape: move and re-space the elements, and extend the background naturally. Never stretch or squash anything. Never crop the product or cut off any text.',
      'Keep every piece of text that is allowed, word for word — same words, same language, same typeface and same order of importance. Do not add new text, claims, badges or icons.',
      'If a requirement removes an element, fill the space naturally so the tile still looks finished and balanced.',
    ];

  const product = productCount
    ? `The product must match ${productLabel} exactly: packaging, label artwork, logo, lettering and finish. Do not redraw or restyle it.`
    : 'Do not redraw or restyle the product: its packaging, label artwork, logo, lettering and finish must survive unchanged.';

  return [
    intro.join(' '),
    '',
    task,
    '',
    `REQUIREMENTS FOR ${String(label).toUpperCase()}`,
    String(instruction || '').trim(),
    '',
    'HOW TO DO IT',
    ...how.map((l) => `* ${l}`),
    `* ${product}`,
    '* Output one image only.',
  ].join('\n');
}

/** Appended to a customer's edit instruction on an adapted set, so the edit stays inside the rules. */
function withStandingRules(instruction, spec, role) {
  const rules = spec && spec.rules && String(spec.rules[role === 'main' ? 'main' : 'other'] || '').trim();
  if (!rules) return instruction;
  return `${instruction}\n\nThis tile is made for ${spec.label || 'a marketplace'} and must still meet these rules after the change:\n${rules}`;
}

/* ── reading the tile ─────────────────────────────────────────────────────── */

function parseS3Url(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (!/\.amazonaws\.com$/i.test(u.hostname)) return null;
  const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const host = u.hostname.split('.');
  const i = host.findIndex((p) => p === 's3' || p.startsWith('s3-'));
  if (i === -1 || !path) return null;
  if (i === 0) {
    const slash = path.indexOf('/');
    return slash < 1 ? null : { bucket: path.slice(0, slash), key: path.slice(slash + 1) };
  }
  return { bucket: host.slice(0, i).join('.'), key: path };
}

async function fetchBuffer(url) {
  let httpErr = '';
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
    if (resp.status === 200 && resp.data && resp.data.byteLength > 100) return Buffer.from(resp.data);
    httpErr = `http ${resp.status}`;
  } catch (e) {
    httpErr = e.message;
  }
  const loc = parseS3Url(url);
  if (!loc) throw new Error(`could not fetch the tile (${httpErr}) — ${String(url).split('?')[0]}`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
  return Buffer.from(await obj.Body.transformToByteArray());
}

/* ── pixel helpers (raw RGB, 3 channels) ──────────────────────────────────── */

function minChannelAt(data, w, x, y) {
  const o = (y * w + x) * 3;
  return Math.min(data[o], data[o + 1], data[o + 2]);
}

/** The darkest average of the four corner patches — "how white is the background". */
function cornerWhiteness(data, w, h) {
  const p = Math.max(4, Math.round(Math.min(w, h) * 0.02));
  const corners = [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]];
  let worst = 255;
  for (const [cx, cy] of corners) {
    let sum = 0;
    for (let y = cy; y < cy + p; y++) for (let x = cx; x < cx + p; x++) sum += minChannelAt(data, w, x, y);
    worst = Math.min(worst, sum / (p * p));
  }
  return worst;
}

/** Turns near-white into exact white, in place. */
function snapWhite(data) {
  for (let o = 0; o < data.length; o += 3) {
    if (data[o] >= WHITE_SNAP_AT && data[o + 1] >= WHITE_SNAP_AT && data[o + 2] >= WHITE_SNAP_AT) {
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
    }
  }
}

/**
 * Start and end of the real content along one axis. `counts[i]` is how many
 * non-white pixels line i has. Lines are grouped into runs (small breaks of up
 * to 0.5% of the axis are bridged); a run shorter than 1.5% of the axis is a
 * speck and is dropped; the span runs from the first kept run to the last. So a
 * dust dot cannot pull the box sideways, but a separate cap or applicator lying
 * next to the pack is kept.
 */
function contentSpan(counts, minCount) {
  const n = counts.length;
  const joinGap = Math.max(2, Math.round(n * 0.005));
  const minRun = Math.max(3, Math.round(n * 0.015));
  const runs = [];
  let start = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (counts[i] < minCount) continue;
    if (start === -1) { start = i; last = i; continue; }
    if (i - last > joinGap) { runs.push([start, last]); start = i; }
    last = i;
  }
  if (start !== -1) runs.push([start, last]);
  const kept = runs.filter(([a, b]) => b - a + 1 >= minRun);
  if (!kept.length) return null;
  return [kept[0][0], kept[kept.length - 1][1]];
}

/** The box around everything that is not background (specks ignored). */
function contentBox(data, w, h) {
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (minChannelAt(data, w, x, y) < WHITE_SNAP_AT) { rows[y]++; cols[x]++; }
    }
  }
  const ys = contentSpan(rows, 2);
  const xs = contentSpan(cols, 2);
  if (!ys || !xs) return null;
  return { left: xs[0], top: ys[0], width: xs[1] - xs[0] + 1, height: ys[1] - ys[0] + 1 };
}

const fillOf = (box, w, h) => Math.max(box.width / w, box.height / h);

/* ── encoding ─────────────────────────────────────────────────────────────── */

async function encode(raw, w, h, spec) {
  const img = () => sharp(raw, { raw: { width: w, height: h, channels: 3 } }).withMetadata({ density: 72 });
  const maxBytes = parseInt(spec.maxBytes, 10) || 0;

  if (spec.format === 'png') {
    const buffer = await img().png({ compressionLevel: 9 }).toBuffer();
    return { buffer, ext: 'png', contentType: 'image/png', quality: null };
  }
  let buffer = null, quality = JPEG_STEPS[0];
  for (const q of JPEG_STEPS) {
    quality = q;
    buffer = await img().jpeg({ quality: q, chromaSubsampling: q >= 88 ? '4:4:4' : '4:2:0', mozjpeg: true }).toBuffer();
    if (!maxBytes || buffer.length <= maxBytes) break;
  }
  return { buffer, ext: 'jpg', contentType: 'image/jpeg', quality };
}

/* ── the finishing pass ───────────────────────────────────────────────────── */

/**
 * Takes one tile (a URL or a Buffer) and returns the file the marketplace wants.
 * Never throws for a rule the tile does not meet — it reports it in `checks`.
 * It throws only when the image cannot be read or written at all.
 *
 * returns { buffer, ext, contentType, checks: [{ id, ok, detail }], ok }
 */
async function finishTile({ url, buffer: given, spec, isMain = false }) {
  if (!spec || !spec.width || !spec.height) throw new Error('finishTile: outputSpec has no width/height');
  const W = parseInt(spec.width, 10);
  const H = parseInt(spec.height, 10);
  const src = given || await fetchBuffer(url);
  const checks = [];

  const { data, info } = await sharp(src).rotate().flatten({ background: '#ffffff' })
    .toColorspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sw = info.width, sh = info.height;

  const mainRule = (spec.main && spec.main.background) || 'any';
  const wantWhite = isMain && mainRule === 'pure-white';
  const onWhite = cornerWhiteness(data, sw, sh) >= WHITE_CORNER_MIN;
  const targetFill = isMain && spec.main && parseInt(spec.main.productFillPct, 10) > 0
    ? parseInt(spec.main.productFillPct, 10) / 100 : 0;

  let out = null;          // raw RGB at W×H
  let note = '';

  // Main image on white: true 255 background, and the product re-framed to the asked fill.
  if (wantWhite && onWhite) {
    snapWhite(data);
    const box = targetFill ? contentBox(data, sw, sh) : null;
    if (box && box.width * box.height > sw * sh * 0.03) {
      const natural = Math.min(W / sw, H / sh);
      const wanted = targetFill * Math.min(W / box.width, H / box.height);
      const k = natural * Math.max(REFRAME_MIN, Math.min(REFRAME_MAX, wanted / natural));
      const nw = Math.min(W, Math.max(1, Math.round(box.width * k)));
      const nh = Math.min(H, Math.max(1, Math.round(box.height * k)));
      const piece = await sharp(data, { raw: { width: sw, height: sh, channels: 3 } })
        .extract(box).resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
      out = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
        .composite([{ input: piece, raw: { width: nw, height: nh, channels: 3 }, left: Math.floor((W - nw) / 2), top: Math.floor((H - nh) / 2) }])
        .removeAlpha().raw().toBuffer();
      note = `re-framed ×${(k / natural).toFixed(2)}`;
    }
  }

  // Everything else: a plain resize. Same shape → exact. Different shape → the
  // main image is padded with white, any other tile is centre-cropped.
  if (!out) {
    const drift = Math.abs((sw / sh) - (W / H)) / (W / H);
    const fit = drift <= 0.01 ? 'fill' : (wantWhite && onWhite ? 'contain' : 'cover');
    out = await sharp(data, { raw: { width: sw, height: sh, channels: 3 } })
      .resize(W, H, { fit, position: 'centre', background: '#ffffff', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
    if (fit === 'cover') {
      note = `cropped ${Math.round(drift * 100)}% to fit`;
      checks.push({ id: 'shape', ok: drift <= 0.08, detail: `source ${sw}×${sh} is a different shape — ${note}` });
    }
  }
  if (wantWhite && onWhite) snapWhite(out);

  const enc = await encode(out, W, H, spec);

  // ── measure what we are about to deliver ──
  const final = await sharp(enc.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const fw = final.info.width, fh = final.info.height;
  const long = Math.max(fw, fh);
  const minLong = parseInt(spec.minLongEdgePx, 10) || 0;
  const maxBytes = parseInt(spec.maxBytes, 10) || 0;

  checks.push({ id: 'size', ok: fw === W && fh === H && (!minLong || long >= minLong), detail: `${fw}×${fh} px${note ? ` (${note})` : ''}` });
  checks.push({ id: 'format', ok: true, detail: `${enc.ext === 'jpg' ? 'JPEG' : 'PNG'}, sRGB${enc.quality ? `, quality ${enc.quality}` : ''}` });
  checks.push({
    id: 'weight', ok: !maxBytes || enc.buffer.length <= maxBytes,
    detail: `${(enc.buffer.length / 1048576).toFixed(2)} MB${maxBytes ? ` of ${(maxBytes / 1048576).toFixed(0)} MB allowed` : ''}`,
  });

  if (isMain && mainRule !== 'any') {
    const white = Math.round(cornerWhiteness(final.data, fw, fh));
    // pure-white: exact. white-or-light-grey: anything pale. light-grey: pale but NOT white.
    const [lo, hi, want] = mainRule === 'pure-white' ? [254, 255, 'pure white (255)']
      : mainRule === 'light-grey' ? [195, 249, 'light grey, not white']
        : [215, 255, 'white or light grey'];
    const pass = white >= lo && white <= hi;
    checks.push({
      id: 'background', ok: pass,
      detail: pass ? want : `background measures ${white} of 255 — needs ${want}`,
    });
    if (targetFill && pass && mainRule === 'pure-white') {
      const box = contentBox(final.data, fw, fh);
      const pct = box ? Math.round(fillOf(box, fw, fh) * 100) : 0;
      const wantPct = Math.round(targetFill * 100);
      checks.push({ id: 'fill', ok: pct >= wantPct - 3, detail: `product fills ${pct}% of the frame (asks for ${wantPct}%)` });
    }
  }

  return { buffer: enc.buffer, ext: enc.ext, contentType: enc.contentType, checks, ok: checks.every((c) => c.ok) };
}

module.exports = {
  buildAdaptPrompt, withStandingRules, finishTile,
  // exported for tests
  cornerWhiteness, contentBox, snapWhite,
};