# Papers

A local-first reading tracker for research papers. It is built as a static browser app, so it runs without installing packages or setting up a backend.

## Use it

Open `index.html` in a browser.

What it supports now:

- Add papers to a "want to read" queue.
- Drag and drop one or more PDFs into the app.
- Extract embedded PDF title and author metadata.
- Attach a PDF to each paper.
- Read the PDF and write the linked note document side by side.
- Select text in the PDF and click `Highlight` to save a highlight. Click an existing highlight to remove it.
- Track status: want to read, reading, read.
- Add categories after reading, plus tags, highlights, and synthesis notes.
- Search and filter the library.

## Storage

Paper metadata and notes are saved in browser `localStorage`. PDF files are saved in browser `IndexedDB`. This means the data stays on this machine and in this browser profile.

PDF metadata parsing is intentionally fast and local. Scanned PDFs and files without embedded title/author fields may still need manual cleanup.

The highlight viewer uses PDF.js from a CDN. If PDF.js cannot load, the app falls back to the browser's built-in PDF viewer without highlights.
