# Papers

A local-first reading tracker for research papers.

## Use it

For the desktop app:

```bash
npm install
npm start
```

The old browser mode still works by opening `index.html`, but browser mode stores data in browser storage. The desktop app stores data as normal local files.

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
- Extract embedded PDF title and author metadata.
- Attach a PDF to each paper.
- Read the PDF and write the linked note document side by side.
- Select text in the PDF and click `Highlight` to save a highlight. Click an existing highlight to remove it.
- Track status: want to read, reading, read.
- Add categories after reading, plus tags, highlights, and synthesis notes.
- Search and filter the library.

## Storage

In the desktop app, paper metadata, notes, categories, and highlights are saved to:

```text
~/Library/Application Support/papers-local/library.json
```

PDF files are copied to:

```text
~/Library/Application Support/papers-local/pdfs/
```

In browser mode without a connected library folder, paper metadata and notes are saved in browser `localStorage`; PDF files are saved in browser `IndexedDB`.

PDF metadata parsing is intentionally fast and local. Scanned PDFs and files without embedded title/author fields may still need manual cleanup.

The highlight viewer uses PDF.js from a CDN. If PDF.js cannot load, the app falls back to the browser's built-in PDF viewer without highlights.
