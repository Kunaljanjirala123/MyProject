// End-to-end check: edit a PDF in a real browser, then prove the original content is untouched.
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
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

const src = await PDFDocument.create();
const pg = src.addPage([400, 300]);
pg.drawText('Hello Original World', { x: 50, y: 200, size: 24, font: await src.embedFont(StandardFonts.TimesRomanBold), color: rgb(0, 0, 0.6) });
pg.drawText('Second line stays', { x: 50, y: 150, size: 14, font: await src.embedFont(StandardFonts.Courier) });
const bytes = await src.save({ useObjectStreams: false });

const b = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://localhost:${srv.address().port}/`);
await page.evaluate(async (arr) => { const ed = window.__editor; ed.setOrig(new Uint8Array(arr)); await ed.load(); }, [...bytes]);
await page.waitForSelector('.hit');
await page.locator('.hit').first().click();
await page.keyboard.press('Control+A');
await page.keyboard.type('Hello Edited World');
await page.keyboard.press('Enter');
await page.locator('.hit').last().click();
await page.keyboard.press('Control+A');
await page.keyboard.type('goes');
await page.keyboard.press('Enter');
await page.click('[data-tool=text]');
await page.mouse.click(450, 400);
await page.keyboard.type('New note');
await page.keyboard.press('Enter');
const out = Uint8Array.from(await page.evaluate(async () => [...(await window.__editor.buildPdf())]));
const st = await page.evaluate(() => ({ ...window.__editor.stats }));
assert.equal(st.inPlace, 2, 'expected in-place edit: ' + JSON.stringify(st));
await b.close(); srv.close();

const doc = await PDFDocument.load(out);
assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [400, 300], 'page size changed');
const text = (await (await (await pdfjs.getDocument({ data: out, standardFontDataUrl: join(root, 'node_modules/pdfjs-dist/standard_fonts/') }).promise).getPage(1)).getTextContent()).items.map((i) => i.str).join('');
console.log(text);
assert(text.includes('Hello Edited World') && text.includes('New note'), 'edits missing');
assert(text.includes('Second line goes'), 'substring edit failed');
assert(!text.includes('Hello Original World'), 'edit should be in place (no hidden original text)');
assert.deepEqual(errs, [], 'page errors');
console.log('PASS');
