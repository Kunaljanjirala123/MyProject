// True in-place text replacement: rewrite the string operand of the original Tj/TJ operator so the
// ORIGINAL font, size, position, colour and kerning context are kept. Anything we cannot prove safe
// (Type0/CID fonts, subset glyphs we don't have, non-identity encodings) is reported as failed so the
// caller falls back to the cover-and-overlay path.
const { PDFName, PDFDict, PDFArray, decodePDFRawStream } = PDFLib;

const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

function lex(b) {
  const t = [], n = b.length; let i = 0;
  while (i < n) {
    const c = b[i];
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 40) {
      let d = 1, j = i + 1; const bytes = [];
      while (j < n && d) {
        const ch = b[j];
        if (ch === 92) {
          const x = b[j + 1]; j += 2;
          if (x >= 48 && x <= 55) { let v = x - 48, k = 0; while (k < 2 && b[j] >= 48 && b[j] <= 55) { v = v * 8 + b[j] - 48; j++; k++; } bytes.push(v & 255); }
          else if (x === 110) bytes.push(10); else if (x === 114) bytes.push(13); else if (x === 116) bytes.push(9);
          else if (x === 98) bytes.push(8); else if (x === 102) bytes.push(12);
          else if (x === 13) { if (b[j] === 10) j++; } else if (x === 10) { /* continuation */ }
          else bytes.push(x);
        } else { if (ch === 40) d++; else if (ch === 41) d--; if (d) bytes.push(ch); j++; }
      }
      t.push({ k: 's', s: i, e: j, bytes }); i = j; continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) { t.push({ k: 'o', v: '<<' }); i += 2; continue; }
      let j = i + 1, h = '';
      while (j < n && b[j] !== 62) { if (!isWs(b[j])) h += String.fromCharCode(b[j]); j++; }
      if (h.length % 2) h += '0';
      const bytes = []; for (let k = 0; k < h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
      t.push({ k: 'h', s: i, e: j + 1, bytes }); i = j + 1; continue;
    }
    if (c === 62) { if (b[i + 1] === 62) { t.push({ k: 'o', v: '>>' }); i += 2; } else i++; continue; }
    if (c === 91) { t.push({ k: '[', s: i }); i++; continue; }
    if (c === 93) { t.push({ k: ']', e: i + 1 }); i++; continue; }
    if (c === 123 || c === 125 || c === 41) { i++; continue; }
    let j = i + 1;
    while (j < n && !isWs(b[j]) && !isDelim(b[j])) j++;
    const v = String.fromCharCode(...b.subarray(i, j));
    if (c === 47) t.push({ k: 'n', v: v.slice(1) });
    else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) t.push({ k: 'num', v });
    else {
      t.push({ k: 'o', v });
      if (v === 'ID') { // skip inline image data up to EI
        let p = j; while (p < n - 2 && !(isWs(b[p]) && b[p + 1] === 69 && b[p + 2] === 73 && (p + 3 >= n || isWs(b[p + 3])))) p++;
        j = p + 3; t.push({ k: 'o', v: 'EI' });
      }
    }
    i = j;
  }
  return t;
}

function showOps(tokens) {
  const ops = []; let font = null;
  for (let k = 0; k < tokens.length; k++) {
    const o = tokens[k];
    if (o.k !== 'o') continue;
    if (o.v === 'Tf' && tokens[k - 2]?.k === 'n') font = tokens[k - 2].v;
    else if (o.v === 'Tj' && /^[sh]$/.test(tokens[k - 1]?.k)) {
      const p = tokens[k - 1]; ops.push({ font, kind: 'Tj', s: p.s, e: p.e, hex: p.k === 'h', bytes: p.bytes });
    } else if (o.v === 'TJ' && tokens[k - 1]?.k === ']') {
      let m = k - 2; while (m >= 0 && tokens[m].k !== '[') m--;
      if (m < 0) continue;
      const parts = tokens.slice(m + 1, k - 1).filter((x) => x.k === 's' || x.k === 'h');
      ops.push({ font, kind: 'TJ', s: tokens[m].s, e: tokens[k - 1].e, hex: parts[0]?.k === 'h', bytes: parts.flatMap((x) => x.bytes) });
    }
  }
  return ops;
}

const latin1 = (bytes) => bytes.map((c) => String.fromCharCode(c)).join('');
function encode(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252[c]) out.push(CP1252[c]);
    else return null;
  }
  return out;
}
function emit(bytes, hex) {
  if (hex) return '<' + bytes.map((c) => c.toString(16).padStart(2, '0')).join('') + '>';
  return '(' + bytes.map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('') + ')';
}

function fontInfo(doc, page, name) {
  try {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    const f = fonts.lookup(PDFName.of(name), PDFDict);
    const sub = f.lookup(PDFName.of('Subtype'))?.toString();
    const fd = f.lookup(PDFName.of('FontDescriptor'));
    const embedded = !!fd && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    return { simple: sub === '/Type1' || sub === '/TrueType', embedded };
  } catch { return { simple: false, embedded: true }; }
}

/** replaces: [{orig, occ, str}]. Returns array of booleans (true = edited in place). */
export function replaceInPlace(doc, page, replaces) {
  const result = replaces.map(() => false);
  if (!replaces.length) return result;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : contents ? [contents] : [];
  let buf;
  try {
    const parts = streams.map((s) => decodePDFRawStream(s).decode());
    const len = parts.reduce((a, p) => a + p.length + 1, 0);
    buf = new Uint8Array(len); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; buf[o++] = 10; }
  } catch { return result; }

  const ops = showOps(lex(buf));
  const info = new Map(), seen = new Map();
  const get = (n) => { if (!info.has(n)) info.set(n, fontInfo(doc, page, n)); return info.get(n); };
  for (const op of ops) { const s = seen.get(op.font) || new Set(); op.bytes.forEach((c) => s.add(c)); seen.set(op.font, s); }

  const edits = new Map(); // op -> [{at,len,bytes}]
  replaces.forEach((r, idx) => {
    const target = latin1([...r.orig].map((c) => c.charCodeAt(0)));
    let n = 0, hit = null;
    for (const op of ops) {
      const text = latin1(op.bytes);
      if (op.kind === 'TJ') { if (text === target) { if (n++ === r.occ) hit = { op, at: 0, len: op.bytes.length, whole: true }; } else { for (let p = text.indexOf(target); p >= 0; p = text.indexOf(target, p + target.length)) if (n++ === r.occ) hit = { op, bad: true }; } continue; }
      for (let p = text.indexOf(target); p >= 0; p = text.indexOf(target, p + target.length)) if (n++ === r.occ) hit = { op, at: p, len: target.length };
    }
    if (!hit || hit.bad) return;
    const fi = get(hit.op.font);
    if (!fi.simple) return;
    const nb = encode(r.str);
    if (!nb) return;
    if (fi.embedded && !nb.every((c) => seen.get(hit.op.font).has(c))) return; // glyph might not exist in subset
    const list = edits.get(hit.op) || [];
    if (list.some((e) => e.at < hit.at + hit.len && hit.at < e.at + e.len)) return;
    list.push({ at: hit.at, len: hit.len, bytes: nb }); edits.set(hit.op, list);
    result[idx] = true;
  });
  if (!edits.size) return result;

  const reps = [...edits].map(([op, list]) => {
    const bytes = op.bytes.slice();
    list.sort((x, y) => y.at - x.at).forEach((e) => bytes.splice(e.at, e.len, ...e.bytes));
    return { s: op.s, e: op.e, text: emit(bytes, op.hex) };
  }).sort((x, y) => x.s - y.s);
  const ordered = []; let pos = 0;
  for (const r of reps) { ordered.push(buf.subarray(pos, r.s), new TextEncoder().encode(r.text)); pos = r.e; }
  ordered.push(buf.subarray(pos));
  const out = new Uint8Array(ordered.reduce((a, c) => a + c.length, 0)); let p = 0;
  for (const c of ordered) { out.set(c, p); p += c.length; }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
  return result;
}
