// Stress test: 150-page document stays responsive, frees far-away canvases, and pinch zoom works on touch.
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import assert from 'assert';

const root = new URL('.', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const srv = createServer(async (q, r) => {
  const p = join(root, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  let data; try { data = await readFile(p); } catch { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); r.end(data);
}).listen(0);

const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 150; i++) { const p = d.addPage([595, 842]); for (let k = 0; k < 30; k++) p.drawText(`Page ${i} line ${k} lorem ipsum dolor sit amet`, { x: 40, y: 800 - k * 24, size: 12, font: f }); }
const bytes = [...await d.save()];

const b = await chromium.launch({ executablePath: process.env.CHROMIUM });
const ctx = await b.newContext({ viewport: { width: 420, height: 800 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://localhost:${srv.address().port}/`);
const t0 = Date.now();
await page.evaluate(async (a) => { window.__editor.setOrig(new Uint8Array(a)); await window.__editor.load(); }, bytes);
console.log('loaded 150 pages in', Date.now() - t0, 'ms');
assert(Date.now() - t0 < 15000, 'load too slow');
const canvases = () => page.evaluate(() => document.querySelectorAll('.sheet > canvas').length);
console.log('canvases after load:', await canvases());
assert((await canvases()) <= 12, 'too many canvases kept');

// scroll far down in steps; far pages must be released
for (let i = 1; i <= 8; i++) { await page.evaluate((y) => (document.getElementById('stage').scrollTop = y), i * 18000); await page.waitForTimeout(250); }
await page.waitForTimeout(800);
const n = await canvases();
console.log('canvases after scrolling:', n);
assert(n <= 12, 'canvas memory not released');
assert(await page.evaluate(() => document.querySelector('.sheet > canvas') !== null), 'visible pages not rendered');

// pinch: two touch pointers moving apart should raise the zoom
const z0 = await page.evaluate(() => getComputedStyle(document.getElementById('pages')).getPropertyValue('--z'));
await page.evaluate(() => {
  const s = document.getElementById('stage'), fire = (t, id, x, y) => s.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
  fire('pointerdown', 1, 150, 400); fire('pointerdown', 2, 250, 400);
  for (let i = 1; i <= 10; i++) { fire('pointermove', 1, 150 - i * 8, 400); fire('pointermove', 2, 250 + i * 8, 400); }
  fire('pointerup', 1, 70, 400); fire('pointerup', 2, 330, 400);
});
const z1 = await page.evaluate(() => getComputedStyle(document.getElementById('pages')).getPropertyValue('--z'));
console.log('zoom before/after pinch:', (+z0).toFixed(2), (+z1).toFixed(2));
assert(+z1 > +z0 * 1.5, 'pinch did not zoom');
await page.waitForTimeout(600);
await page.screenshot({ path: process.env.SHOT || 'large.png' });
assert.deepEqual(errs, [], 'page errors');
await b.close(); srv.close(); console.log('PASS');
