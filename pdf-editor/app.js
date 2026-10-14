import * as pdfjsLib from './vendor/pdf.min.mjs';
import { replaceInPlace } from './inplace.js';
import { Spring, play, smoothScroll, stopScroll, reduced } from './motion.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const { PDFDocument, StandardFonts, rgb, LineCapStyle } = PDFLib;
const SCALE = 1.5;                         // CSS px per PDF point at 100% zoom
const $ = (id) => document.getElementById(id);
const el = { app: $('app'), stage: $('stage'), pages: $('pages'), thumbs: $('thumbs'), dock: $('dock'), ind: $('ind'),
  landing: $('landing'), hint: $('hint'), save: $('save'), toasts: $('toasts'), pager: $('pager') };

let version = 0, savedVersion = 0;
let origBytes = null, fileName = 'edited.pdf', pages = [], history = [], loadToken = 0;
let tool = 'edit', color = '#111111', sizes = { text: 14, draw: 3 }, pendingImage = null, current = -1;

// ---------------------------------------------------------------- fonts
function classify(realName = '', family = '') {
  const n = (realName + ' ' + family).toLowerCase();
  return { bold: /bold|black|heavy|semibold|demi/.test(n), italic: /italic|oblique/.test(n), mono: /courier|mono|consolas|typewriter/.test(n),
    serif: /times|serif|georgia|garamond|palatino|minion|cambria|book/.test(n) && !/sans/.test(n), label: realName.replace(/^[A-Z]{6}\+/, '') || family || 'default' };
}
function stdFont(f) {
  const S = StandardFonts;
  if (f.mono) return f.bold ? (f.italic ? S.CourierBoldOblique : S.CourierBold) : f.italic ? S.CourierOblique : S.Courier;
  if (f.serif) return f.bold ? (f.italic ? S.TimesRomanBoldItalic : S.TimesRomanBold) : f.italic ? S.TimesRomanItalic : S.TimesRoman;
  return f.bold ? (f.italic ? S.HelveticaBoldOblique : S.HelveticaBold) : f.italic ? S.HelveticaOblique : S.Helvetica;
}
const cssFont = (f, px, lh = 1) => `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${px}px/${lh} ${f.mono ? 'monospace' : f.serif ? 'serif' : 'sans-serif'}`;
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgb2hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- toasts
function toast(msg, kind = '', action) {
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  if (action) { const b = document.createElement('button'); b.className = 'ghost'; b.textContent = action.label; b.style.cssText = 'padding:3px 10px;color:var(--fg)'; b.onclick = () => { action.run(); dismiss(); }; t.append(b); }
  el.toasts.append(t);
  play(t, [{ opacity: 0, transform: 'translateY(18px) scale(.95)' }, { opacity: 1, transform: 'none' }], { spring: [300, 24] });
  const dismiss = () => play(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.97)' }], { duration: 200 }).then(() => t.remove());
  setTimeout(dismiss, action ? 9000 : 4200);
}

// ---------------------------------------------------------------- progress bar
const P = new Spring(0, { stiffness: 140, damping: 22 });
const progressEl = $('progress');
P.on((v) => { progressEl.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`; });
const progress = (v) => { progressEl.style.opacity = 1; P.to(v); };
const progressDone = async () => { P.to(1); await new Promise((r) => setTimeout(r, 380)); await play(progressEl, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }); P.snap(0); };

// ---------------------------------------------------------------- zoom (spring-driven, anchored at the pointer)
const Z = new Spring(1, { stiffness: 300, damping: 34 });
let curZ = 1, anchor = null;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
Z.on((z, done) => {
  const prev = curZ; curZ = z;
  el.pages.style.setProperty('--z', z);
  if (anchor && prev) {
    const k = z / prev;
    el.stage.scrollLeft = (el.stage.scrollLeft + anchor.x) * k - anchor.x;
    el.stage.scrollTop = (el.stage.scrollTop + anchor.y) * k - anchor.y;
  }
  if (done) { anchor = null; scheduleRes(80); }
});
function setZoom(t, at) {
  t = Math.min(4, Math.max(0.25, t));
  const r = el.stage.getBoundingClientRect();
  anchor = at ? { x: at.x - r.left, y: at.y - r.top } : { x: el.stage.clientWidth / 2, y: el.stage.clientHeight / 2 };
  $('zval').textContent = Math.round(t * 100) + '%';
  Z.to(t);
}
function fitZoom() {
  if (!pages.length) return 1;
  const cs = getComputedStyle(el.pages), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  return Math.min(1.5, Math.max(0.25, (el.stage.clientWidth - pad - 8) / (pages[0].w * SCALE)));
}
const stepZoom = (dir) => { const t = Z.target; setZoom(dir > 0 ? STEPS.find((s) => s > t * 1.02) ?? 4 : [...STEPS].reverse().find((s) => s < t / 1.02) ?? 0.25); };
$('zin').onclick = () => stepZoom(1); $('zout').onclick = () => stepZoom(-1); $('zval').onclick = () => setZoom(fitZoom());
el.stage.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); stopScroll();
  setZoom(Z.target * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.012)), { x: e.clientX, y: e.clientY });
}, { passive: false });

// two-finger pinch: direct manipulation, so it snaps instead of springing
const touches = new Map(); let pinch = null;
el.stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: Z.target }; }
});
el.stage.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (!pinch || touches.size !== 2) return;
  const [a, b] = [...touches.values()], r = el.stage.getBoundingClientRect();
  const t = Math.min(4, Math.max(0.25, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d));
  anchor = { x: (a[0] + b[0]) / 2 - r.left, y: (a[1] + b[1]) / 2 - r.top };
  $('zval').textContent = Math.round(t * 100) + '%'; Z.target = t; Z.snap(t);
});
const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
el.stage.addEventListener('pointerup', endTouch); el.stage.addEventListener('pointercancel', endTouch);

// ---------------------------------------------------------------- page rendering (crisp at every zoom, never blanks while re-rendering)
const dpr = () => window.devicePixelRatio || 1;
const wantF = (pg) => Math.max(1, Math.min(dpr() * Math.max(1, Z.target), 4, Math.sqrt(24e6 / (pg.w * pg.h * SCALE * SCALE))));
async function renderPage(pg, f) {
  const token = ++pg.rtoken;
  const c = document.createElement('canvas');
  c.width = Math.round(pg.w * SCALE * f); c.height = Math.round(pg.h * SCALE * f);
  pg.task?.cancel();
  const task = pg.page.render({ canvasContext: c.getContext('2d'), viewport: pg.page.getViewport({ scale: SCALE * f }) });
  pg.task = task;
  try { await task.promise; } catch { return false; }
  if (token !== pg.rtoken) return false;
  if (pg.canvas) pg.canvas.replaceWith(c); else pg.sheet.prepend(c);
  pg.canvas = c; pg.f = f;
  return true;
}
async function loadItems(pg) {
  const vp = pg.page.getViewport({ scale: 1 });
  const tc = await pg.page.getTextContent(), seen = new Map();
  pg.items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    let real = ''; try { real = pg.page.commonObjs.get(it.fontName).name || ''; } catch {}
    const occ = seen.get(it.str) || 0; seen.set(it.str, occ + 1);
    return { occ, str: it.str, x: it.transform[4], base: vp.height - it.transform[5], w: it.width, size: Math.hypot(it.transform[0], it.transform[1]),
      font: classify(real, tc.styles[it.fontName]?.fontFamily || '') };
  });
  for (const it of pg.items) {
    const h = document.createElement('div');
    h.className = 'hit';
    Object.assign(h.style, { left: it.x * SCALE + 'px', top: (it.base - it.size * 0.85) * SCALE + 'px', width: it.w * SCALE + 'px', height: it.size * 1.1 * SCALE + 'px' });
    h.addEventListener('click', (e) => { if (tool === 'edit') { e.stopPropagation(); editItem(pg, it); } });
    h.addEventListener('pointerenter', () => setHint('Click to edit. This font and size are kept.', `${it.font.label} · ${+it.size.toFixed(1)} pt`));
    h.addEventListener('pointerleave', () => setHint(TOOLS[0].hint));
    it.hit = h; pg.hitsEl.append(h);
  }
  applyTool(pg);
}
let resTimer, resBusy = false;
const scheduleRes = (ms = 160) => { clearTimeout(resTimer); resTimer = setTimeout(ensureRes, ms); };
async function ensureRes() {
  if (resBusy) return scheduleRes(120);
  resBusy = true;
  try {
    const tok = loadToken, sr = el.stage.getBoundingClientRect();
    for (const pg of pages) {
      if (tok !== loadToken) return;
      const r = pg.el.getBoundingClientRect();
      if (r.bottom < sr.top - 3 * sr.height || r.top > sr.bottom + 3 * sr.height) { if (pg.canvas) { pg.task?.cancel(); pg.rtoken++; pg.canvas.remove(); pg.canvas = null; pg.f = 0; } continue; }
      if (r.bottom < sr.top - 500 || r.top > sr.bottom + 500) continue;
      const f = wantF(pg);
      if (!pg.f || pg.f < f * 0.85 || pg.f > f * 2.2) await renderPage(pg, f);
      if (pg.f && !pg.items) await loadItems(pg);
    }
  } finally { resBusy = false; }
}

// sample the rendered page for background + ink colour
function sample(pg, x, y, w, h) {
  const d = pg.canvas.width / pg.w;
  const sx = Math.max(0, Math.floor(x * d)), sy = Math.max(0, Math.floor(y * d));
  const sw = Math.max(1, Math.min(pg.canvas.width - sx, Math.ceil(w * d))), sh = Math.max(1, Math.min(pg.canvas.height - sy, Math.ceil(h * d)));
  const px = pg.canvas.getContext('2d').getImageData(sx, sy, sw, sh).data, counts = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3), c = counts.get(k) || [0, 0, 0, 0];
    c[0]++; c[1] += px[i]; c[2] += px[i + 1]; c[3] += px[i + 2]; counts.set(k, c);
  }
  let best = null; for (const c of counts.values()) if (!best || c[0] > best[0]) best = c;
  const bg = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];   // mean of the dominant bin, so white stays #ffffff
  let ink = bg, far = -1;
  for (let i = 0; i < px.length; i += 4) { const dist = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]); if (dist > far) { far = dist; ink = [px[i], px[i + 1], px[i + 2]]; } }
  return { bg: rgb2hex(bg), ink: rgb2hex(ink) };
}

// ---------------------------------------------------------------- loading
async function load(bytes = origBytes, name) {
  const token = ++loadToken;
  if (name) fileName = name.replace(/\.pdf$/i, '') + '-edited.pdf';
  origBytes = bytes;
  progress(0.08);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes.slice(), standardFontDataUrl: './vendor/standard_fonts/', cMapUrl: './vendor/cmaps/', cMapPacked: true }).promise;
  } catch (err) {
    progressDone();
    toast(err?.name === 'PasswordException' ? 'This PDF is password protected. Remove the password and try again.' : 'That file could not be opened as a PDF.', 'err');
    return false;
  }
  if (token !== loadToken) return;
  const wasEmpty = el.app.dataset.state === 'empty';
  pages.forEach((p) => p.task?.cancel()); pages = []; history = []; current = -1;
  el.pages.replaceChildren(); el.thumbs.replaceChildren();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (token !== loadToken) return;
    const vp = page.getViewport({ scale: 1 });
    const pe = document.createElement('div'); pe.className = 'page'; pe.style.opacity = 0;
    pe.style.setProperty('--bw', vp.width * SCALE); pe.style.setProperty('--bh', vp.height * SCALE);
    const sheet = document.createElement('div'), layer = document.createElement('div'), opsEl = document.createElement('div'), hitsEl = document.createElement('div');
    sheet.className = 'sheet'; layer.className = 'layer'; hitsEl.className = 'layer'; opsEl.className = 'layer';
    layer.append(opsEl, hitsEl); sheet.append(layer); pe.append(sheet); el.pages.append(pe);
    const pg = { page, w: vp.width, h: vp.height, el: pe, sheet, layer, opsEl, hitsEl, canvas: null, f: 0, rtoken: 0, ops: [], items: null };
    pages.push(pg); wirePage(pg);
    progress(0.08 + 0.7 * (i / doc.numPages));
  }
  // switch to the editor UI
  el.app.dataset.state = 'ready';
  const z = fitZoom(); anchor = null; Z.snap(z); $('zval').textContent = Math.round(z * 100) + '%';
  el.stage.scrollTop = 0; el.stage.scrollLeft = 0;
  $('docname').textContent = fileName.replace(/-edited\.pdf$/, '') + '.pdf';
  ['doc', 'zoom', 'changes', 'save'].forEach((id) => ($(id).hidden = false));
  version = savedVersion = 0; closePanel();
  $('pall').textContent = pages.length;
  updateEdits(false); setTool(tool, true);
  if (wasEmpty) enterUI();
  await ensureRes();
  progress(0.95);
  pages.forEach((pg, i) => play(pg.el, [{ opacity: 0, transform: 'translateY(34px) scale(.965)' }, { opacity: 1, transform: 'none' }], { spring: [190, 22], delay: Math.min(i, 5) * 80 }));
  pages.forEach((pg) => { if (pg.el.style.opacity === '0') pg.el.style.opacity = ''; });
  progressDone();
  buildThumbs(token);
  onScroll();
  return true;
}
async function enterUI() {
  play(el.landing, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.04) translateY(-14px)' }], { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)' }).then(() => (el.landing.hidden = true));
  play(el.dock, [{ opacity: 0, transform: 'translateX(-30px) scale(.9)' }, { opacity: 1, transform: 'none' }], { spring: [260, 20], delay: 220 });
  moveInd(true);
}
function buildThumbs(token) {
  const tw = 108, io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const pg = en.target._pg; io.unobserve(en.target);
      if (token !== loadToken || pg.thumbDone) continue;
      pg.thumbDone = true;
      const c = pg.thumb.firstElementChild;
      pg.page.render({ canvasContext: c.getContext('2d'), viewport: pg.page.getViewport({ scale: (tw * dpr()) / pg.w }) }).promise.catch(() => {});
    }
  }, { root: el.thumbs, rootMargin: '400px 0px' });
  pages.forEach((pg, i) => {
    const b = document.createElement('button');
    b.className = 'thumb'; b.setAttribute('aria-label', 'Go to page ' + (i + 1));
    const c = document.createElement('canvas');
    c.width = Math.round(tw * dpr()); c.height = Math.round(pg.h * (tw / pg.w) * dpr()); c.style.aspectRatio = `${pg.w}/${pg.h}`;
    const lbl = document.createElement('span'); lbl.textContent = i + 1;
    b.append(c, lbl); el.thumbs.append(b); pg.thumb = b; b._pg = pg;
    b.onclick = () => smoothScroll(el.stage, pg.el.offsetTop - 22 * curZ);
    if (i < 12) play(b, [{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { spring: [260, 24], delay: i * 45 });
    io.observe(b);
  });
  markCurrent(true);
}

// ---------------------------------------------------------------- current page + pager roll
let scrollRaf = 0;
function onScroll() {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!pages.length) return;
    const sr = el.stage.getBoundingClientRect(); let best = 0, bestV = -1;
    pages.forEach((pg, i) => { const r = pg.el.getBoundingClientRect(); const v = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top); if (v > bestV) { bestV = v; best = i; } });
    if (best !== current) { const dir = best > current ? 1 : -1; current = best; markCurrent(false, dir); }
  });
  scheduleRes(90);
}
function markCurrent(force, dir = 1) {
  pages.forEach((pg, i) => pg.thumb?.classList.toggle('on', i === current));
  const t = pages[current]?.thumb;
  if (t) el.thumbs.scrollTo({ top: t.offsetTop - (el.thumbs.clientHeight - t.offsetHeight) / 2, behavior: force || reduced ? 'auto' : 'smooth' });
  const roll = el.pager.querySelector('.roll'), old = roll.firstElementChild;
  if (old.textContent == current + 1) return;
  if (force) { old.textContent = current + 1; return; }
  const n = document.createElement('b'); n.textContent = current + 1;
  Object.assign(n.style, { position: 'absolute', left: 0, top: 0 }); roll.append(n);
  play(old, [{ transform: 'none', opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], { duration: 260 }).then(() => old.remove());
  play(n, [{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { spring: [320, 26] }).then(() => { n.style.position = ''; });
}
el.stage.addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', () => { scheduleRes(200); });

// ---------------------------------------------------------------- overlay ops
function drawLayer(pg) {
  pg.opsEl.replaceChildren();
  const S = SCALE;
  pg.ops.forEach((op) => {
    const n = document.createElement('div'); n.className = 'op ' + op.t; n._op = op;
    const box = (x, y, w, h) => Object.assign(n.style, { left: x * S + 'px', top: y * S + 'px', width: w * S + 'px', height: h * S + 'px' });
    if (op.t === 'cover') { box(op.x, op.y, op.w, op.h); n.style.background = op.color; }
    else if (op.t === 'replace') {
      box(op.x - 1, op.cy, op.w + 2, op.ch); n.style.left = (op.x - 1) * S + 'px'; n.style.top = op.cy * S + 'px'; n.style.background = op.bg;
      const t = document.createElement('div'); t.textContent = op.str;
      Object.assign(t.style, { position: 'absolute', left: S + 'px', top: (op.base - op.cy - op.size * 0.8) * S + 'px', font: cssFont(op.font, op.size * S), color: op.color });
      n.append(t);
    } else if (op.t === 'text') {
      Object.assign(n.style, { left: op.x * S + 'px', top: op.y * S + 'px', color: op.color, font: cssFont(op.font, op.size * S, 1.2) }); n.textContent = op.str;
    } else if (op.t === 'image') {
      box(op.x, op.y, op.w, op.h); const im = document.createElement('img'); im.src = op.url; im.style.cssText = 'width:100%;height:100%'; n.append(im);
    } else if (op.t === 'draw') {
      Object.assign(n.style, { left: 0, top: 0, width: '100%', height: '100%' });
      n.innerHTML = `<svg width="100%" height="100%" style="position:absolute;left:0;top:0;overflow:visible"><polyline fill="none" stroke="${op.color}" stroke-width="${op.width * S}" stroke-linecap="round" stroke-linejoin="round" points="${op.pts.map((p) => p[0] * S + ',' + p[1] * S).join(' ')}"/></svg>`;
    }
    pg.opsEl.append(n);
    if (op.t === 'replace' || op.t === 'text') {
      const m = document.createElement('span'); m.className = 'mark'; m.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 15.5l6-7 6 7"/></svg>'; m.setAttribute('aria-hidden', 'true');
      m.style.top = (op.t === 'replace' ? op.base - op.size * 0.35 : op.y + op.size * 0.6) * S + 'px';
      pg.opsEl.append(m);
      if (op.fresh) play(m, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'none' }], { spring: [520, 18], delay: 80 });
    }
    if (op.fresh) { op.fresh = false; if (op.t !== 'draw') play(n, [{ opacity: 0, transform: 'scale(.93)' }, { opacity: 1, transform: 'none' }], { spring: [420, 24] }); }
  });
  applyTool(pg);
}
const KIND = { replace: 'edit', text: 'text', cover: 'cover', draw: 'draw', image: 'image' };
const dirty = () => history.length > 0 && version !== savedVersion;
function updateEdits(bump = true) {
  if (bump) version++;
  const n = history.length, chip = $('changes'), cnt = $('ccount'), prev = cnt.textContent;
  cnt.textContent = n; $('clabel').textContent = n === 1 ? 'change' : 'changes';
  chip.classList.toggle('dirty', dirty());
  if (prev !== String(n)) play(cnt, [{ transform: 'scale(1.35)' }, { transform: 'none' }], { spring: [520, 18] });
  if (el.save.dataset.s !== 'busy') el.save.disabled = !n;
  pages.forEach((pg) => { if (!pg.thumb) return; let b = pg.thumb.querySelector('i'); const k = pg.ops.length;
    if (!k) { b?.remove(); return; } if (!b) { b = document.createElement('i'); pg.thumb.append(b); play(b, [{ transform: 'scale(0)' }, { transform: 'none' }], { spring: [500, 20] }); } b.textContent = k; });
  if (!$('panel').hidden) renderPanel();
}
function addOp(pg, op) { op.fresh = true; pg.ops.push(op); history.push([pg, op]); drawLayer(pg); updateEdits(); }
function removeOp(pg, op) { pg.ops = pg.ops.filter((o) => o !== op); history = history.filter(([, o]) => o !== op); drawLayer(pg); updateEdits(); }
const opY = (op) => op.t === 'replace' ? op.cy : op.t === 'draw' ? Math.min(...op.pts.map((p) => p[1])) : op.y;
function describe(op) {
  const q = (t) => '“' + (t.length > 42 ? t.slice(0, 40) + '…' : t) + '”';
  if (op.t === 'replace') return op.str.trim() ? { main: q(op.str), was: op.orig } : { main: 'Deleted text', was: op.orig };
  if (op.t === 'text') return { main: 'Added ' + q(op.str) };
  return { main: { cover: 'White-out', draw: 'Drawing', image: 'Image' }[op.t] };
}
function renderPanel() {
  const list = $('plist'); list.replaceChildren();
  $('pempty').hidden = history.length > 0;
  $('pmeta').textContent = history.length ? (dirty() ? 'not saved' : 'saved') : '';
  history.forEach(([pg, op]) => {
    const li = document.createElement('li'), d = describe(op), t = document.createElement('span'), b = document.createElement('b'), sm = document.createElement('small');
    const tdef = TOOLS.find((x) => x.id === KIND[op.t]); const k = document.createElement('span'); k.className = 'k'; k.innerHTML = tdef.icon;
    t.className = 't'; b.textContent = d.main; t.append(b);
    if (d.was) { const s2 = document.createElement('s'); s2.textContent = d.was; const w = document.createElement('small'); w.append('was ', s2); t.append(w); }
    sm.textContent = `page ${pages.indexOf(pg) + 1}` + (op.t === 'replace' ? ` · ${op.font.label} · ${+op.size.toFixed(1)} pt` : ''); t.append(sm);
    const x = document.createElement('button'); x.setAttribute('aria-label', 'Remove this change'); x.innerHTML = I('<path d="M6 6l12 12M18 6L6 18"/>');
    x.onclick = (e) => { e.stopPropagation(); play(li, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 160 }).then(() => removeOp(pg, op)); };
    li.onclick = () => { closePanel(); smoothScroll(el.stage, Math.max(0, pg.el.offsetTop + opY(op) * SCALE * curZ - el.stage.clientHeight / 3));
      setTimeout(() => { const n = [...pg.opsEl.children].find((c) => c._op === op); n?.classList.remove('flash'); void n?.offsetWidth; n?.classList.add('flash'); }, 450); };
    li.append(k, t, x); list.append(li);
  });
}
function openPanel() {
  renderPanel(); const p = $('panel'); p.hidden = false; $('changes').setAttribute('aria-expanded', 'true');
  play(p, [{ opacity: 0, transform: 'translateY(-8px) scale(.96)' }, { opacity: 1, transform: 'none' }], { spring: [420, 28] });
  [...$('plist').children].slice(0, 10).forEach((li, i) => play(li, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: [380, 26], delay: 30 + i * 28 }));
}
function closePanel() {
  const p = $('panel'); if (p.hidden) return; $('changes').setAttribute('aria-expanded', 'false');
  play(p, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.97)' }], { duration: 150 }).then(() => { p.hidden = true; p.style.opacity = ''; p.style.transform = ''; });
}
$('changes').onclick = (e) => { e.stopPropagation(); $('panel').hidden ? openPanel() : closePanel(); };
addEventListener('pointerdown', (e) => { if (!$('panel').hidden && !e.target.closest('#panel,#changes')) closePanel(); });

function openEditor(pg, { x, y, str, size, color, font, onDone, width }) {
  const ed = document.createElement('div');
  ed.className = 'editor'; ed.contentEditable = 'plaintext-only'; ed.textContent = str; ed.setAttribute('role', 'textbox');
  Object.assign(ed.style, { left: x * SCALE - 1 + 'px', top: y * SCALE - 1 + 'px', color, font: cssFont(font, size * SCALE, 1.2) });
  if (width) ed.style.minWidth = width * SCALE + 'px';
  pg.layer.append(ed);
  play(ed, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { spring: [500, 28] });
  ed.focus(); document.getSelection().selectAllChildren(ed);
  let done = false;
  const finish = (commit) => { if (done) return; done = true; const v = ed.textContent; ed.remove(); if (commit) onDone(v); };
  ed.addEventListener('blur', () => finish(true));
  ed.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') finish(false); else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ed.blur(); } });
  ed.addEventListener('pointerdown', (e) => e.stopPropagation());
}
function editItem(pg, it) {
  const top = it.base - it.size * 0.85, { bg, ink } = sample(pg, it.x, top, it.w, it.size * 1.1);
  openEditor(pg, { x: it.x, y: it.base - it.size * 0.8, str: it.str, size: it.size, color: ink, font: it.font, width: it.w, onDone: (v) => {
    if (v === it.str) return;
    addOp(pg, { t: 'replace', item: it, x: it.x, cy: top, ch: it.size * 1.15, w: Math.max(it.w, 1), base: it.base, size: it.size, str: v, orig: it.str, occ: it.occ, color: ink, bg, font: it.font });
  } });
}

// ---------------------------------------------------------------- pointer tools
function wirePage(pg) {
  const pos = (e) => { const r = pg.sheet.getBoundingClientRect(), k = SCALE * curZ; return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]; };
  pg.sheet.addEventListener('pointerdown', async (e) => {
    if (e.target.closest('.editor') || e.button > 0 || !e.isPrimary || touches.size > 1) return;
    const [x, y] = pos(e);
    if (tool === 'erase') {
      const n = e.target.closest('.op'); if (!n || !n._op) return;
      const op = n._op;
      await play(n, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 150 });
      removeOp(pg, op);
    } else if (tool === 'text') {
      e.preventDefault(); const size = sizes.text, c = color;
      openEditor(pg, { x, y, str: '', size, color: c, font: classify('', 'sans-serif'), onDone: (v) => v.trim() && addOp(pg, { t: 'text', x, y, size, color: c, font: classify('', 'sans-serif'), str: v }) });
    } else if (tool === 'cover') {
      const rb = document.createElement('div'); rb.className = 'rubber'; pg.layer.append(rb);
      const move = (m) => { const [mx, my] = pos(m); Object.assign(rb.style, { left: Math.min(x, mx) * SCALE + 'px', top: Math.min(y, my) * SCALE + 'px', width: Math.abs(mx - x) * SCALE + 'px', height: Math.abs(my - y) * SCALE + 'px' }); };
      const up = (m) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); rb.remove();
        const [mx, my] = pos(m), w = Math.abs(mx - x), h = Math.abs(my - y);
        if (w > 2 && h > 2) addOp(pg, { t: 'cover', x: Math.min(x, mx), y: Math.min(y, my), w, h, color: sample(pg, Math.min(x, mx) - 2, Math.min(y, my) - 2, 4, 4).bg }); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    } else if (tool === 'draw') {
      const op = { t: 'draw', pts: [[x, y]], color, width: sizes.draw }; pg.ops.push(op);
      const move = (m) => { op.pts.push(pos(m)); drawLayer(pg); };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); history.push([pg, op]); updateEdits(); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    } else if (tool === 'image') { pendingImage = { pg, x, y }; $('imgfile').click(); }
  });
}
$('imgfile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !pendingImage) return;
  const url = URL.createObjectURL(f), img = new Image(); img.src = url;
  try { await img.decode(); } catch { return toast('That image could not be read. Use a PNG or JPG.', 'err'); }
  const w = Math.min(200, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
  addOp(pendingImage.pg, { t: 'image', x: pendingImage.x, y: pendingImage.y, w, h, url, bytes: new Uint8Array(await f.arrayBuffer()), png: f.type === 'image/png' });
  pendingImage = null;
});

// ---------------------------------------------------------------- dock, inspector
const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const TOOLS = [
  { id: 'edit', key: 'V', label: 'Edit text', hint: 'Click any text to change it. Its font and size are kept.', icon: I('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>') },
  { id: 'text', key: 'T', label: 'Add text', hint: 'Click where the text should go, type, press Enter.', ctl: 'text', icon: I('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>') },
  { id: 'cover', key: 'W', label: 'White-out', hint: 'Drag over anything you want to hide.', icon: I('<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M8 15l8-6"/>') },
  { id: 'draw', key: 'D', label: 'Draw', hint: 'Draw freehand. Pick a colour and width below.', ctl: 'draw', icon: I('<path d="M3 17c3-8 5-8 7-3s4 5 7-3 3-3 4-1"/>') },
  { id: 'image', key: 'I', label: 'Image', hint: 'Click where the image should go, then choose a PNG or JPG.', icon: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>') },
  { id: 'erase', key: 'E', label: 'Remove edit', hint: 'Click one of your edits to remove it.', icon: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>') },
];
TOOLS.forEach((t) => {
  const b = document.createElement('button'); b.dataset.tool = t.id; b.dataset.tip = `${t.label}  ${t.key}`; b.setAttribute('aria-label', t.label); b.innerHTML = t.icon;
  b.onclick = () => setTool(t.id); el.dock.append(b);
});
el.dock.append(document.createElement('hr'));
{ const u = document.createElement('button'); u.id = 'undo'; u.dataset.tip = 'Undo  Ctrl Z'; u.setAttribute('aria-label', 'Undo'); u.innerHTML = I('<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>'); u.onclick = undo; el.dock.append(u); }

const SW = ['#111111', '#0b7a75', '#1d4ed8', '#c2392f', '#d97706', '#7c3aed'];
SW.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.setProperty('--c', c); b.setAttribute('aria-label', 'Colour ' + c); b.setAttribute('aria-pressed', c === color);
  b.onclick = () => { color = c; $('swatches').querySelectorAll('.sw').forEach((s) => s.setAttribute('aria-pressed', s === b)); }; $('swatches').append(b); });
$('size').addEventListener('input', (e) => { sizes[tool === 'draw' ? 'draw' : 'text'] = +e.target.value; $('sizeVal').textContent = e.target.value; });

const sx = new Spring(0, { stiffness: 420, damping: 27 }), sy = new Spring(0, { stiffness: 420, damping: 27 });
function paintInd() {
  const vx = Math.abs(sx.velocity), vy = Math.abs(sy.velocity), s = 1 + Math.min(Math.hypot(vx, vy) / 5000, 0.2), inv = 1 / Math.sqrt(s);
  el.ind.style.transform = `translate(${sx.value}px,${sy.value}px) scale(${vx > vy ? s : inv},${vx > vy ? inv : s})`;
}
sx.on(paintInd); sy.on(paintInd);
function moveInd(snap) {
  const b = el.dock.querySelector(`[data-tool="${tool}"]`); if (!b) return;
  const x = b.offsetLeft - 6, y = b.offsetTop - 6;
  if (snap) { sx.snap(x); sy.snap(y); } else { sx.to(x); sy.to(y); }
}
function setTool(t, silent) {
  const changed = t !== tool; tool = t;
  const def = TOOLS.find((x) => x.id === t);
  el.dock.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === t));
  moveInd(silent || el.app.dataset.state === 'empty');
  pages.forEach(applyTool);
  setHint(def.hint);
  $('ctxTool').innerHTML = def.icon; const nm = document.createElement('span'); nm.textContent = def.label; $('ctxTool').append(nm);
  const showCtl = !!def.ctl, size = $('size');
  $('swatches').hidden = !showCtl; $('sizeCtl').hidden = !showCtl;
  if (showCtl) { const d = def.ctl === 'draw'; size.min = d ? 1 : 6; size.max = d ? 24 : 72; size.value = sizes[def.ctl]; $('sizeVal').textContent = size.value; $('sizeLbl').textContent = d ? 'Width' : 'Size'; }
  if (changed && el.app.dataset.state === 'ready') ['ctxTool', 'hint', 'swatches', 'sizeCtl'].forEach((id, i) => !$(id).hidden && play($(id), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: [380, 26], delay: i * 35 }));
}
function setHint(text, font) {
  const h = el.hint; h.replaceChildren();
  if (font) { const f = document.createElement('span'); f.className = 'font'; f.textContent = font; h.append(f); }
  h.append(text);
}
function applyTool(p) {
  p.el.classList.toggle('drawing', tool === 'draw'); p.el.classList.toggle('covering', tool === 'cover'); p.el.classList.toggle('texting', tool === 'text'); p.el.classList.toggle('placing', tool === 'image');
  p.sheet.style.touchAction = tool === 'draw' || tool === 'cover' ? 'none' : 'pan-x pan-y';
  p.opsEl.classList.toggle('erasing', tool === 'erase');
  p.hitsEl.style.display = tool === 'edit' ? '' : 'none';
  p.items?.forEach((it) => { it.hit.style.display = p.ops.some((o) => o.item === it) ? 'none' : ''; });
  p.opsEl.querySelectorAll('.op').forEach((o) => (o.style.pointerEvents = tool === 'erase' && o._op.t !== 'draw' ? 'auto' : 'none'));
}
function undo() {
  const last = history.pop(); if (!last) return;
  last[0].ops = last[0].ops.filter((o) => o !== last[1]); drawLayer(last[0]); updateEdits();
}

// ---------------------------------------------------------------- file intake
async function openFile(f) {
  if (!f) return;
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) return toast('Choose a PDF file.', 'err');
  const go = async () => load(new Uint8Array(await f.arrayBuffer()), f.name);
  if (dirty()) toast(`Discard ${history.length} unsaved change${history.length > 1 ? 's' : ''} and open ${f.name}?`, '', { label: 'Discard & open', run: go });
  else go();
}
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('open').onclick = () => $('file').click();
const drop = $('drop');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; drop.classList.add('over'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; drop.classList.remove('over'); openFile(e.dataTransfer.files[0]); });
$('sample').onclick = async () => load(await makeSample(), 'Harbor-Pine-invoice.pdf');

async function makeSample() {
  const d = await PDFDocument.create(), H = await d.embedFont(StandardFonts.Helvetica), HB = await d.embedFont(StandardFonts.HelveticaBold), T = await d.embedFont(StandardFonts.TimesRomanBold), TI = await d.embedFont(StandardFonts.TimesRomanItalic);
  const ink = rgb(0.07, 0.09, 0.11), mute = rgb(0.4, 0.44, 0.48), tint = rgb(0.04, 0.48, 0.46);
  const p = d.addPage([595, 842]);
  p.drawText('Harbor & Pine Studio', { x: 48, y: 770, size: 26, font: T, color: ink });
  p.drawText('Brand and interface design', { x: 48, y: 750, size: 11, font: TI, color: mute });
  p.drawText('INVOICE 2041', { x: 400, y: 772, size: 13, font: HB, color: tint });
  p.drawText('Issued 14 October 2026', { x: 400, y: 755, size: 10, font: H, color: mute });
  p.drawText('Billed to', { x: 48, y: 690, size: 9, font: HB, color: mute });
  ['Northlight Cooperative', '88 Quay Street, Leith', 'Edinburgh EH6 6QW'].forEach((t, i) => p.drawText(t, { x: 48, y: 674 - i * 15, size: 11, font: H, color: ink }));
  p.drawRectangle({ x: 48, y: 598, width: 499, height: 24, color: rgb(0.93, 0.95, 0.96) });
  [['Description', 56], ['Hours', 360], ['Rate', 425], ['Amount', 490]].forEach(([t, x]) => p.drawText(t, { x, y: 606, size: 9.5, font: HB, color: ink }));
  [['Identity system and logotype', '24', '95.00', '2,280.00'], ['Website design, 6 templates', '38', '95.00', '3,610.00'], ['Brand guidelines document', '12', '95.00', '1,140.00'], ['Print collateral set', '9', '95.00', '855.00']]
    .forEach((r, i) => { const y = 576 - i * 28; [56, 360, 425, 490].forEach((x, k) => p.drawText(r[k], { x, y, size: 11, font: H, color: ink })); p.drawLine({ start: { x: 48, y: y - 10 }, end: { x: 547, y: y - 10 }, thickness: 0.5, color: rgb(0.85, 0.87, 0.89) }); });
  p.drawText('Total due', { x: 400, y: 440, size: 12, font: HB, color: ink });
  p.drawText('GBP 7,885.00', { x: 470, y: 440, size: 12, font: HB, color: tint });
  p.drawText('Payment is due within 30 days of the issue date.', { x: 48, y: 90, size: 10, font: TI, color: mute });
  const q = d.addPage([595, 842]);
  q.drawText('Terms and notes', { x: 48, y: 770, size: 22, font: T, color: ink });
  ['All work remains the property of Harbor & Pine Studio until paid in full.', 'Revisions beyond two rounds are billed at the hourly rate shown.', 'Source files are delivered on request after final payment.']
    .forEach((t, i) => q.drawText(t, { x: 48, y: 735 - i * 20, size: 11, font: H, color: ink }));
  return d.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------- save
const stats = { inPlace: 0, overlay: 0 };
export async function buildPdf() {
  stats.inPlace = stats.overlay = 0;
  const doc = await PDFDocument.load(origBytes), cache = new Map();
  const font = async (f) => { const k = stdFont(f); if (!cache.has(k)) cache.set(k, await doc.embedFont(k)); return cache.get(k); };
  const col = (h) => rgb(...hex2rgb(h));
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i], page = doc.getPage(i), H = page.getHeight();
    const reps = pg.ops.filter((o) => o.t === 'replace'), done = replaceInPlace(doc, page, reps);
    reps.forEach((o, k) => { o.inPlace = done[k]; stats[done[k] ? 'inPlace' : 'overlay']++; });
    for (const op of pg.ops) {
      if (op.t === 'cover') page.drawRectangle({ x: op.x, y: H - op.y - op.h, width: op.w, height: op.h, color: col(op.color), borderWidth: 0 });
      else if (op.t === 'replace') {
        if (op.inPlace) continue;
        page.drawRectangle({ x: op.x - 1, y: H - op.cy - op.ch, width: op.w + 2, height: op.ch, color: col(op.bg), borderWidth: 0 });
        if (op.str.trim()) page.drawText(op.str, { x: op.x, y: H - op.base, size: op.size, font: await font(op.font), color: col(op.color) });
      } else if (op.t === 'text') {
        const fnt = await font(op.font);
        op.str.split('\n').forEach((ln, k) => page.drawText(ln, { x: op.x, y: H - op.y - op.size * 0.95 - k * op.size * 1.2, size: op.size, font: fnt, color: col(op.color) }));
      } else if (op.t === 'draw') {
        for (let k = 1; k < op.pts.length; k++) page.drawLine({ start: { x: op.pts[k - 1][0], y: H - op.pts[k - 1][1] }, end: { x: op.pts[k][0], y: H - op.pts[k][1] }, thickness: op.width, color: col(op.color), lineCap: LineCapStyle.Round });
      } else if (op.t === 'image') {
        const im = op.png ? await doc.embedPng(op.bytes) : await doc.embedJpg(op.bytes);
        page.drawImage(im, { x: op.x, y: H - op.y - op.h, width: op.w, height: op.h });
      }
    }
  }
  return doc.save({ useObjectStreams: false });
}
async function save() {
  if (!origBytes || el.save.dataset.s === 'busy') return;
  el.save.dataset.s = 'busy'; el.save.disabled = true;
  try {
    const [out] = await Promise.all([buildPdf(), new Promise((r) => setTimeout(r, 450))]);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' })); a.download = fileName; a.click();
    el.save.dataset.s = 'done';
    savedVersion = version;
    toast(`Saved ${fileName}. ${stats.inPlace ? stats.inPlace + ' text edit' + (stats.inPlace > 1 ? 's' : '') + ' made in place' : 'Original content untouched'}${stats.overlay ? '; ' + stats.overlay + ' used the nearest-font fallback' : ''}.`, 'ok');
    setTimeout(() => { el.save.dataset.s = ''; updateEdits(false); }, 1700);
  } catch (err) {
    el.save.dataset.s = ''; updateEdits(false);
    toast('Could not save: ' + err.message + (/WinAnsi|encode/i.test(err.message) ? ' (replacement text supports Latin characters only)' : ''), 'err');
  }
}
el.save.onclick = save;
addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- theme + keyboard
$('theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'), next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; try { localStorage.setItem('theme', next); } catch {}
};
addEventListener('keydown', (e) => {
  const t = e.target; if (t.isContentEditable || /INPUT|TEXTAREA/.test(t.tagName)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); undo(); }
  else if (mod && k === 's') { e.preventDefault(); save(); }
  else if (mod && k === 'o') { e.preventDefault(); $('file').click(); }
  else if (mod) return;
  else if (el.app.dataset.state !== 'ready') return;
  else if (k === '+' || k === '=') stepZoom(1); else if (k === '-') stepZoom(-1); else if (k === '0') setZoom(fitZoom());
  else if (k === 'escape') { if (!$('panel').hidden) closePanel(); else setTool('edit'); }
  else { const d = TOOLS.find((x) => x.key.toLowerCase() === k); if (d) setTool(d.id); }
});

// ---------------------------------------------------------------- first paint: stagger the landing in
[...document.querySelector('.hero').children].forEach((c, i) => play(c, [{ opacity: 0, transform: 'translateY(26px)' }, { opacity: 1, transform: 'none' }], { spring: [170, 21], delay: 60 + i * 75 }));

// landing demo: an in-place edit typed out, then reverted, on a loop
(function demo() {
  const t = $('demoText'); if (!t || reduced) { if (t) t.textContent = '18%'; return; }
  const seq = ['12%', '18%'], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let i = 0;
  (async function loop() {
    while (el.app.dataset.state === 'empty') {
      await wait(1600);
      const from = seq[i % 2], to = seq[(i + 1) % 2];
      for (let k = from.length; k >= 0; k--) { t.textContent = from.slice(0, k); await wait(70); }
      await wait(160);
      for (let k = 1; k <= to.length; k++) { t.textContent = to.slice(0, k); await wait(110); }
      play($('demoEdit'), [{ background: '#1f5fd040' }, { background: '#1f5fd012' }], { duration: 600 });
      i++;
    }
  })();
})();

window.__editor = { stats, get pages() { return pages; }, buildPdf, load, setOrig: (b) => (origBytes = b), addOp, classify, makeSample };
