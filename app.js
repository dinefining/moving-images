const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const bake = document.createElement('canvas'), bctx = bake.getContext('2d'); // ∞-trail layer
let W, H, DPR;

// ---------- settings ----------
const S = {};
const QUALITY = 400; // long side of captured frames, px
const fmt = { trail: v => v > 300 ? '∞' : v, tilt: v => v + '%' };

// Sliders: the whole box is the track; grey fill shows the value.
// The label swaps to the value while you hover or drag.
for (const el of document.querySelectorAll('.slider')) {
  const { key, label } = el.dataset, min = +el.dataset.min, max = +el.dataset.max;
  el.innerHTML = '<i class="fill"></i><span></span>';
  const text = el.querySelector('span');
  Object.assign(el, { tabIndex: 0 });
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', min);
  el.setAttribute('aria-valuemax', max);
  let showing = false;
  const set = v => {
    S[key] = v = Math.round(Math.min(max, Math.max(min, v)));
    el.style.setProperty('--p', (v - min) / (max - min));
    el.setAttribute('aria-valuenow', v);
    text.textContent = showing ? `${label} ${(fmt[key] || String)(v)}` : label;
  };
  const show = on => { showing = on; set(S[key]); };
  const fromX = x => { const r = el.getBoundingClientRect(); set(min + (max - min) * (x - r.left) / r.width); };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); fromX(e.clientX); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) fromX(e.clientX); });
  el.addEventListener('pointerenter', () => show(true));
  el.addEventListener('pointerleave', () => show(false));
  el.addEventListener('focus', () => show(true));
  el.addEventListener('blur', () => show(false));
  el.addEventListener('keydown', e => {
    const step = Math.max(1, Math.round((max - min) / 50));
    const d = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); set(S[key] + d); }
  });
  set(+el.dataset.value);
}

for (const el of document.querySelectorAll('.toggle')) {
  const key = el.dataset.key;
  const set = on => { S[key] = on; el.classList.toggle('on', on); el.setAttribute('aria-pressed', on); };
  el.addEventListener('click', () => set(!S[key]));
  set(el.classList.contains('on'));
}

// Corner buttons open their sheets.
for (const [btn, sheet] of [['#menuBtn', '#menu'], ['#infoBtn', '#info']]) {
  $(btn).addEventListener('click', () => toggleSheet(btn, sheet));
}
function toggleSheet(btn, sheet, open = $(sheet).hidden) {
  $(sheet).hidden = !open;
  $(btn).setAttribute('aria-expanded', open);
}
const infinite = () => S.trail > 300;

// ---------- canvas sizing ----------
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
  const keep = document.createElement('canvas');
  keep.width = bake.width; keep.height = bake.height;
  if (bake.width && bake.height) keep.getContext('2d').drawImage(bake, 0, 0);
  for (const c of [cv, bake]) { c.width = Math.max(1, W * DPR); c.height = Math.max(1, H * DPR); }
  if (keep.width && keep.height) bctx.drawImage(keep, 0, 0);
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener('resize', resize); resize();

// ---------- frame extraction ----------
let frames = [], extracting = false, job = 0;
// The Upload box doubles as the status line and progress bar.
const status = t => $('#upload span').textContent = t;
const progress = p => $('#upload').style.setProperty('--p', p);

// `src` is an uploaded File or a video URL.
async function loadVideo(src) {
  const isFile = src instanceof Blob;
  if (!src || (isFile && !src.type.startsWith('video'))) { status('Not a video'); return; }
  const my = ++job;
  frames.forEach(f => f.close && f.close());
  frames = []; frameIdx = 0; clearAll();
  status('Loading'); progress(0);

  const v = document.createElement('video');
  v.id = 'hold'; v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = isFile ? URL.createObjectURL(src) : src;
  document.body.appendChild(v);
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('This browser can’t decode that video')); });
  } catch (err) { console.warn(err.message); status('Can’t read video'); v.remove(); return; }

  const k = Math.min(1, QUALITY / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(2, Math.round(v.videoWidth * k)), h = Math.max(2, Math.round(v.videoHeight * k));
  const maxFrames = Math.floor(600e6 / (w * h * 4)); // ~600 MB of decoded frames
  const opts = { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' };
  const alive = () => my === job && frames.length < maxFrames;
  const grab = async () => { const b = await createImageBitmap(v, opts); if (my === job) frames.push(b); else b.close(); };

  extracting = true;
  const t0 = performance.now();
  if ('requestVideoFrameCallback' in v) {
    // Play through once in real time, catching every presented frame.
    await new Promise(resolve => {
      let pending = Promise.resolve(), done = false;
      // Browsers pause hidden media in background tabs; nudge it back on whenever the page is visible.
      const resume = () => { if (!done && v.paused && !v.ended && document.visibilityState === 'visible') v.play().catch(() => {}); };
      const watchdog = setInterval(resume, 500);
      document.addEventListener('visibilitychange', resume);
      const finish = () => {
        done = true; v.pause(); clearInterval(watchdog);
        document.removeEventListener('visibilitychange', resume);
        resolve(pending);
      };
      const onFrame = (_, meta) => {
        if (done) return;
        if (!alive()) return finish();
        pending = pending.then(grab);
        if (isFinite(v.duration)) progress(meta.mediaTime / v.duration);
        status(`Loading ${frames.length}`);
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      v.onended = finish;
      v.play().catch(err => { console.warn(err.message); finish(); });
    });
  } else {
    // Fallback: seek through at 30 fps.
    for (let t = 0; t < v.duration && alive(); t += 1 / 30) {
      v.currentTime = t;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      await grab();
      progress(t / v.duration); status(`Loading ${frames.length}`);
    }
  }
  if (isFile) URL.revokeObjectURL(v.src);
  v.remove();
  if (my !== job) return;
  extracting = false; progress(0);
  // Once loaded, the box shows the video's name (click it to replace).
  const name = isFile ? src.name : decodeURIComponent(src.split('/').pop());
  status(name); $('#upload').title = `${name} — click to replace`;
  console.log(`extracted ${frames.length} frames (${w}×${h}${frames.length >= maxFrames ? ', memory cap hit' : ''}) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

$('#file').addEventListener('change', e => { loadVideo(e.target.files[0]); e.target.value = ''; });
addEventListener('dragover', e => { e.preventDefault(); $('#drop').hidden = false; });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#drop').hidden = true; });
addEventListener('drop', e => { e.preventDefault(); $('#drop').hidden = true; loadVideo(e.dataTransfer.files[0]); });

// ---------- trail ----------
let stamps = [], frameIdx = 0;
let last = null, carried = 0, dir = { x: 1, y: 0 };
const cursor = { x: 0, y: 0, in: false };
const dot = $('#dot');
let lastMove = 0, lastShrink = 0;

function stamp(x, y) {
  if (!frames.length) return;
  let a = Math.atan2(dir.y, dir.x);              // keep frames upright: fold into ±90°
  if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
  stamps.push({ x, y, a: a * S.tilt / 100, f: frameIdx, size: S.size });

  frameIdx += S.step;
  if (frameIdx >= frames.length) frameIdx = extracting ? frames.length - 1 : frameIdx % frames.length;

  const max = infinite() ? 200 : S.trail;
  while (stamps.length > max) {
    const s = stamps.shift();
    if (infinite()) drawStamp(bctx, s, 1);
  }
}

function moveTo(x, y) {
  cursor.x = x; cursor.y = y; cursor.in = true; lastMove = performance.now();
  if (!last) { last = { x, y }; carried = 0; stamp(x, y); return; }
  let dx = x - last.x, dy = y - last.y, d = Math.hypot(dx, dy);
  if (!d) return;
  dir.x = dir.x * 0.75 + (dx / d) * 0.25; dir.y = dir.y * 0.75 + (dy / d) * 0.25;
  while (carried + d >= S.spacing) {          // drop stamps at even intervals along the path
    const t = (S.spacing - carried) / d;
    const px = last.x + dx * t, py = last.y + dy * t;
    stamp(px, py);
    last = { x: px, y: py }; carried = 0;
    dx = x - px; dy = y - py; d = Math.hypot(dx, dy);
  }
  carried += d; last = { x, y };
}

cv.addEventListener('pointermove', e => {
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const p of evs.length ? evs : [e]) moveTo(p.clientX, p.clientY);
  dot.hidden = false;
  dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});
cv.addEventListener('pointerleave', () => { cursor.in = false; last = null; dot.hidden = true; });

function clearAll() {
  stamps = []; last = null;
  bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, bake.width, bake.height); bctx.restore();
}

// ---------- drawing ----------
function drawStamp(c, s, alpha, k = 1) {
  const img = frames[s.f]; if (!img) return;
  const w = s.size * k, h = w * img.height / img.width;
  c.save();
  c.globalAlpha = alpha;
  c.translate(s.x, s.y); c.rotate(s.a);
  c.drawImage(img, -w / 2, -h / 2, w, h);
  c.restore();
}

function render(now) {
  requestAnimationFrame(render);
  if (S.shrink && stamps.length > 1 && now - lastMove > 120 && now - lastShrink > 35) {
    stamps.shift(); lastShrink = now;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bake, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Fade and Scale taper the trail from the newest frame back; both are off for ∞, where old frames bake at full size.
  const n = stamps.length, fade = S.fade && !infinite(), scale = S.scale && !infinite();
  stamps.forEach((s, i) => {
    const age = (i + 1) / n; // 1 = newest
    drawStamp(ctx, s, fade ? 0.12 + 0.88 * age : 1, scale ? 0.2 + 0.8 * age : 1);
  });
  if (rec) rec.frame(now);
}
requestAnimationFrame(render);

// ---------- save / record ----------
function savePNG() {
  cv.toBlob(b => download(b, `moving-images-${Date.now()}.png`), 'image/png');
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Recording captures only the canvas (the dot and menus are separate DOM layers).
// Preferred path: WebCodecs H.264 + mp4-muxer → a real .mp4 in any modern browser.
// Fallback: MediaRecorder, which gives .mp4 where supported and .webm otherwise.
const REC_FPS = 30, REC_MAX = 2560;
let rec = null, recBusy = false;

async function startMp4() {
  if (!('VideoEncoder' in window) || !window.Mp4Muxer) return null;
  const k = Math.min(1, REC_MAX / Math.max(cv.width, cv.height));
  const w = Math.round(cv.width * k / 2) * 2, h = Math.round(cv.height * k / 2) * 2; // H.264 needs even sizes
  const config = { codec: 'avc1.640033', width: w, height: h, framerate: REC_FPS,
                   bitrate: Math.max(4e6, Math.round(w * h * REC_FPS * 0.12)) };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) return null;

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: REC_FPS },
    fastStart: 'in-memory',
  });
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => console.error(e) });
  enc.configure(config);
  const scaler = new OffscreenCanvas(w, h), sctx = scaler.getContext('2d');
  let t0 = null, next = 0, lastKey = -Infinity;

  return {
    frame(now) {
      if (t0 === null) t0 = now;
      const i = Math.floor((now - t0) * REC_FPS / 1000);   // frame slot on a fixed 30 fps clock
      if (i < next || enc.encodeQueueSize > 4) return;
      let src = cv;
      if (cv.width !== w || cv.height !== h) { sctx.drawImage(cv, 0, 0, w, h); src = scaler; }
      const vf = new VideoFrame(src, { timestamp: Math.round(i * 1e6 / REC_FPS), duration: Math.round(1e6 / REC_FPS) });
      const keyFrame = i - lastKey >= REC_FPS * 2;
      if (keyFrame) lastKey = i;
      enc.encode(vf, { keyFrame });
      vf.close();
      next = i + 1;
    },
    async stop() {
      await enc.flush(); enc.close(); muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
  };
}

function startMediaRecorder() {
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const chunks = [], mr = new MediaRecorder(cv.captureStream(REC_FPS), { mimeType: type, videoBitsPerSecond: 12e6 });
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.start();
  return {
    frame() {},
    stop: () => new Promise(res => { mr.onstop = () => res(new Blob(chunks, { type: type.split(';')[0] })); mr.stop(); }),
  };
}

async function toggleRecord() {
  if (recBusy) return;
  recBusy = true;
  const btn = $('#record'), label = btn.querySelector('span');
  try {
    if (rec) {
      const r = rec; rec = null;
      label.textContent = 'Saving';
      const blob = await r.stop();
      download(blob, `moving-images-${Date.now()}.${blob.type === 'video/mp4' ? 'mp4' : 'webm'}`);
      btn.classList.remove('on'); document.body.classList.remove('recording'); label.textContent = 'Record';
    } else {
      rec = (await startMp4().catch(e => { console.warn(e); return null; })) || startMediaRecorder();
      btn.classList.add('on'); document.body.classList.add('recording'); label.textContent = 'Stop';
    }
  } finally { recBusy = false; }
}

$('#clear').onclick = clearAll;
$('#save').onclick = savePNG;
$('#record').onclick = toggleRecord;
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { toggleSheet('#menuBtn', '#menu', false); toggleSheet('#infoBtn', '#info', false); }
  else if (k === 'h') toggleSheet('#menuBtn', '#menu');
  else if (k === 'c') clearAll();
  else if (k === 's') savePNG();
  else if (k === 'r') toggleRecord();
});
