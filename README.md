# Papers

A local-first reading tracker for research papers.

## Use it

For the easiest Mac experience, open the packaged app:

```text
dist/mac-arm64/Papers.app
```

You can drag `Papers.app` into `/Applications` after building it.

For the lightweight browser app with durable local files:

```bash
npm install
npm start
```

Then open:

```text
http://localhost:4317
```

This works in Safari and Chrome. The browser is only the interface; a tiny local server writes your data to normal files.

For the desktop app:

```bash
npm run desktop
```

To rebuild the double-clickable macOS app:

```bash
npm run pack:mac
```

To build a Windows x64 folder for sharing:

```bash
npm run pack:win
```

Then zip and send:

```text
dist/win-unpacked/
```

The Windows executable is:

```text
dist/win-unpacked/Papers.exe
```

The old browser-only mode still works by opening `index.html`, but browser-only mode stores data in browser storage unless you use Chrome/Edge folder mode.

## Local server storage

The local server stores your long-term library here by default:

```text
~/Documents/Papers Library/
```

It writes:

```text
library.json
pdfs/
backups/
```

`library.json` is written atomically, and the previous version is copied into `backups/` before each save. The newest 100 metadata backups are kept.

To use a different folder:

```bash
PAPERS_LIBRARY_DIR="/path/to/your/folder" npm start
```

Use `Export` in the sidebar to make a full manual backup with metadata and PDFs in one JSON file. Use `Import` to restore one.

## Browser folder mode

If you prefer the light browser version, use Chrome or Edge and click `Library folder`. Pick a folder such as:

```text
~/Documents/Papers Library/
```

The app will write:

```text
library.json
pdfs/
```

inside that folder. Existing browser papers and PDFs are copied into the folder when you connect it.

Safari and Firefox do not support this folder-writing browser API. In those browsers, the app falls back to browser storage.

What it supports now:

- Add papers to a "want to read" queue.
- Drag and drop one or more PDFs into the app.
- Extract embedded PDF title, author, and year metadata when available.
- Attach a PDF to each paper.
- Read the PDF and write the linked note document side by side.
- Select text in the PDF and click `Highlight` to save a highlight. Click an existing highlight to remove it.
- Track status: want to read, reading, read.
- Add categories after reading, plus tags, highlights, and synthesis notes.
- Search and filter the library.

## Storage

The packaged app and local server both use:

```text
~/Documents/Papers Library/
```

with:

```text
library.json
pdfs/
backups/
```

In browser mode without a connected library folder, paper metadata and notes are saved in browser `localStorage`; PDF files are saved in browser `IndexedDB`.

PDF metadata parsing is intentionally fast and local. Scanned PDFs and files without embedded title/author fields may still need manual cleanup.

The highlight viewer uses PDF.js from a CDN. If PDF.js cannot load, the app falls back to the browser's built-in PDF viewer without highlights.
