'use strict';

// ------------------------------------------------------------------ helpers

const $ = id => document.getElementById(id);
const audio = $('audio');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = t => Math.round(t * 1000) / 1000;
const eq = (a, b) => Math.abs(a - b) < 1e-4;

function fmt(t, frac = false) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  let out = (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  if (frac) out += '.' + Math.floor((t % 1) * 10);
  return out;
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
}

async function poll(job, onlog) {
  for (;;) {
    const s = await api('GET', '/api/job/' + job);
    if (s.log) onlog(s.log);
    if (s.state === 'done') return s.result;
    if (s.state === 'error') throw new Error(s.log);
    await new Promise(r => setTimeout(r, 400));
  }
}

let sayTimer = null;
function say(msg, err) {
  clearTimeout(sayTimer);
  $('status').textContent = msg || '';
  $('status').className = err ? 'err' : '';
  if (msg && !err && !/…|\.\.\./.test(msg)) sayTimer = setTimeout(() => say(''), 5000);
}

// modal: ask(title, text, [{label, cls, value}]) -> Promise<value | null>
function ask(title, text, buttons) {
  return new Promise(resolve => {
    $('mtitle').textContent = title;
    $('mtext').textContent = text;
    const row = $('mbuttons');
    row.innerHTML = '';
    const close = v => { $('modal').hidden = true; removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.cls) el.className = b.cls;
      el.onclick = () => close(b.value);
      row.appendChild(el);
    }
    audio.pause();
    $('modal').hidden = false;
    addEventListener('keydown', onKey, true);
    row.lastChild.focus();
  });
}

const confirmAsk = (title, text, okLabel = 'Continue', cls = 'primary') =>
  ask(title, text, [{ label: 'Cancel', value: false }, { label: okLabel, cls, value: true }]);

// -------------------------------------------------------------------- state

let P = null;          // project as loaded from the server
let S = null;          // editable state: {gap, noise, splits, chapters, prefix}
let showNoise = 0;     // timestamp until which the silence threshold line is drawn
let saved = '';        // JSON of S at last load / export
let undoStack = [];
let peaks = null, pps = 100;
let sel = -1;          // selected split index
let stopAt = null;     // pause playback when currentTime passes this
let cards = [];        // chapter cards

const isDirty = () => !!S && JSON.stringify(S) !== saved;
const bounds = () => [0, ...S.splits, P.duration];
const DEFAULT_NAME = 'chapter';
const HUES = [210, 28, 150, 285, 48, 340, 185, 100, 250, 15];
const segColor = (i, a = 1) => `hsl(${HUES[i % HUES.length]} ${TH.segs || '70%'} ${TH.segl || '58%'} / ${a})`;
const isOn = c => c.enabled !== false;

function hasDownstreamWork() {
  const b = bounds();
  return S.chapters.some((c, i) => c.name || !isOn(c) || !eq(c.start, b[i]) || !eq(c.end, b[i + 1]));
}

function pushUndo() {
  undoStack.push(JSON.stringify({ S, sel }));
  if (undoStack.length > 100) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return;
  const st = JSON.parse(undoStack.pop());
  S = st.S; sel = clamp(st.sel, -1, S.splits.length - 1);
  render();
}

// Re-derive chapters after the splits changed. A chapter survives when one of its
// segment bounds is unchanged; a trim that sat on a moved bound follows the bound.
function reconcile(oldSplits, oldChapters) {
  const ob = [0, ...oldSplits, P.duration], nb = bounds(), used = new Set(), out = [];
  for (let i = 0; i < nb.length - 1; i++) {
    const lo = nb[i], hi = nb[i + 1];
    let j = oldChapters.findIndex((c, k) => !used.has(k) && (eq(ob[k], lo) || eq(ob[k + 1], hi)));
    if (j < 0) { out.push({ name: null, start: lo, end: hi, enabled: true }); continue; }
    used.add(j);
    const c = oldChapters[j];
    let start = eq(c.start, ob[j]) ? lo : clamp(c.start, lo, hi);
    let end = eq(c.end, ob[j + 1]) ? hi : clamp(c.end, lo, hi);
    if (end - start < 0.1) { start = lo; end = hi; }
    out.push({ name: c.name, start, end, enabled: isOn(c) });
  }
  S.chapters = out;
}

// Apply a change to the splits (fn mutates S.splits), then normalise and re-derive chapters.
function mutateSplits(fn) {
  pushUndo();
  const oldSplits = S.splits.slice(), oldCh = S.chapters.map(c => ({ ...c }));
  fn();
  const clean = [];
  for (const t of S.splits.map(t => clamp(round3(t), 0.05, P.duration - 0.05)).sort((a, b) => a - b)) {
    if (!clean.length || t - clean[clean.length - 1] >= 0.05) clean.push(t);
  }
  S.splits = clean;
  reconcile(oldSplits, oldCh);
  render();
}

// ------------------------------------------------------------- waveform view

class Wave {
  constructor(canvas, lo, hi) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.lo = lo; this.hi = hi; this.view = [lo, hi];
    this.minSpan = 1;
  }
  resize() {
    const r = this.cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (!r.width) return;
    this.cv.width = r.width * d; this.cv.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.w = r.width; this.h = r.height;
  }
  xOf(t) { return (t - this.view[0]) / (this.view[1] - this.view[0]) * this.w; }
  tOf(x) { return this.view[0] + x / this.w * (this.view[1] - this.view[0]); }
  clampView() {
    const span = clamp(this.view[1] - this.view[0], this.minSpan, this.hi - this.lo);
    const t0 = clamp(this.view[0], this.lo, this.hi - span);
    this.view = [t0, t0 + span];
  }
  zoomAt(t, f) {
    this.view = [t - (t - this.view[0]) * f, t + (this.view[1] - t) * f];
    this.clampView();
  }
  pan(dt) { this.view = [this.view[0] + dt, this.view[1] + dt]; this.clampView(); }
  fit() { this.view = [this.lo, this.hi]; }
  contains(t) { return t >= this.view[0] && t <= this.view[1]; }

  drawWave(color, mid = this.h / 2, amp = this.h / 2 - 8, t0 = -Infinity, t1 = Infinity) {
    if (!peaks) return;
    const c = this.ctx;
    c.fillStyle = color;
    const x0 = Math.max(0, Math.floor(this.xOf(t0))), x1 = Math.min(this.w, Math.ceil(this.xOf(t1)));
    for (let x = x0; x < x1; x++) {
      const a = Math.max(0, Math.floor(this.tOf(x) * pps));
      const b = Math.min(peaks.length, Math.max(a + 1, Math.floor(this.tOf(x + 1) * pps)));
      let v = 0;
      for (let i = a; i < b; i++) if (peaks[i] > v) v = peaks[i];
      const hh = Math.max(0.5, v / 255 * amp);
      c.fillRect(x, mid - hh, 1, hh * 2);
    }
  }
  drawTicks() {
    const c = this.ctx, span = this.view[1] - this.view[0];
    const steps = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find(s => span / s <= this.w / 70) || 3600;
    c.fillStyle = TH.tick; c.font = '10px ui-monospace, monospace'; c.textBaseline = 'bottom';
    for (let t = Math.ceil(this.view[0] / step) * step; t <= this.view[1]; t += step) {
      const x = this.xOf(t);
      c.fillRect(x, this.h - 6, 1, 6);
      c.fillText(fmt(t, step < 1), x + 3, this.h - 1);
    }
  }
  drawPlayhead(t) {
    if (!this.contains(t)) return;
    const c = this.ctx, x = this.xOf(t);
    c.strokeStyle = TH.ok; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h); c.stroke();
  }
  drawShade(t0, t1, color) {
    const x0 = clamp(this.xOf(t0), 0, this.w), x1 = clamp(this.xOf(t1), 0, this.w);
    if (x1 > x0) { this.ctx.fillStyle = color; this.ctx.fillRect(x0, 0, x1 - x0, this.h); }
  }
  // wheel: pinch zooms around the cursor, horizontal swipe / shift+wheel pans,
  // plain vertical scrolling is left to the page
  attachWheel(after) {
    this.cv.addEventListener('wheel', e => {
      if (!P?.analyzed) return;
      const span = this.view[1] - this.view[0];
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomAt(this.tOf(e.offsetX), Math.exp(e.deltaY * 0.012));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.pan((e.shiftKey ? e.deltaY : e.deltaX) / this.w * span * 1.5);
      } else return;
      after();
    }, { passive: false });
  }
}

// canvas colours follow the CSS theme
let TH = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  TH = { wave: v('--wave'), wave2: v('--wave2'), tick: v('--tick'), shade: v('--shade'),
         tint: v('--tint'), mark: v('--mark'), sel: v('--sel'), ok: v('--ok'),
         segs: v('--seg-s'), segl: v('--seg-l') };
}
readTheme();

// --------------------------------------------------------------- main timeline

const main = new Wave($('wave'), 0, 1);

function hitSplit(x) {
  let best = -1, bd = 7;
  S.splits.forEach((t, i) => { const d = Math.abs(main.xOf(t) - x); if (d < bd) { bd = d; best = i; } });
  return best;
}

function drawMain() {
  const c = main.ctx, w = main.w, h = main.h;
  if (!w) return;
  c.clearRect(0, 0, w, h);
  if (!P?.analyzed) return;

  const b = bounds();
  for (let i = 0; i < b.length - 1; i++) {
    main.drawShade(b[i], b[i + 1], segColor(i, 0.1));
    main.drawWave(segColor(i), h / 2, h / 2 - 16, b[i], b[i + 1]);
  }
  if (performance.now() < showNoise) {
    // silence threshold: peaks are scaled so 255 = the loudest sample (peak_db dBFS)
    const ratio = Math.pow(10, (S.noise - (P.peak_db ?? 0)) / 20), amp = (h / 2 - 16) * Math.min(1, ratio);
    c.strokeStyle = TH.sel; c.lineWidth = 1; c.setLineDash([4, 3]);
    for (const y of [h / 2 - amp, h / 2 + amp]) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.setLineDash([]);
    c.fillStyle = TH.sel; c.font = '11px ui-monospace, monospace'; c.textBaseline = 'bottom';
    c.fillText(`${S.noise} dB`, 6, h / 2 - amp - 3);
  }
  // trimmed-away audio and disabled chapters, painted over the wave
  S.chapters.forEach((ch, i) => {
    if (!isOn(ch)) { main.drawShade(b[i], b[i + 1], TH.shade); return; }
    main.drawShade(b[i], ch.start, TH.shade);
    main.drawShade(ch.end, b[i + 1], TH.shade);
  });
  main.drawTicks();

  S.splits.forEach((t, i) => {
    const x = main.xOf(t);
    if (x < -2 || x > w + 2) return;
    const on = i === sel;
    c.strokeStyle = on ? TH.sel : TH.mark; c.lineWidth = on ? 2.5 : 1.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    c.fillStyle = c.strokeStyle;
    c.fillRect(x - 5, 0, 10, 6);
    const room = (i + 1 < S.splits.length ? main.xOf(S.splits[i + 1]) : w) - x;
    if (room > 26) { c.font = '11px ui-monospace, monospace'; c.textBaseline = 'top'; c.fillText(String(i + 2), x + 6, 8); }
  });
  main.drawPlayhead(audio.currentTime || 0);
  $('axis').innerHTML = `<span>${fmt(main.view[0])}</span><span>${fmt(main.view[1])}</span>`;
}

let drag = null; // {idx, moved}
main.cv.addEventListener('pointerdown', e => {
  if (!P?.analyzed) return;
  const x = e.offsetX, hit = hitSplit(x);
  if (hit >= 0) {
    sel = hit; drag = { idx: hit, moved: false, pre: JSON.stringify(S) };
    seek(S.splits[hit]);
    main.cv.setPointerCapture(e.pointerId);
  } else {
    sel = -1; seek(main.tOf(x));
  }
  render(false);
});
main.cv.addEventListener('pointermove', e => {
  if (!P?.analyzed) return;
  if (drag) {
    S.splits[drag.idx] = clamp(main.tOf(e.offsetX), 0.05, P.duration - 0.05);
    drag.moved = true;
    audio.currentTime = S.splits[drag.idx];
    drawMain();
  } else {
    main.cv.style.cursor = hitSplit(e.offsetX) >= 0 ? 'ew-resize' : 'crosshair';
  }
});
main.cv.addEventListener('pointerup', () => {
  if (!drag) return;
  const t = round3(S.splits[drag.idx]), d = drag; drag = null;
  if (!d.moved) return;
  S = JSON.parse(d.pre); // rewind, then apply the move as one undoable step
  mutateSplits(() => { S.splits[d.idx] = t; });
  sel = S.splits.indexOf(t);
  render(false);
});
main.cv.addEventListener('dblclick', e => {
  if (!P?.analyzed) return;
  const hit = hitSplit(e.offsetX);
  if (hit >= 0) removeSplit(hit);
});
main.attachWheel(drawMain);

function seek(t) {
  stopAt = null;
  audio.currentTime = clamp(t, 0, P.duration - 0.01);
}

function addSplitAtPlayhead() {
  const t = round3(audio.currentTime);
  mutateSplits(() => S.splits.push(t));
  sel = S.splits.indexOf(t);
  render(false);
}

function removeSplit(i) {
  mutateSplits(() => S.splits.splice(i, 1));
  sel = -1; render(false);
}

function nudgeSplit(dt) {
  if (sel < 0) return;
  const t = round3(S.splits[sel] + dt);
  mutateSplits(() => { S.splits[sel] = t; });
  sel = S.splits.indexOf(clamp(t, 0.05, P.duration - 0.05));
  render(false);
}

function zoomMain(f) {
  const t = audio.currentTime || 0;
  main.zoomAt(t, f);
  if (!main.contains(t)) { const s = main.view[1] - main.view[0]; main.view = [t - s / 2, t + s / 2]; main.clampView(); }
  drawMain();
}

// --------------------------------------------------------------- chapter cards

function makeCard(i) {
  const b = bounds(), lo = b[i], hi = b[i + 1], ch = S.chapters[i];
  const el = document.createElement('div');
  el.className = 'chap';
  el.innerHTML = `
    <div class="top">
      <input type="checkbox" class="on" title="include in export" ${isOn(ch) ? 'checked' : ''}>
      <span class="dot"></span>
      <input class="name" placeholder="${DEFAULT_NAME}" value="${ch.name ? ch.name.replace(/"/g, '&quot;') : ''}">
      <span class="ext">.aac</span>
      <span class="meta"></span>
    </div>
    <canvas></canvas>
    <div class="tools">
      <button data-a="play" class="cplay" title="play this chapter from the playhead, stops at its end">▶︎ Play</button>
      <button data-a="reset" title="remove trims">reset trim</button>
      <button data-a="fit" title="show the whole chapter">fit</button>
      <div class="spacer"></div>
      <span class="t"></span>
    </div>`;
  const cv = el.querySelector('canvas'), wave = new Wave(cv, lo, hi);
  wave.minSpan = 0.5;
  const card = { el, wave, i, lo, hi };
  el.style.setProperty('--seg', segColor(i));
  el.classList.toggle('off', !isOn(ch));

  const meta = () => {
    const c = S.chapters[i];
    el.querySelector('.meta').innerHTML = `<b>${fmt(c.end - c.start)}</b> · ${fmt(c.start)} – ${fmt(c.end)}`;
    const ts = c.start - lo, te = hi - c.end;
    el.querySelector('.t').textContent = (ts > 0.001 || te > 0.001)
      ? `trimmed ${ts.toFixed(1)}s from start, ${te.toFixed(1)}s from end` : 'untrimmed';
    el.querySelector('[data-a=reset]').disabled = !(ts > 0.001 || te > 0.001);
  };

  card.draw = () => {
    const c = wave.ctx, w = wave.w, h = wave.h, cur = S.chapters[i];
    if (!w) return;
    c.clearRect(0, 0, w, h);
    wave.drawWave(segColor(i), h / 2, h / 2 - 12);
    wave.drawShade(lo, cur.start, TH.shade);
    wave.drawShade(cur.end, hi, TH.shade);
    wave.drawTicks();
    for (const [t, side] of [[cur.start, 1], [cur.end, -1]]) {
      const x = wave.xOf(t);
      if (x < -8 || x > w + 8) continue;
      c.fillStyle = TH.sel;
      c.fillRect(x - 1, 0, 2, h);
      c.fillRect(side > 0 ? x : x - 6, h / 2 - 12, 6, 24);
    }
    wave.drawPlayhead(audio.currentTime || 0);
  };
  card.redraw = () => { meta(); card.draw(); };

  // trim handles
  let dragging = null, dragPre = null; // 'start' | 'end', snapshot before the drag
  const hitHandle = x => {
    const cur = S.chapters[i];
    const ds = Math.abs(wave.xOf(cur.start) - x), de = Math.abs(wave.xOf(cur.end) - x);
    if (Math.min(ds, de) > 9) return null;
    return ds <= de ? 'start' : 'end';
  };
  cv.addEventListener('pointerdown', e => {
    const hnd = hitHandle(e.offsetX);
    if (hnd) { dragPre = JSON.stringify({ S, sel }); dragging = hnd; seek(S.chapters[i][hnd]); cv.setPointerCapture(e.pointerId); }
    else seek(wave.tOf(e.offsetX));
    stopAt = S.chapters[i].end;
    card.draw();
  });
  cv.addEventListener('pointermove', e => {
    if (dragging) {
      const cur = S.chapters[i], t = wave.tOf(e.offsetX);
      if (dragging === 'start') cur.start = clamp(t, lo, cur.end - 0.1);
      else cur.end = clamp(t, cur.start + 0.1, hi);
      audio.currentTime = cur[dragging];
      card.redraw();
    } else {
      cv.style.cursor = hitHandle(e.offsetX) ? 'ew-resize' : 'default';
    }
  });
  cv.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = null;
    const cur = S.chapters[i];
    cur.start = round3(cur.start); cur.end = round3(cur.end);
    if (JSON.stringify({ S, sel }) !== dragPre) { undoStack.push(dragPre); if (undoStack.length > 100) undoStack.shift(); }
    card.redraw(); drawMain(); markDirty(); $('undo').disabled = !undoStack.length;
  });
  wave.attachWheel(card.draw);

  el.querySelector('.name').addEventListener('input', e => {
    pushUndoOnce(`name${i}`);
    S.chapters[i].name = e.target.value.trim() || null;
    markDirty();
  });
  el.querySelector('.on').addEventListener('change', e => {
    pushUndo();
    S.chapters[i].enabled = e.target.checked;
    el.classList.toggle('off', !e.target.checked);
    drawMain(); markDirty(); updateCounts();
  });
  el.querySelector('.tools').addEventListener('click', e => {
    const a = e.target.dataset.a, cur = S.chapters[i];
    if (!a) return;
    if (a === 'play') {
      if (!audio.paused && lastCard === i) { audio.pause(); return; }
      const t = audio.currentTime;
      playRange(t >= cur.start && t < cur.end - 0.05 ? t : cur.start, cur.end);
    }
    else if (a === 'reset') { pushUndo(); cur.start = lo; cur.end = hi; card.redraw(); drawMain(); markDirty(); }
    else if (a === 'fit') { wave.fit(); card.draw(); }
  });
  return card;
}

let undoOnceKey = null;
function pushUndoOnce(key) {
  if (undoOnceKey === key) return;
  undoOnceKey = key; pushUndo();
}

function playRange(from, to) {
  audio.currentTime = from; stopAt = to;
  audio.play();
}

function renderCards() {
  const box = $('chapters');
  box.innerHTML = '';
  cards = S.chapters.map((_, i) => makeCard(i));
  for (const c of cards) box.appendChild(c.el);
  for (const c of cards) { c.wave.resize(); c.redraw(); }
}

// ------------------------------------------------------------------- render

function markDirty() {
  const d = isDirty();
  $('dirty').hidden = !d;
  document.title = (d ? '● ' : '') + 'booky' + (P ? ' – ' + P.name : '');
}

function updateCounts() {
  $('scount').textContent = S.splits.length;
  const off = S.chapters.filter(c => !isOn(c)).length;
  $('ccount').textContent = S.chapters.length + (off ? ` (${off} off)` : '');
}

function render(rebuildCards = true) {
  if (!S) return;
  updateCounts();
  $('gap').value = S.gap; $('gapv').textContent = (+S.gap).toFixed(1) + 's';
  $('noise').value = S.noise; $('noisev').textContent = S.noise + 'dB';
  $('prefix').checked = S.prefix !== false;
  $('delsplit').disabled = sel < 0;
  $('undo').disabled = !undoStack.length;
  if (rebuildCards) renderCards();
  drawMain();
  markDirty();
  undoOnceKey = null;
}

function renderProject() {
  $('pname').textContent = P.name;
  $('url').value = P.url || '';
  $('fetch').textContent = P.has_source ? 'Replace' : 'Fetch';
  $('export').disabled = !P.analyzed;
  $('step-split').classList.toggle('off', !P.analyzed);
  $('step-chapters').classList.toggle('off', !P.analyzed);
  $('clock').textContent = '0:00 / ' + fmt(P.duration || 0);

  const info = $('srcinfo');
  if (!P.has_source) info.textContent = 'No audio yet. Paste an HLS url and fetch it; the download is kept in the project so it only happens once.';
  else if (!P.analyzed) {
    info.innerHTML = 'Source audio is present but not indexed yet. <button id="analyze" class="primary">Index audio</button>';
    $('analyze').onclick = runAnalyze;
  } else {
    const when = P.fetched_at ? new Date(P.fetched_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'earlier';
    info.textContent = `${fmt(P.duration)} of audio, fetched ${when}. Fetching again replaces the source and resets splits and chapters.`;
    if (P.url) {
      const line = document.createElement('div');
      line.className = 'srcurl';
      line.innerHTML = `<span class="lbl">source</span><code></code><button id="copyurl" title="copy url">copy</button>`;
      line.querySelector('code').textContent = P.url;
      line.querySelector('button').onclick = async () => {
        try { await navigator.clipboard.writeText(P.url); say('url copied'); } catch { say('could not copy', true); }
      };
      info.appendChild(line);
    }
  }
  render();
}

// -------------------------------------------------------------------- tick

let lastCard = -1;
function setCardPlay(i, on) {
  const b = cards[i]?.el.querySelector('.cplay');
  if (b) b.textContent = on ? '❚❚ Pause' : '▶︎ Play';
}
function tick() {
  if (P?.analyzed && S) {
    const t = audio.currentTime || 0;
    if (stopAt !== null && t >= stopAt - 0.02) { audio.pause(); stopAt = null; }
    $('clock').textContent = fmt(t) + ' / ' + fmt(P.duration);
    if (!audio.paused && !main.contains(t)) {
      const s = main.view[1] - main.view[0];
      main.view = [t - s * 0.1, t + s * 0.9]; main.clampView();
    }
    drawMain();
    const b = bounds();
    let cur = 0;
    while (cur < b.length - 2 && t >= b[cur + 1]) cur++;
    if (lastCard >= 0 && lastCard !== cur && cards[lastCard]) { cards[lastCard].el.classList.remove('playing'); cards[lastCard].draw(); setCardPlay(lastCard, false); }
    if (cards[cur]) { cards[cur].el.classList.toggle('playing', !audio.paused); cards[cur].draw(); setCardPlay(cur, !audio.paused); }
    lastCard = cur;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ actions

function togglePlay() { audio.paused ? audio.play() : audio.pause(); }
audio.onplay = () => $('play').textContent = '❚❚ Pause';
audio.onpause = () => $('play').textContent = '▶︎ Play';

$('play').onclick = togglePlay;
$('addsplit').onclick = addSplitAtPlayhead;
$('delsplit').onclick = () => { if (sel >= 0) removeSplit(sel); };
$('undo').onclick = undo;
$('zoomin').onclick = () => zoomMain(0.5);
$('zoomout').onclick = () => zoomMain(2);
$('zoomfit').onclick = () => { main.fit(); drawMain(); };

$('gap').oninput = e => { S.gap = +e.target.value; $('gapv').textContent = S.gap.toFixed(1) + 's'; };
$('noise').oninput = e => { S.noise = +e.target.value; $('noisev').textContent = S.noise + 'dB'; showNoise = performance.now() + 1500; };
$('noise').addEventListener('pointerdown', () => { showNoise = Infinity; });
$('noise').addEventListener('pointerup', () => { showNoise = performance.now() + 1500; });

$('clearsplits').onclick = async () => {
  if (!S.splits.length) return;
  const ok = await confirmAsk('Remove all splits?',
    'The whole book becomes one chapter. Names and trims are reset. You can undo this.', 'Remove all', 'danger');
  if (!ok) return;
  mutateSplits(() => { S.splits = []; });
  sel = -1; render(false);
};

$('redetect').onclick = async () => {
  if (hasDownstreamWork()) {
    const ok = await confirmAsk('Re-detect splits?',
      'Chapters whose boundaries change will lose their name and trims.', 'Re-detect');
    if (!ok) return;
  }
  say('detecting…');
  try {
    const r = await api('POST', `/api/projects/${encodeURIComponent(P.name)}/detect`, { gap: S.gap, noise: S.noise });
    mutateSplits(() => { S.splits = r.splits; });
    sel = -1; render(false);
    say(`found ${r.splits.length} splits`);
  } catch (err) { say(err.message, true); }
};

addEventListener('keydown', e => {
  if (/input|select|textarea/i.test(e.target.tagName) || !$('modal').hidden) return;
  if (!P?.analyzed) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'm' || k === 'M') addSplitAtPlayhead();
  else if ((k === 'Backspace' || k === 'Delete') && sel >= 0) removeSplit(sel);
  else if ((k === 'z' || k === 'Z') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); }
  else if (k === '=' || k === '+') zoomMain(0.5);
  else if (k === '-' || k === '_') zoomMain(2);
  else if (k === '0') { main.fit(); drawMain(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const dir = k === 'ArrowLeft' ? -1 : 1;
    if (sel >= 0) nudgeSplit(dir * (e.shiftKey ? 0.5 : 0.05));
    else seek(audio.currentTime + dir * (e.shiftKey ? 30 : 5));
  } else if (k === 'Escape') { sel = -1; render(false); }
});

// ----------------------------------------------------------------- projects

async function refreshProjects() {
  const list = await api('GET', '/api/projects');
  const ul = $('plist');
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.className = P?.name === p.name ? 'on' : '';
    li.innerHTML = `<span class="n"></span><span class="d">${p.duration ? fmt(p.duration) : p.has_source ? '…' : ''}</span>
                    <button class="x" title="Delete project">×</button>`;
    li.querySelector('.n').textContent = p.name;
    li.onclick = () => openProject(p.name);
    li.querySelector('.x').onclick = e => { e.stopPropagation(); deleteProject(p.name); };
    ul.appendChild(li);
  }
}

// Returns true when it is ok to leave the current project.
async function guard() {
  if (!isDirty()) return true;
  const v = await ask('Unsaved changes', `"${P.name}" has changes that have not been exported.`, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Discard', cls: 'danger', value: 'discard' },
    { label: 'Export', cls: 'go', value: 'export' },
  ]);
  if (v === 'export') return exportProject();
  if (v !== 'discard') return false;
  S = JSON.parse(saved); undoStack = []; sel = -1; render(); // revert so the project is clean if we stay
  return true;
}

async function openProject(name, force = false) {
  if (!force && P?.name === name) return;
  if (!force && !(await guard())) return;
  audio.pause(); stopAt = null;
  say('');
  try {
    P = await api('GET', '/api/projects/' + encodeURIComponent(name));
  } catch (err) { say(err.message, true); return; }
  S = { gap: P.gap, noise: P.noise, splits: P.splits, chapters: P.chapters, prefix: P.prefix !== false };
  saved = JSON.stringify(S);
  undoStack = []; sel = -1; lastCard = -1; peaks = null;

  if (P.analyzed) {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/peaks`);
    pps = +r.headers.get('X-Peaks-Per-Sec') || 100;
    peaks = new Uint8Array(await r.arrayBuffer());
    audio.src = `/api/projects/${encodeURIComponent(name)}/audio`;
    main.lo = 0; main.hi = P.duration; main.fit();
  } else {
    audio.removeAttribute('src');
  }
  $('empty').hidden = true; $('pview').hidden = false;
  main.resize();
  renderProject();
  refreshProjects();
}

function closeProject() {
  P = S = null; peaks = null; audio.pause(); audio.removeAttribute('src');
  $('pview').hidden = true; $('empty').hidden = false;
  document.title = 'booky';
  refreshProjects();
}

$('new').onclick = async () => {
  if (!(await guard())) return;
  $('newform').hidden = false; $('newname').value = ''; $('newname').focus();
};
$('newname').addEventListener('keydown', e => { if (e.key === 'Escape') $('newform').hidden = true; });
$('newform').onsubmit = async e => {
  e.preventDefault();
  const name = $('newname').value.trim();
  if (!name) return;
  try {
    await api('POST', '/api/projects', { name });
    $('newform').hidden = true;
    await openProject(name, true);
    $('url').focus();
  } catch (err) { say(err.message, true); }
};

async function deleteProject(name) {
  const ok = await confirmAsk('Delete project?',
    `This removes "${name}" including its downloaded audio and exported chapters.`, 'Delete', 'danger');
  if (!ok) return;
  try {
    await api('DELETE', '/api/projects/' + encodeURIComponent(name));
    if (P?.name === name) closeProject(); else refreshProjects();
  } catch (err) { say(err.message, true); }
}

$('fetch').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) return say('paste a stream url first', true);
  if (P.has_source) {
    const ok = await confirmAsk('Replace source audio?',
      'The current audio, splits and chapters for this project will be replaced.', 'Replace', 'danger');
    if (!ok) return;
  }
  $('fetch').disabled = true;
  try {
    const { job } = await api('POST', `/api/projects/${encodeURIComponent(P.name)}/fetch`, { url });
    await poll(job, say);
    say('');
    await openProject(P.name, true);
  } catch (err) { say(err.message, true); }
  $('fetch').disabled = false;
};

async function runAnalyze() {
  $('analyze').disabled = true;
  try {
    const { job } = await api('POST', `/api/projects/${encodeURIComponent(P.name)}/analyze`);
    await poll(job, say);
    say('');
    await openProject(P.name, true);
  } catch (err) { say(err.message, true); }
}

async function exportProject() {
  if (!P?.analyzed) return false;
  $('export').disabled = true;
  try {
    const { job } = await api('POST', `/api/projects/${encodeURIComponent(P.name)}/export`, S);
    const r = await poll(job, say);
    saved = JSON.stringify(S); markDirty();
    say(`exported ${r.count} chapters to ${r.folder}`);
    return true;
  } catch (err) { say(err.message, true); return false; }
  finally { $('export').disabled = false; }
}
$('export').onclick = exportProject;
$('prefix').onchange = e => { S.prefix = e.target.checked; markDirty(); };
$('reveal').onclick = () => api('POST', `/api/projects/${encodeURIComponent(P.name)}/reveal`);

addEventListener('focusin', e => { if (/input|textarea/i.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range') audio.pause(); });
// the page itself never zooms: pinch and ⌘± are reserved for the timelines
addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) addEventListener(ev, e => e.preventDefault());
addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && ['=', '+', '-', '_', '0'].includes(e.key)) e.preventDefault(); }, true);
addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
addEventListener('resize', () => { main.resize(); drawMain(); for (const c of cards) { c.wave.resize(); c.draw(); } });

// ------------------------------------------------------------------- theme

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'light' ? '☾ Dark mode' : '☀ Light mode';
  try { localStorage.setItem('booky-theme', t); } catch {}
  readTheme();
  drawMain(); for (const c of cards) { c.el.style.setProperty('--seg', segColor(c.i)); c.draw(); }
}
$('theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
let theme = 'dark';
try { theme = localStorage.getItem('booky-theme') || theme; } catch {}
applyTheme(theme);

refreshProjects();
