# Papers

Papers is a local-first reading tracker for research papers. It keeps PDFs, notes, categories, and PDF highlights on your own machine.

## Features

- Add papers manually or by dragging in PDFs.
- Extract embedded PDF title, author, and year metadata when available.
- Read a PDF beside its linked notes document.
- Highlight selected PDF text and remove highlights by clicking them.
- Track categories, tags, reading notes, quotes/highlights, and synthesis notes.
- Search the local library.
- Export/import full backups with metadata and PDFs.

## Recommended Use

For daily use, build the packaged app for your platform and run it like a normal desktop app.

Install dependencies:

```bash
npm install
```

Build the macOS app:

```bash
npm run pack:mac
```

Build the Windows x64 app:

```bash
npm run pack:win
```

Build outputs are generated in `dist/`. The `dist/` folder is intentionally ignored by git because packaged apps are large generated artifacts.

## Development

Run as an Electron desktop app:

```bash
npm run desktop
```

Run as a lightweight local web app:

```bash
npm start
```

Then open:

```text
http://localhost:4317
```

The local web app works in Safari and Chrome. The browser is only the interface; the local server writes data to files.

## Storage

The packaged app and local server both use:

```text
~/Documents/Papers Library/
```

That folder contains:

```text
library.json
pdfs/
backups/
```

`library.json` is written atomically. Before each metadata save, the previous version is copied into `backups/`. The newest 100 metadata backups are kept.

To use a different folder with the local server:

```bash
PAPERS_LIBRARY_DIR="/path/to/your/folder" npm start
```

## Browser-Only Mode

Opening `index.html` directly still works, but browser-only mode stores data in browser storage unless you use Chrome/Edge folder mode.

Chrome and Edge support connecting a real folder from the sidebar via `Library folder`. Safari and Firefox do not support that browser folder-writing API, so use the packaged app or local server mode for durable Safari-compatible storage.

## Notes

PDF metadata parsing is intentionally fast and local. Scanned PDFs and files without embedded title/author/year fields may need manual cleanup.

Packaged builds are not code-signed yet. macOS Gatekeeper or Windows SmartScreen may warn when opening shared builds until signing/notarization is added.
