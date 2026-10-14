# Faithful PDF Editor

A browser-based PDF editor whose one rule is: **don't change the document's formatting.**

## How it keeps formatting intact
- The original PDF is opened with `pdf-lib` and saved **without re-flowing, re-encoding or re-embedding** any existing page content, fonts or images. Page size, layout and every untouched object stay exactly as they were.
- Edits are *appended* on top of the original page (white-out + new text, added text, drawings, images).
- Replacement text uses the nearest standard face (Helvetica / Times / Courier, bold/italic preserved), the original size, baseline position, and the colour/background sampled from the rendered page.

## Tools
Edit text (click existing text) · Add text · White-out · Draw · Image (PNG/JPG) · Remove edit · Undo (Ctrl+Z) · Save PDF.

## Run
```
npm install
npm start        # http://localhost:8080
npm test         # needs playwright's chromium; set CHROMIUM=/path/to/chrome
```
All libraries are vendored in `vendor/` (no CDN needed).

## Known limits (honest)
- Subset-embedded fonts can't be extended with new glyphs, so replaced text uses the closest standard font; visually near-identical for common fonts, not byte-identical glyphs.
- Standard fonts only cover Latin (WinAnsi) characters.
- Rotated pages and scanned/image-only PDFs (no text layer) are not specially handled; use White-out/Add text there.
