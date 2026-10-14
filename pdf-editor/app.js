import * as pdfjsLib from './vendor/pdf.min.mjs';
import { replaceInPlace } from './inplace.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const { PDFDocument, StandardFonts, rgb, LineCapStyle } = PDFLib;
const SCALE = 1.5;                       // on-screen px per PDF point
const $ = (id) => document.getElementById(id);
const pagesEl = $('pages'), statusEl = $('status');

let origBytes = null, fileName = 'edited.pdf';
let pages = [];                          // {w, h, el, layer, ops:[], items:[]}
let tool = 'edit';
let history = [];                        // [pageIndex, op] in creation order
let pendingImage = null;

const status = (m) => (statusEl.textContent = m);

// ---------- font mapping: keep the closest standard face of the original ----------
function classify(realName = '', family = '') {
  const n = (realName + ' ' + family).toLowerCase();
  return {
    bold: /bold|black|heavy|semibold|demi/.test(n),
    italic: /italic|oblique/.test(n),
    mono: /courier|mono|consolas|typewriter/.test(n),
    serif: /times|serif|georgia|garamond|palatino|minion|cambria|book/.test(n) && !/sans/.test(n),
    label: realName.replace(/^[A-Z]{6}\+/, '') || family || 'default',
  };
}
function stdFont(f) {
  const S = StandardFonts;
  if (f.mono) return f.bold ? (f.italic ? S.CourierBoldOblique : S.CourierBold) : f.italic ? S.CourierOblique : S.Courier;
  if (f.serif) return f.bold ? (f.italic ? S.TimesRomanBoldItalic : S.TimesRomanBold) : f.italic ? S.TimesRomanItalic : S.TimesRoman;
  return f.bold ? (f.italic ? S.HelveticaBoldOblique : S.HelveticaBold) : f.italic ? S.HelveticaOblique : S.Helvetica;
}
const cssFont = (f) => `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${f.mono ? 'monospace' : f.serif ? 'serif' : 'sans-serif'}`;
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgb2hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---------- loading & rendering ----------
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  fileName = f.name.replace(/\.pdf$/i, '') + '-edited.pdf';
  origBytes = new Uint8Array(await f.arrayBuffer());
  await load();
});

async function load() {
  pagesEl.innerHTML = '';
  pages = []; history = [];
  const doc = await pdfjsLib.getDocument({ data: origBytes.slice(), standardFontDataUrl: './vendor/standard_fonts/', cMapUrl: './vendor/cmaps/', cMapPacked: true }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const el = document.createElement('div');
    el.className = 'page';
    el.style.width = vp.width * SCALE + 'px';
    el.style.height = vp.height * SCALE + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = vp.width * SCALE * dpr; canvas.height = vp.height * SCALE * dpr;
    canvas.style.width = el.style.width; canvas.style.height = el.style.height;
    const layer = document.createElement('div');
    layer.className = 'layer';
    el.append(canvas, layer);
    pagesEl.append(el);
    await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }),
      viewport: page.getViewport({ scale: SCALE * dpr }) }).promise;

    const tc = await page.getTextContent();
    const seenStr = new Map();
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
      let real = '';
      try { real = page.commonObjs.get(it.fontName).name || ''; } catch {}
      const fam = tc.styles[it.fontName]?.fontFamily || '';
      const size = Math.hypot(it.transform[0], it.transform[1]);
      const occ = seenStr.get(it.str) || 0; seenStr.set(it.str, occ + 1);
      return { occ, str: it.str, x: it.transform[4], base: vp.height - it.transform[5], w: it.width, size,
        font: classify(real, fam) };
    });
    const pg = { w: vp.width, h: vp.height, el, layer, canvas, dpr, ops: [], items };
    pages.push(pg);
    wirePage(pg, pages.length - 1);
    drawLayer(pg);
  }
  setTool(tool);
  status(`Loaded ${doc.numPages} page(s). Original content is untouched until you save.`);
}

// sample background + ink colour of a region of the rendered page
function sample(pg, x, y, w, h) {
  const d = pg.dpr * SCALE;
  const sx = Math.max(0, Math.floor(x * d)), sy = Math.max(0, Math.floor(y * d));
  const sw = Math.max(1, Math.min(pg.canvas.width - sx, Math.ceil(w * d))), sh = Math.max(1, Math.min(pg.canvas.height - sy, Math.ceil(h * d)));
  const px = pg.canvas.getContext('2d').getImageData(sx, sy, sw, sh).data;
  const counts = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestK = 0, best = -1;
  for (const [k, c] of counts) if (c > best) { best = c; bestK = k; }
  const bg = [((bestK >> 10) & 31) * 8 + 4, ((bestK >> 5) & 31) * 8 + 4, (bestK & 31) * 8 + 4];
  let ink = bg, far = -1;
  for (let i = 0; i < px.length; i += 4) {
    const dist = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    if (dist > far) { far = dist; ink = [px[i], px[i + 1], px[i + 2]]; }
  }
  return { bg: rgb2hex(bg), ink: rgb2hex(ink) };
}

// ---------- overlay layer ----------
function drawLayer(pg) {
  pg.layer.querySelectorAll('.op,.hit').forEach((n) => n.remove());
  pg.ops.forEach((op) => {
    const n = document.createElement('div');
    n.className = 'op ' + op.t;
    n._op = op;
    const S = SCALE;
    const box = (x, y, w, h) => Object.assign(n.style, { left: x * S + 'px', top: y * S + 'px', width: w * S + 'px', height: h * S + 'px' });
    if (op.t === 'cover') { box(op.x, op.y, op.w, op.h); n.style.background = op.color; }
    else if (op.t === 'replace') {
      box(op.x - 1, op.cy, op.w + 2, op.ch); n.style.background = op.bg;
      const t = document.createElement('div');
      t.textContent = op.str;
      Object.assign(t.style, { position: 'absolute', left: '1px', top: (op.base - op.cy - op.size * 0.8) * S + 'px',
        font: `${cssFont(op.font)} ${op.size * S}px/1 `, color: op.color });
      n.append(t);
      // keep font shorthand valid: family is part of cssFont
      t.style.font = `${cssFont(op.font).replace(/(monospace|serif|sans-serif)$/, `${op.size * S}px/1 $1`)}`;
    } else if (op.t === 'text') {
      n.style.left = op.x * S + 'px'; n.style.top = op.y * S + 'px'; n.style.color = op.color;
      n.style.font = cssFont(op.font).replace(/(monospace|serif|sans-serif)$/, `${op.size * S}px/1.2 $1`);
      n.textContent = op.str;
    } else if (op.t === 'image') {
      box(op.x, op.y, op.w, op.h);
      const im = document.createElement('img'); im.src = op.url; im.style.cssText = 'width:100%;height:100%';
      n.append(im);
    } else if (op.t === 'draw') {
      n.style.inset = '0'; n.style.width = '100%'; n.style.height = '100%'; n.style.pointerEvents = 'none';
      n.innerHTML = `<svg width="100%" height="100%" style="position:absolute;left:0;top:0"><polyline fill="none" stroke="${op.color}" stroke-width="${op.width * S}" stroke-linecap="round" stroke-linejoin="round" points="${op.pts.map((p) => p[0] * S + ',' + p[1] * S).join(' ')}"/></svg>`;
    }
    pg.layer.append(n);
  });
  pg.items.forEach((it) => {
    const h = document.createElement('div');
    h.className = 'hit';
    Object.assign(h.style, { left: it.x * SCALE + 'px', top: (it.base - it.size * 0.85) * SCALE + 'px',
      width: it.w * SCALE + 'px', height: it.size * 1.1 * SCALE + 'px' });
    h.addEventListener('click', (e) => { if (tool === 'edit') { e.stopPropagation(); editItem(pg, it); } });
    pg.layer.append(h);
  });
  applyTool(pg);
}

function addOp(pg, op) {
  pg.ops.push(op); history.push([pg, op]); drawLayer(pg);
}

function openEditor(pg, { x, y, str, size, color, font, onDone, width }) {
  const ed = document.createElement('div');
  ed.className = 'editor'; ed.contentEditable = 'plaintext-only';
  ed.textContent = str;
  Object.assign(ed.style, { left: x * SCALE - 1 + 'px', top: y * SCALE - 1 + 'px', color,
    font: cssFont(font).replace(/(monospace|serif|sans-serif)$/, `${size * SCALE}px/1.2 $1`) });
  if (width) ed.style.minWidth = width * SCALE + 'px';
  pg.layer.append(ed);
  ed.focus();
  document.getSelection().selectAllChildren(ed);
  let done = false;
  const finish = (commit) => { if (done) return; done = true; const v = ed.textContent; ed.remove(); if (commit) onDone(v); };
  ed.addEventListener('blur', () => finish(true));
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && !e.shiftKey && !ed.dataset.multi) { e.preventDefault(); ed.blur(); }
  });
  ed.addEventListener('click', (e) => e.stopPropagation());
}

function editItem(pg, it) {
  const top = it.base - it.size * 0.85;
  const { bg, ink } = sample(pg, it.x, top, it.w, it.size * 1.1);
  openEditor(pg, { x: it.x, y: it.base - it.size * 0.8, str: it.str, size: it.size, color: ink, font: it.font, width: it.w,
    onDone: (v) => {
      if (v === it.str) return;
      const op = { t: 'replace', x: it.x, cy: top, ch: it.size * 1.15, w: Math.max(it.w, 1), base: it.base, size: it.size,
        str: v, orig: it.str, occ: it.occ, color: ink, bg, font: it.font };
      addOp(pg, op);
      status(`Replaced text using ${it.font.label} → nearest standard face (${stdFont(it.font)}). Everything else is unchanged.`);
    } });
}

// ---------- pointer tools ----------
function wirePage(pg, idx) {
  const pos = (e) => { const r = pg.el.getBoundingClientRect(); return [(e.clientX - r.left) / SCALE, (e.clientY - r.top) / SCALE]; };
  pg.el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.editor')) return;
    const [x, y] = pos(e);
    if (tool === 'erase') {
      const n = e.target.closest('.op');
      if (n) { pg.ops = pg.ops.filter((o) => o !== n._op); history = history.filter(([, o]) => o !== n._op); drawLayer(pg); }
      return;
    }
    if (tool === 'text') {
      const size = +$('size').value, color = $('color').value, font = classify('', 'sans-serif');
      openEditor(pg, { x, y, str: '', size, color, font, onDone: (v) => v && addOp(pg, { t: 'text', x, y, size, color, font, str: v }) });
      e.preventDefault();
    } else if (tool === 'cover') {
      const rb = document.createElement('div'); rb.className = 'rubber'; pg.layer.append(rb);
      const move = (m) => { const [mx, my] = pos(m); Object.assign(rb.style, { left: Math.min(x, mx) * SCALE + 'px', top: Math.min(y, my) * SCALE + 'px', width: Math.abs(mx - x) * SCALE + 'px', height: Math.abs(my - y) * SCALE + 'px' }); };
      const up = (m) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); rb.remove();
        const [mx, my] = pos(m); const w = Math.abs(mx - x), h = Math.abs(my - y);
        if (w > 2 && h > 2) { const bg = sample(pg, Math.min(x, mx) - 2, Math.min(y, my) - 2, 4, 4).bg;
          addOp(pg, { t: 'cover', x: Math.min(x, mx), y: Math.min(y, my), w, h, color: bg }); } };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    } else if (tool === 'draw') {
      const op = { t: 'draw', pts: [[x, y]], color: $('color').value, width: Math.max(1, +$('size').value / 6) };
      pg.ops.push(op);
      const move = (m) => { op.pts.push(pos(m)); drawLayer(pg); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); history.push([pg, op]); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    } else if (tool === 'image') {
      pendingImage = { pg, x, y };
      $('imgfile').click();
    }
  });
}

$('imgfile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !pendingImage) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const url = URL.createObjectURL(f);
  const img = new Image(); img.src = url; await img.decode();
  const w = Math.min(200, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
  addOp(pendingImage.pg, { t: 'image', x: pendingImage.x, y: pendingImage.y, w, h, url, bytes, png: f.type === 'image/png' });
  pendingImage = null;
});

function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  pagesEl.classList.toggle('erasing', t === 'erase');
  pages.forEach(applyTool);
}
function applyTool(p) {
  p.el.classList.toggle('drawing', tool === 'draw'); p.el.classList.toggle('covering', tool === 'cover'); p.el.classList.toggle('texting', tool === 'text');
  p.layer.querySelectorAll('.hit').forEach((h) => (h.style.display = tool === 'edit' ? '' : 'none'));
  p.layer.querySelectorAll('.op').forEach((o) => (o.style.pointerEvents = tool === 'erase' && o._op.t !== 'draw' ? 'auto' : 'none'));
}
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
function undo() {
  const last = history.pop(); if (!last) return;
  last[0].ops = last[0].ops.filter((o) => o !== last[1]); drawLayer(last[0]);
}
$('undo').addEventListener('click', undo);
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.target.isContentEditable) { e.preventDefault(); undo(); } });


// ---------- save: load ORIGINAL bytes, only append overlay content ----------
const stats = { inPlace: 0, overlay: 0 };
export async function buildPdf() {
  stats.inPlace = stats.overlay = 0;
  const doc = await PDFDocument.load(origBytes, { ignoreEncryption: false });
  const cache = new Map();
  const font = async (f) => { const k = stdFont(f); if (!cache.has(k)) cache.set(k, await doc.embedFont(k)); return cache.get(k); };
  const col = (h) => rgb(...hex2rgb(h));
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i], page = doc.getPage(i), H = page.getHeight();
    // 1) try true in-place edits (original font/size/position kept); the rest fall back to overlay
    const reps = pg.ops.filter((o) => o.t === 'replace');
    const done = replaceInPlace(doc, page, reps);
    reps.forEach((o, k) => { o.inPlace = done[k]; stats.inPlace += done[k] ? 1 : 0; stats.overlay += done[k] ? 0 : 1; });
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
        for (let k = 1; k < op.pts.length; k++)
          page.drawLine({ start: { x: op.pts[k - 1][0], y: H - op.pts[k - 1][1] }, end: { x: op.pts[k][0], y: H - op.pts[k][1] }, thickness: op.width, color: col(op.color), lineCap: LineCapStyle.Round });
      } else if (op.t === 'image') {
        const im = op.png ? await doc.embedPng(op.bytes) : await doc.embedJpg(op.bytes);
        page.drawImage(im, { x: op.x, y: H - op.y - op.h, width: op.w, height: op.h });
      }
    }
  }
  return doc.save({ useObjectStreams: false });
}

$('save').addEventListener('click', async () => {
  if (!origBytes) return status('Open a PDF first.');
  try {
    const out = await buildPdf();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    a.download = fileName; a.click();
    status(`Saved. ${stats.inPlace} text edit(s) done in place with the original font; ${stats.overlay} used the nearest-font overlay. Everything else is untouched.`);
  } catch (err) {
    status('Save failed: ' + err.message + (/WinAnsi|encode/i.test(err.message) ? ' (standard fonts only support Latin characters)' : ''));
  }
});
window.__editor = { stats, get pages() { return pages; }, buildPdf, load, setOrig: (b) => (origBytes = b), addOp, classify };
