const STORAGE_KEY = "litbud.papers.v1";
const DB_NAME = "litbud-db";
const DB_VERSION = 1;
const FILE_STORE = "pdfs";
const HANDLE_DB_NAME = "litbud-directory-handles";
const HANDLE_STORE = "handles";
const LIBRARY_HANDLE_KEY = "library-directory";
const PDFJS_SOURCES = [
  {
    module: "./node_modules/pdfjs-dist/build/pdf.mjs",
    worker: "./node_modules/pdfjs-dist/build/pdf.worker.mjs",
  },
  {
    module: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs",
    worker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs",
  },
];
const nativeStorage = window.litbudStorage || null;
const serverStorage = !nativeStorage && /^https?:$/.test(window.location.protocol) ? createServerStorage() : null;

const els = {
  searchInput: document.querySelector("#searchInput"),
  categoryFilters: document.querySelector("#categoryFilters"),
  paperList: document.querySelector("#paperList"),
  chooseLibraryBtn: document.querySelector("#chooseLibraryBtn"),
  exportBackupBtn: document.querySelector("#exportBackupBtn"),
  importBackupInput: document.querySelector("#importBackupInput"),
  storageStatus: document.querySelector("#storageStatus"),
  emptyState: document.querySelector("#emptyState"),
  reader: document.querySelector("#reader"),
  newPaperBtn: document.querySelector("#newPaperBtn"),
  dropNotice: document.querySelector("#dropNotice"),
  paperDialog: document.querySelector("#paperDialog"),
  paperForm: document.querySelector("#paperForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  formTitle: document.querySelector("#formTitle"),
  formAuthors: document.querySelector("#formAuthors"),
  formYear: document.querySelector("#formYear"),
  formPdfField: document.querySelector("#formPdfField"),
  formPdf: document.querySelector("#formPdf"),
  formSubmitBtn: document.querySelector("#formSubmitBtn"),
  formMetadataStatus: document.querySelector("#formMetadataStatus"),
  categoriesInput: document.querySelector("#categoriesInput"),
  tagsInput: document.querySelector("#tagsInput"),
  questionInput: document.querySelector("#questionInput"),
  notesInput: document.querySelector("#notesInput"),
  highlightsInput: document.querySelector("#highlightsInput"),
  takeawaysInput: document.querySelector("#takeawaysInput"),
  saveState: document.querySelector("#saveState"),
  pdfInput: document.querySelector("#pdfInput"),
  pdfViewer: document.querySelector("#pdfViewer"),
  zoomOutBtn: document.querySelector("#zoomOutBtn"),
  zoomLabel: document.querySelector("#zoomLabel"),
  zoomInBtn: document.querySelector("#zoomInBtn"),
  highlightBtn: document.querySelector("#highlightBtn"),
  floatingHighlightBtn: document.querySelector("#floatingHighlightBtn"),
  openPdfLink: document.querySelector("#openPdfLink"),
  deleteBtn: document.querySelector("#deleteBtn"),
};

const state = {
  papers: [],
  selectedId: null,
  categoryFilter: "all",
  search: "",
  pdfUrl: null,
  saveTimer: null,
  dragDepth: 0,
  pendingFormMetadata: null,
  pendingHighlight: null,
  pdfRenderToken: null,
  currentPdfRecord: null,
  pdfZoom: 1,
  editingId: null,
  dialogDrag: null,
};

let pdfjsPromise = null;
let directoryStorage = null;

function createServerStorage() {
  return {
    async loadLibrary() {
      const response = await fetch("/api/library");
      if (!response.ok) throw new Error("Could not load local library");
      return response.json();
    },
    async saveLibrary(papers) {
      const response = await fetch("/api/library", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ papers }),
      });
      if (!response.ok) throw new Error("Could not save local library");
      return response.json();
    },
    async savePdf({ id, arrayBuffer }) {
      const response = await fetch(`/api/pdf/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: arrayBuffer,
      });
      if (!response.ok) throw new Error("Could not save PDF");
      return response.json();
    },
    async readPdf(id) {
      const response = await fetch(`/api/pdf/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Could not read PDF");
      return {
        id,
        name: `${id}.pdf`,
        type: "application/pdf",
        arrayBuffer: await response.arrayBuffer(),
      };
    },
    async deletePdf(id) {
      const response = await fetch(`/api/pdf/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete PDF");
    },
    async storageInfo() {
      const response = await fetch("/api/storage-info");
      if (!response.ok) throw new Error("Could not load storage info");
      return response.json();
    },
  };
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredDirectoryHandle() {
  if (!("showDirectoryPicker" in window)) return null;
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readonly");
    const request = tx.objectStore(HANDLE_STORE).get(LIBRARY_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function storeDirectoryHandle(handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(handle, LIBRARY_HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function verifyDirectoryPermission(handle, mode = "readwrite") {
  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function readTextFile(directoryHandle, name) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(name);
    return await (await fileHandle.getFile()).text();
  } catch (error) {
    if (error.name === "NotFoundError") return "";
    throw error;
  }
}

async function writeTextFile(directoryHandle, name, text) {
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

function createDirectoryStorage(directoryHandle) {
  return {
    name: directoryHandle.name || "Selected folder",
    async loadLibrary() {
      const raw = await readTextFile(directoryHandle, "library.json");
      if (!raw) return { papers: [] };
      try {
        const parsed = JSON.parse(raw);
        return { papers: Array.isArray(parsed.papers) ? parsed.papers : [] };
      } catch {
        return { papers: [] };
      }
    },
    async saveLibrary(papers) {
      await writeTextFile(
        directoryHandle,
        "library.json",
        JSON.stringify({ savedAt: new Date().toISOString(), papers }, null, 2)
      );
    },
    async savePdf({ id, name, type, arrayBuffer }) {
      const pdfDir = await directoryHandle.getDirectoryHandle("pdfs", { create: true });
      const fileHandle = await pdfDir.getFileHandle(`${id}.pdf`, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(new Blob([arrayBuffer], { type: type || "application/pdf" }));
      await writable.close();
      return { id, name, type: type || "application/pdf" };
    },
    async readPdf(id) {
      const pdfDir = await directoryHandle.getDirectoryHandle("pdfs", { create: true });
      const fileHandle = await pdfDir.getFileHandle(`${id}.pdf`);
      const file = await fileHandle.getFile();
      return {
        id,
        name: file.name,
        type: file.type || "application/pdf",
        arrayBuffer: await file.arrayBuffer(),
      };
    },
    async deletePdf(id) {
      try {
        const pdfDir = await directoryHandle.getDirectoryHandle("pdfs", { create: true });
        await pdfDir.removeEntry(`${id}.pdf`);
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
    },
  };
}

async function loadPapers() {
  if (nativeStorage?.loadLibrary) {
    const library = await nativeStorage.loadLibrary();
    return Array.isArray(library.papers) ? library.papers : [];
  }

  if (serverStorage?.loadLibrary) {
    const library = await serverStorage.loadLibrary();
    return Array.isArray(library.papers) ? library.papers : [];
  }

  if (directoryStorage?.loadLibrary) {
    const library = await directoryStorage.loadLibrary();
    return Array.isArray(library.papers) ? library.papers : [];
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistPapers() {
  if (nativeStorage?.saveLibrary) {
    await nativeStorage.saveLibrary(state.papers);
    return;
  }

  if (serverStorage?.saveLibrary) {
    await serverStorage.saveLibrary(state.papers);
    updateStorageStatus();
    return;
  }

  if (directoryStorage?.saveLibrary) {
    await directoryStorage.saveLibrary(state.papers);
    updateStorageStatus();
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.papers));
  updateStorageStatus();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putPdf(id, file) {
  if (nativeStorage?.savePdf) {
    await nativeStorage.savePdf({
      id,
      name: file.name,
      type: file.type || "application/pdf",
      arrayBuffer: await file.arrayBuffer(),
    });
    return;
  }

  if (serverStorage?.savePdf) {
    await serverStorage.savePdf({
      id,
      name: file.name,
      type: file.type || "application/pdf",
      arrayBuffer: await file.arrayBuffer(),
    });
    return;
  }

  if (directoryStorage?.savePdf) {
    await directoryStorage.savePdf({
      id,
      name: file.name,
      type: file.type || "application/pdf",
      arrayBuffer: await file.arrayBuffer(),
    });
    return;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put({
      id,
      blob: file,
      name: file.name,
      type: file.type,
      updatedAt: new Date().toISOString(),
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getPdf(id) {
  if (!id) return null;
  if (nativeStorage?.readPdf) {
    const record = await nativeStorage.readPdf(id);
    if (!record?.arrayBuffer) return null;
    return {
      id,
      name: record.name,
      type: record.type || "application/pdf",
      blob: new Blob([record.arrayBuffer], { type: record.type || "application/pdf" }),
    };
  }

  if (serverStorage?.readPdf) {
    const record = await serverStorage.readPdf(id);
    if (!record?.arrayBuffer) return null;
    return {
      id,
      name: record.name,
      type: record.type || "application/pdf",
      blob: new Blob([record.arrayBuffer], { type: record.type || "application/pdf" }),
    };
  }

  if (directoryStorage?.readPdf) {
    const record = await directoryStorage.readPdf(id);
    if (!record?.arrayBuffer) return null;
    return {
      id,
      name: record.name,
      type: record.type || "application/pdf",
      blob: new Blob([record.arrayBuffer], { type: record.type || "application/pdf" }),
    };
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const request = tx.objectStore(FILE_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deletePdf(id) {
  if (!id) return;
  if (nativeStorage?.deletePdf) {
    await nativeStorage.deletePdf(id);
    return;
  }

  if (serverStorage?.deletePdf) {
    await serverStorage.deletePdf(id);
    return;
  }

  if (directoryStorage?.deletePdf) {
    await directoryStorage.deletePdf(id);
    return;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function normalizeList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferTitleFromFile(file) {
  return file.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
}

function cleanText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function normalizeYear(value = "") {
  return (String(value).match(/\b(19|20)\d{2}\b/) || [])[0] || "";
}

function decodeXml(value = "") {
  const doc = new DOMParser().parseFromString(`<root>${value}</root>`, "text/html");
  return cleanText(doc.documentElement.textContent || value);
}

function decodePdfString(raw = "") {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const hex = trimmed.slice(1, -1).replace(/\s+/g, "");
    const bytes = hex.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) || [];
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let output = "";
      for (let index = 2; index < bytes.length; index += 2) {
        output += String.fromCharCode((bytes[index] << 8) | (bytes[index + 1] || 0));
      }
      return cleanText(output);
    }
    return cleanText(String.fromCharCode(...bytes));
  }

  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return cleanText(trimmed);
  }

  return cleanText(
    trimmed
      .slice(1, -1)
      .replace(/\\([nrtbf()\\])/g, (_, char) => {
        return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[char];
      })
      .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
      .replace(/\\\r?\n/g, "")
  );
}

function readPdfInfoField(pdfText, field) {
  const pattern = new RegExp(`/${field}\\s*(\\((?:\\\\.|[^\\\\)]){1,1200}\\)|<[\\da-fA-F\\s]{2,2400}>)`);
  const match = pdfText.match(pattern);
  return match ? decodePdfString(match[1]) : "";
}

function readXmlTag(pdfText, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = pdfText.match(pattern);
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, " ")) : "";
}

function readDcList(pdfText, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<rdf:(?:Seq|Bag|Alt)[^>]*>([\\s\\S]*?)<\\/rdf:(?:Seq|Bag|Alt)>[\\s\\S]*?<\\/${tagName}>`, "i");
  const match = pdfText.match(pattern);
  if (!match) return "";
  const items = [...match[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/gi)]
    .map((item) => decodeXml(item[1].replace(/<[^>]+>/g, " ")))
    .filter(Boolean);
  return items.join(", ");
}

async function extractPdfMetadata(file) {
  const sample = file.slice(0, Math.min(file.size, 1024 * 1024));
  const pdfText = new TextDecoder("latin1").decode(await sample.arrayBuffer());
  const title =
    readDcList(pdfText, "dc:title") ||
    readXmlTag(pdfText, "prism:title") ||
    readPdfInfoField(pdfText, "Title");
  const authors = readDcList(pdfText, "dc:creator") || readPdfInfoField(pdfText, "Author");
  const date =
    readXmlTag(pdfText, "prism:publicationDate") ||
    readXmlTag(pdfText, "prism:coverDate") ||
    readXmlTag(pdfText, "dc:date") ||
    readPdfInfoField(pdfText, "CreationDate");

  return {
    title: title && !/^Microsoft Word|^untitled$/i.test(title) ? title : "",
    authors,
    year: normalizeYear(date),
    source: title || authors || date ? "PDF metadata" : "",
  };
}

async function lookupPdfMetadata(file) {
  return extractPdfMetadata(file);
}

function selectedPaper() {
  return state.papers.find((paper) => paper.id === state.selectedId) || null;
}

function paperFromFields({ id, pdfId, file, metadata = {}, fields = {} }) {
  const now = new Date().toISOString();
  const status = fields.status || "queue";

  return {
    id,
    title: fields.title || metadata.title || (file ? inferTitleFromFile(file) : "Untitled paper"),
    authors: fields.authors || metadata.authors || "",
    year: normalizeYear(fields.year || metadata.year || ""),
    metadataSource: metadata.source || "",
    status,
    categories: [],
    tags: [],
    question: "",
    notes: "",
    highlights: "",
    takeaways: "",
    pdfHighlights: [],
    pdfId,
    addedAt: now,
    updatedAt: now,
    lastOpened: now,
    readAt: status === "read" ? now : "",
  };
}

function metadataPatchForExistingPaper(paper, metadata, file) {
  const fallbackTitle = file ? inferTitleFromFile(file) : "";
  const patch = {
    metadataSource: metadata.source || paper.metadataSource || "",
  };

  if (metadata.title && (!paper.title || paper.title === fallbackTitle || paper.title.startsWith("Example:"))) {
    patch.title = metadata.title;
  }
  if (metadata.authors && !paper.authors) patch.authors = metadata.authors;
  if (metadata.year && !paper.year) patch.year = metadata.year;

  return patch;
}

function applyMetadataToForm(metadata) {
  if (!metadata) return;
  if (metadata.title && !els.formTitle.value.trim()) els.formTitle.value = metadata.title;
  if (metadata.authors && !els.formAuthors.value.trim()) els.formAuthors.value = metadata.authors;
  if (metadata.year && !els.formYear.value.trim()) els.formYear.value = metadata.year;
}

function compactAuthors(authors = "") {
  const cleaned = cleanText(authors);
  if (!cleaned) return "No authors";

  const names = cleaned
    .split(cleaned.includes(";") ? ";" : cleaned.match(/\s+and\s+/i) ? /\s+and\s+/i : /,\s+/)
    .map((name) => cleanText(name))
    .filter(Boolean);

  if (names.length === 1) {
    return names[0];
  }

  return `${names[0]}, ... ${names[names.length - 1]}`;
}

function libraryMetaLine(paper) {
  return [paper.year, compactAuthors(paper.authors)].filter(Boolean).join(" · ");
}

function setFormMetadataStatus(message, isWarning = false) {
  els.formMetadataStatus.innerHTML = message;
  els.formMetadataStatus.classList.toggle("is-warning", isWarning);
}

function updatePaper(id, patch, options = {}) {
  const index = state.papers.findIndex((paper) => paper.id === id);
  if (index === -1) return;
  state.papers[index] = {
    ...state.papers[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  persistPapers();
  if (options.render !== false) {
    render();
  }
}

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      let lastError;
      for (const source of PDFJS_SOURCES) {
        try {
          const pdfjs = await import(source.module);
          pdfjs.GlobalWorkerOptions.workerSrc = source.worker;
          return pdfjs;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })();
  }
  return pdfjsPromise;
}

function setSaveState(message) {
  els.saveState.textContent = message;
}

function updateStorageStatus(message = "") {
  if (nativeStorage?.loadLibrary) {
    els.storageStatus.textContent = "Desktop files";
    els.chooseLibraryBtn.classList.add("hidden");
    return;
  }

  if (serverStorage?.loadLibrary) {
    els.storageStatus.textContent = message || "Local folder";
    els.chooseLibraryBtn.classList.add("hidden");
    return;
  }

  if (!("showDirectoryPicker" in window)) {
    els.storageStatus.textContent = "Browser storage";
    els.chooseLibraryBtn.disabled = true;
    els.chooseLibraryBtn.title = "Folder storage requires Chrome or Edge.";
    return;
  }

  els.chooseLibraryBtn.disabled = false;
  els.storageStatus.textContent = message || (directoryStorage ? `Folder: ${directoryStorage.name}` : "Browser storage");
}

function hideHighlightActions() {
  els.highlightBtn.classList.add("hidden");
  els.floatingHighlightBtn.classList.add("hidden");
}

function setZoomControlsVisible(isVisible) {
  els.zoomOutBtn.classList.toggle("hidden", !isVisible);
  els.zoomInBtn.classList.toggle("hidden", !isVisible);
  els.zoomLabel.classList.toggle("hidden", !isVisible);
}

function updateZoomLabel() {
  els.zoomLabel.textContent = `${Math.round(state.pdfZoom * 100)}%`;
  els.zoomOutBtn.disabled = state.pdfZoom <= 0.7;
  els.zoomInBtn.disabled = state.pdfZoom >= 2;
}

function scheduleNoteSave() {
  const paper = selectedPaper();
  if (!paper) return;
  clearTimeout(state.saveTimer);
  setSaveState("Saving...");
  state.saveTimer = setTimeout(() => {
    updatePaper(paper.id, {
      categories: normalizeList(els.categoriesInput.value),
      tags: normalizeList(els.tagsInput.value),
      question: els.questionInput.value,
      notes: els.notesInput.value,
      highlights: els.highlightsInput.value,
      takeaways: els.takeawaysInput.value,
    }, { render: false });
    renderCategoryFilters();
    renderPaperList();
    setSaveState("Saved");
  }, 300);
}

function filteredPapers() {
  const query = state.search.toLowerCase();
  return state.papers
    .filter((paper) => state.categoryFilter === "all" || paper.categories.includes(state.categoryFilter))
    .filter((paper) => {
      if (!query) return true;
      const haystack = [
        paper.title,
        paper.authors,
        paper.year,
        paper.metadataSource,
        ...paper.categories,
        ...paper.tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => {
      const statusRank = { reading: 0, queue: 1, read: 2 };
      return (
        (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3) ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
}

function renderCategoryFilters() {
  const categories = [...new Set(state.papers.flatMap((paper) => paper.categories))].sort();
  els.categoryFilters.innerHTML = "";

  const allButton = document.createElement("button");
  allButton.className = `chip ${state.categoryFilter === "all" ? "is-active" : ""}`;
  allButton.type = "button";
  allButton.textContent = "All";
  allButton.addEventListener("click", () => {
    state.categoryFilter = "all";
    render();
  });
  els.categoryFilters.append(allButton);

  categories.forEach((category) => {
    const button = document.createElement("button");
    button.className = `chip ${state.categoryFilter === category ? "is-active" : ""}`;
    button.type = "button";
    button.textContent = category;
    button.addEventListener("click", () => {
      state.categoryFilter = category;
      render();
    });
    els.categoryFilters.append(button);
  });
}

function renderPaperList() {
  const papers = filteredPapers();
  els.paperList.innerHTML = "";

  if (!papers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = state.papers.length
      ? "No papers match the current filters."
      : "No papers yet. Add a PDF or create an entry to start your queue.";
    els.paperList.append(empty);
    return;
  }

  papers.forEach((paper) => {
    const item = document.createElement("div");
    item.className = `paper-item ${paper.id === state.selectedId ? "is-selected" : ""}`;
    item.innerHTML = `
      <button class="paper-main" type="button">
        <strong>${escapeHtml(paper.title)}</strong>
        <span>${escapeHtml(libraryMetaLine(paper))}</span>
        <div class="paper-item-tags">
          ${paper.pdfId ? "<small>PDF</small>" : ""}
        </div>
      </button>
      <button class="paper-edit" type="button" aria-label="Edit ${escapeHtml(paper.title)}" title="Edit title, authors, and year">✎</button>
    `;
    item.querySelector(".paper-main").addEventListener("click", () => {
      selectPaper(paper.id);
    });
    item.querySelector(".paper-edit").addEventListener("click", () => {
      openEditDialog(paper.id);
    });
    els.paperList.append(item);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char];
  });
}

function fallbackPdfViewer(url) {
  els.pdfViewer.classList.remove("is-pdfjs");
  els.pdfViewer.innerHTML = `<object data="${url}" type="application/pdf"><iframe src="${url}" title="PDF viewer"></iframe></object>`;
}

function renderStoredHighlights(paper) {
  const highlights = paper?.pdfHighlights || [];
  els.pdfViewer.querySelectorAll(".pdf-highlight-layer").forEach((layer) => {
    layer.innerHTML = "";
  });

  highlights.forEach((highlight) => {
    highlight.rects.forEach((rect) => {
      const layer = els.pdfViewer.querySelector(`.pdf-highlight-layer[data-page-number="${rect.page}"]`);
      if (!layer) return;
      const box = document.createElement("button");
      box.className = "pdf-highlight-box";
      box.type = "button";
      box.title = "Remove highlight";
      box.style.left = `${rect.x * 100}%`;
      box.style.top = `${rect.y * 100}%`;
      box.style.width = `${rect.width * 100}%`;
      box.style.height = `${rect.height * 100}%`;
      box.addEventListener("click", (event) => {
        event.stopPropagation();
        removePdfHighlight(highlight.id);
      });
      layer.append(box);
    });
  });
}

function removePdfHighlight(id) {
  const paper = selectedPaper();
  if (!paper) return;
  updatePaper(
    paper.id,
    { pdfHighlights: (paper.pdfHighlights || []).filter((highlight) => highlight.id !== id) },
    { render: false }
  );
  renderStoredHighlights(selectedPaper());
}

async function renderPdfPage(pdfjs, pdf, paper, pageNumber, containerWidth, token) {
  const page = await pdf.getPage(pageNumber);
  if (state.pdfRenderToken !== token) return;

  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale = Math.min(1.6, Math.max(0.8, (containerWidth - 36) / baseViewport.width));
  const scale = fitScale * state.pdfZoom;
  const viewport = page.getViewport({ scale });

  const pageEl = document.createElement("div");
  pageEl.className = "pdf-page-render";
  pageEl.dataset.pageNumber = String(pageNumber);
  pageEl.style.width = `${viewport.width}px`;
  pageEl.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
  canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);

  const textLayer = document.createElement("div");
  textLayer.className = "pdf-text-layer";

  const highlightLayer = document.createElement("div");
  highlightLayer.className = "pdf-highlight-layer";
  highlightLayer.dataset.pageNumber = String(pageNumber);

  pageEl.append(canvas, textLayer, highlightLayer);
  els.pdfViewer.querySelector(".pdf-document").append(pageEl);

  await page.render({ canvasContext: context, viewport }).promise;
  const textContent = await page.getTextContent();

  textContent.items.forEach((item) => {
    if (!item.str) return;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const height = Math.hypot(tx[2], tx[3]);
    const width = Math.max(1, item.width * scale);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - height}px`;
    span.style.fontSize = `${height}px`;
    span.style.width = `${width}px`;
    span.style.height = `${height * 1.15}px`;
    textLayer.append(span);
  });

  renderStoredHighlights(paper);
}

async function renderPdfWithPdfJs(record, paper) {
  const pdfjs = await loadPdfJs();
  const token = uid();
  state.pdfRenderToken = token;
  state.pendingHighlight = null;
  hideHighlightActions();
  setZoomControlsVisible(true);
  updateZoomLabel();
  els.pdfViewer.classList.add("is-pdfjs");
  els.pdfViewer.innerHTML = `<div class="pdf-document-status">Loading PDF...</div><div class="pdf-document"></div>`;

  const pdf = await pdfjs.getDocument({ data: await record.blob.arrayBuffer() }).promise;
  if (state.pdfRenderToken !== token) return;

  els.pdfViewer.querySelector(".pdf-document-status").textContent = `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`;
  const containerWidth = Math.max(420, els.pdfViewer.clientWidth || 720);

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    await renderPdfPage(pdfjs, pdf, paper, pageNumber, containerWidth, token);
  }
}

async function renderPdf(paper) {
  if (state.pdfUrl) {
    URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = null;
  }
  state.pdfRenderToken = null;
  state.pendingHighlight = null;
  state.currentPdfRecord = null;
  hideHighlightActions();
  setZoomControlsVisible(false);

  els.openPdfLink.classList.add("hidden");
  els.openPdfLink.removeAttribute("href");

  if (!paper?.pdfId) {
    els.pdfViewer.classList.remove("is-pdfjs");
    els.pdfViewer.innerHTML = `
      <div class="pdf-placeholder">
        <strong>No PDF attached.</strong>
        <span>Attach a file to keep the paper and its note document together.</span>
      </div>
    `;
    return;
  }

  try {
    const record = await getPdf(paper.pdfId);
    if (!record?.blob) throw new Error("Missing PDF blob");
    state.currentPdfRecord = record;
    state.pdfUrl = URL.createObjectURL(record.blob);
    els.openPdfLink.href = state.pdfUrl;
    els.openPdfLink.classList.remove("hidden");
    await renderPdfWithPdfJs(record, paper);
  } catch {
    if (state.pdfUrl) {
      setZoomControlsVisible(false);
      fallbackPdfViewer(state.pdfUrl);
    } else {
      els.pdfViewer.classList.remove("is-pdfjs");
      els.pdfViewer.innerHTML = `
        <div class="pdf-placeholder">
          <strong>PDF could not be loaded.</strong>
          <span>The paper entry remains saved. Attach the file again to restore the viewer.</span>
        </div>
      `;
    }
  }
}

function renderReader() {
  const paper = selectedPaper();
  const hasPaper = Boolean(paper);

  els.emptyState.classList.toggle("hidden", hasPaper || state.papers.length > 0);
  els.reader.classList.toggle("hidden", !hasPaper);

  if (!paper) {
    return;
  }

  els.categoriesInput.value = paper.categories.join(", ");
  els.tagsInput.value = paper.tags.join(", ");
  els.questionInput.value = paper.question || "";
  els.notesInput.value = paper.notes || "";
  els.highlightsInput.value = paper.highlights || "";
  els.takeawaysInput.value = paper.takeaways || "";
  setSaveState("Saved");
  renderPdf(paper);
}

function renderQueueOverview() {
  if (state.selectedId || !state.papers.length) return;
  const nextPaper = filteredPapers()[0] || state.papers[0];
  if (nextPaper) {
    selectPaper(nextPaper.id);
  }
}

function render() {
  renderCategoryFilters();
  renderPaperList();
  renderReader();
}

function selectPaper(id) {
  state.selectedId = id;
  updatePaper(id, { lastOpened: new Date().toISOString() });
}

function openAddDialog() {
  els.paperForm.reset();
  state.editingId = null;
  state.pendingFormMetadata = null;
  els.dialogTitle.textContent = "Add paper";
  els.formSubmitBtn.textContent = "Add";
  els.formPdfField.classList.remove("hidden");
  setFormMetadataStatus("");
  els.paperDialog.showModal();
  resetDialogPosition();
  window.setTimeout(() => els.formTitle.focus(), 0);
}

function openEditDialog(id) {
  const paper = state.papers.find((item) => item.id === id);
  if (!paper) return;
  els.paperForm.reset();
  state.editingId = id;
  state.pendingFormMetadata = null;
  els.dialogTitle.textContent = "Edit paper";
  els.formSubmitBtn.textContent = "Save";
  els.formPdfField.classList.add("hidden");
  els.formTitle.value = paper.title || "";
  els.formAuthors.value = paper.authors || "";
  els.formYear.value = paper.year || "";
  setFormMetadataStatus("");
  els.paperDialog.showModal();
  resetDialogPosition();
  window.setTimeout(() => els.formTitle.focus(), 0);
}

async function createPaperFromForm(event) {
  event.preventDefault();
  if (state.editingId) {
    updatePaper(state.editingId, {
      title: els.formTitle.value.trim() || "Untitled paper",
      authors: els.formAuthors.value.trim(),
      year: normalizeYear(els.formYear.value.trim()),
    });
    state.editingId = null;
    els.paperDialog.close();
    return;
  }

  const files = [...(els.formPdf.files || [])].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  const hasManualFields = Boolean(els.formTitle.value.trim() || els.formAuthors.value.trim() || els.formYear.value.trim());

  if (files.length > 1 && !hasManualFields) {
    els.paperDialog.close();
    await addPdfFiles(files);
    return;
  }

  const file = files[0] || null;
  const id = uid();
  const pdfId = file ? uid() : null;
  let metadata = state.pendingFormMetadata || {};

  if (file) {
    if (!state.pendingFormMetadata) {
      setFormMetadataStatus("Reading title, authors, and year...");
      metadata = await lookupPdfMetadata(file);
    }
    await putPdf(pdfId, file);
  }

  const paper = paperFromFields({
    id,
    pdfId,
    file,
    metadata,
    fields: {
      title: els.formTitle.value.trim(),
      authors: els.formAuthors.value.trim(),
      year: els.formYear.value.trim(),
      status: "queue",
    },
  });

  state.papers.unshift(paper);
  state.selectedId = id;
  state.pendingFormMetadata = null;
  persistPapers();
  els.paperDialog.close();
  render();
}

async function attachPdf(event) {
  const paper = selectedPaper();
  const file = event.target.files?.[0];
  if (!paper || !file) return;

  const pdfId = paper.pdfId || uid();
  setSaveState("Reading title, authors, and year...");
  const metadata = await lookupPdfMetadata(file);
  await putPdf(pdfId, file);
  updatePaper(paper.id, { pdfId, ...metadataPatchForExistingPaper(paper, metadata, file) });
  event.target.value = "";
}

async function createPaperFromPdfFile(file) {
  const id = uid();
  const pdfId = uid();
  const metadata = await lookupPdfMetadata(file);
  await putPdf(pdfId, file);
  const paper = paperFromFields({ id, pdfId, file, metadata });
  state.papers.unshift(paper);
  state.selectedId = id;
  persistPapers();
  render();
  return paper;
}

async function addPdfFiles(files) {
  const pdfs = [...files].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  if (!pdfs.length) return;

  els.dropNotice.classList.remove("hidden");
  els.dropNotice.textContent = `Adding ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"}...`;

  for (const file of pdfs) {
    await createPaperFromPdfFile(file);
  }

  els.dropNotice.classList.add("hidden");
  els.formPdf.value = "";
}

async function collectCurrentPdfRecords() {
  const records = [];
  for (const paper of state.papers) {
    if (!paper.pdfId) continue;
    try {
      const record = await getPdf(paper.pdfId);
      if (record?.blob) {
        records.push({
          id: paper.pdfId,
          name: record.name || `${paper.pdfId}.pdf`,
          type: record.type || "application/pdf",
          arrayBuffer: await record.blob.arrayBuffer(),
        });
      }
    } catch {
      // Keep migrating metadata even if an older PDF blob is missing.
    }
  }
  return records;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function exportBackup() {
  updateStorageStatus("Preparing backup...");
  const pdfRecords = await collectCurrentPdfRecords();
  const payload = {
    exportedAt: new Date().toISOString(),
    papers: state.papers,
    pdfs: await Promise.all(
      pdfRecords.map(async (record) => ({
        id: record.id,
        name: record.name,
        type: record.type,
        base64: arrayBufferToBase64(record.arrayBuffer),
      }))
    ),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `papers-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  updateStorageStatus();
}

async function importBackup(file) {
  if (!file) return;
  const payload = JSON.parse(await file.text());
  if (!Array.isArray(payload.papers)) {
    alert("This does not look like a Papers backup.");
    return;
  }

  const shouldReplace = confirm("Import this backup? This will replace the currently loaded library.");
  if (!shouldReplace) return;

  state.papers = payload.papers;
  state.selectedId = state.papers[0]?.id || null;
  await persistPapers();

  for (const pdf of payload.pdfs || []) {
    if (!pdf.id || !pdf.base64) continue;
    await putPdf(
      pdf.id,
      new File([base64ToArrayBuffer(pdf.base64)], pdf.name || `${pdf.id}.pdf`, {
        type: pdf.type || "application/pdf",
      })
    );
  }

  render();
  alert("Backup imported.");
}

async function chooseLibraryFolder() {
  if (!("showDirectoryPicker" in window)) {
    alert("Folder storage is available in Chrome and Edge. Safari and Firefox do not currently support this browser API.");
    return;
  }

  const currentPdfRecords = await collectCurrentPdfRecords();
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  const hasPermission = await verifyDirectoryPermission(handle);
  if (!hasPermission) return;

  const nextStorage = createDirectoryStorage(handle);
  const existingLibrary = await nextStorage.loadLibrary();
  const shouldLoadExisting =
    existingLibrary.papers.length > 0 &&
    confirm("This folder already has a library.json. Load that folder library instead of copying the current browser library into it?");

  directoryStorage = nextStorage;
  await storeDirectoryHandle(handle);

  if (shouldLoadExisting) {
    state.papers = existingLibrary.papers;
    state.selectedId = state.papers[0]?.id || null;
    updateStorageStatus();
    render();
    return;
  }

  await directoryStorage.saveLibrary(state.papers);
  for (const record of currentPdfRecords) {
    await directoryStorage.savePdf(record);
  }
  updateStorageStatus(`Folder: ${directoryStorage.name}`);
  alert("Library folder connected. Current browser papers and PDFs were copied into that folder.");
}

async function populateFormFromPdf(file) {
  if (!file) {
    state.pendingFormMetadata = null;
    setFormMetadataStatus("");
    return;
  }

  setFormMetadataStatus("Reading title, authors, and year...");
  const metadata = await lookupPdfMetadata(file);
  state.pendingFormMetadata = metadata;
  applyMetadataToForm(metadata);

  if (metadata.title || metadata.authors || metadata.year) {
    setFormMetadataStatus(`<strong>Metadata found.</strong> ${escapeHtml(metadata.title || metadata.authors || metadata.year || "")}`);
  } else {
    setFormMetadataStatus("No embedded title, authors, or year were found. You can edit the fields manually.", true);
  }
}

function pageForSelectionRect(rect) {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return [...els.pdfViewer.querySelectorAll(".pdf-page-render")].find((pageEl) => {
    const pageRect = pageEl.getBoundingClientRect();
    return centerX >= pageRect.left && centerX <= pageRect.right && centerY >= pageRect.top && centerY <= pageRect.bottom;
  });
}

function capturePdfSelection() {
  window.setTimeout(() => {
    const paper = selectedPaper();
    const selection = window.getSelection();
    if (!paper || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      state.pendingHighlight = null;
      hideHighlightActions();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!els.pdfViewer.contains(range.commonAncestorContainer)) {
      state.pendingHighlight = null;
      hideHighlightActions();
      return;
    }

    const rects = [...range.getClientRects()]
      .map((rect) => {
        const pageEl = pageForSelectionRect(rect);
        if (!pageEl) return null;
        const pageRect = pageEl.getBoundingClientRect();
        const x = Math.max(0, (rect.left - pageRect.left) / pageRect.width);
        const y = Math.max(0, (rect.top - pageRect.top) / pageRect.height);
        const width = Math.min(1 - x, rect.width / pageRect.width);
        const height = Math.min(1 - y, rect.height / pageRect.height);
        if (width < 0.004 || height < 0.004) return null;
        return {
          page: Number(pageEl.dataset.pageNumber),
          x,
          y,
          width,
          height,
        };
      })
      .filter(Boolean);

    state.pendingHighlight = rects.length ? { paperId: paper.id, rects } : null;
    if (!state.pendingHighlight) {
      hideHighlightActions();
      return;
    }

    const anchor = range.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 124, Math.max(12, anchor.left + anchor.width / 2 - 46));
    const top = Math.min(window.innerHeight - 48, Math.max(12, anchor.top - 44));
    els.floatingHighlightBtn.style.left = `${left}px`;
    els.floatingHighlightBtn.style.top = `${top}px`;
    els.highlightBtn.classList.remove("hidden");
    els.floatingHighlightBtn.classList.remove("hidden");
  }, 0);
}

function savePendingHighlight() {
  const paper = selectedPaper();
  if (!paper || !state.pendingHighlight || state.pendingHighlight.paperId !== paper.id) return;

  const highlight = {
    id: uid(),
    createdAt: new Date().toISOString(),
    rects: state.pendingHighlight.rects,
  };
  updatePaper(paper.id, { pdfHighlights: [...(paper.pdfHighlights || []), highlight] }, { render: false });
  state.pendingHighlight = null;
  hideHighlightActions();
  window.getSelection()?.removeAllRanges();
  renderStoredHighlights(selectedPaper());
}

async function rerenderCurrentPdf() {
  const paper = selectedPaper();
  if (!paper || !state.currentPdfRecord) return;
  const previousScrollRatio = els.pdfViewer.scrollTop / Math.max(1, els.pdfViewer.scrollHeight - els.pdfViewer.clientHeight);
  await renderPdfWithPdfJs(state.currentPdfRecord, paper);
  els.pdfViewer.scrollTop = previousScrollRatio * Math.max(0, els.pdfViewer.scrollHeight - els.pdfViewer.clientHeight);
}

async function adjustPdfZoom(delta) {
  state.pdfZoom = Math.min(2, Math.max(0.7, Number((state.pdfZoom + delta).toFixed(2))));
  updateZoomLabel();
  await rerenderCurrentPdf();
}

function resetDialogPosition() {
  els.paperDialog.style.left = "";
  els.paperDialog.style.top = "";
  els.paperDialog.style.margin = "";
}

function startDialogDrag(event) {
  if (event.target.closest("button, input, textarea, select, label")) return;
  const rect = els.paperDialog.getBoundingClientRect();
  state.dialogDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  els.paperDialog.classList.add("is-dragging");
  els.paperDialog.style.margin = "0";
  els.paperDialog.style.left = `${rect.left}px`;
  els.paperDialog.style.top = `${rect.top}px`;
  document.addEventListener("mousemove", dragDialog);
  document.addEventListener("mouseup", stopDialogDrag);
}

function dragDialog(event) {
  if (!state.dialogDrag) return;
  const rect = els.paperDialog.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  const left = Math.min(maxLeft, Math.max(0, event.clientX - state.dialogDrag.offsetX));
  const top = Math.min(maxTop, Math.max(0, event.clientY - state.dialogDrag.offsetY));
  els.paperDialog.style.left = `${left}px`;
  els.paperDialog.style.top = `${top}px`;
}

function stopDialogDrag() {
  state.dialogDrag = null;
  els.paperDialog.classList.remove("is-dragging");
  document.removeEventListener("mousemove", dragDialog);
  document.removeEventListener("mouseup", stopDialogDrag);
}

function wireEvents() {
  els.newPaperBtn.addEventListener("click", openAddDialog);
  els.exportBackupBtn.addEventListener("click", () => {
    exportBackup().catch((error) => {
      console.error(error);
      alert("Could not export backup.");
      updateStorageStatus();
    });
  });
  els.importBackupInput.addEventListener("change", async (event) => {
    try {
      await importBackup(event.target.files?.[0]);
    } catch (error) {
      console.error(error);
      alert("Could not import backup.");
    } finally {
      event.target.value = "";
      updateStorageStatus();
    }
  });
  els.chooseLibraryBtn.addEventListener("click", () => {
    chooseLibraryFolder().catch((error) => {
      if (error.name !== "AbortError") {
        console.error(error);
        alert("Could not connect that folder. Check permissions and try again.");
      }
    });
  });
  document.querySelectorAll("[data-open-add]").forEach((button) => {
    button.addEventListener("click", openAddDialog);
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingId = null;
      stopDialogDrag();
      els.paperDialog.close();
    });
  });
  els.paperForm.addEventListener("submit", createPaperFromForm);
  els.paperDialog.querySelector(".dialog-header").addEventListener("mousedown", startDialogDrag);

  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderPaperList();
  });

  [
    els.categoriesInput,
    els.tagsInput,
    els.questionInput,
    els.notesInput,
    els.highlightsInput,
    els.takeawaysInput,
  ].forEach((input) => {
    input.addEventListener("input", scheduleNoteSave);
    input.addEventListener("change", scheduleNoteSave);
  });

  els.formPdf.addEventListener("change", async (event) => {
    await populateFormFromPdf(event.target.files?.[0] || null);
  });

  els.pdfInput.addEventListener("change", attachPdf);
  els.pdfViewer.addEventListener("mouseup", capturePdfSelection);
  els.pdfViewer.addEventListener("scroll", hideHighlightActions);
  els.zoomOutBtn.addEventListener("click", () => adjustPdfZoom(-0.15));
  els.zoomInBtn.addEventListener("click", () => adjustPdfZoom(0.15));
  els.highlightBtn.addEventListener("mousedown", (event) => event.preventDefault());
  els.floatingHighlightBtn.addEventListener("mousedown", (event) => event.preventDefault());
  els.highlightBtn.addEventListener("click", savePendingHighlight);
  els.floatingHighlightBtn.addEventListener("click", savePendingHighlight);

  window.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer?.items || []].some((item) => item.kind === "file")) return;
    state.dragDepth += 1;
    els.dropNotice.textContent = "Drop PDFs to add them to the queue.";
    els.dropNotice.classList.remove("hidden");
  });

  window.addEventListener("dragleave", () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      els.dropNotice.classList.add("hidden");
    }
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    await addPdfFiles(event.dataTransfer?.files || []);
  });

  els.deleteBtn.addEventListener("click", async () => {
    const paper = selectedPaper();
    if (!paper) return;
    const shouldDelete = confirm(`Delete "${paper.title}" and its linked PDF?`);
    if (!shouldDelete) return;
    await deletePdf(paper.pdfId);
    state.papers = state.papers.filter((item) => item.id !== paper.id);
    state.selectedId = state.papers[0]?.id || null;
    persistPapers();
    render();
  });
}

async function init() {
  if (serverStorage?.storageInfo) {
    try {
      const info = await serverStorage.storageInfo();
      updateStorageStatus(`Local: ${info.libraryDir}`);
    } catch {
      updateStorageStatus("Local folder");
    }
  }

  if (!nativeStorage?.loadLibrary && !serverStorage?.loadLibrary) {
    try {
      const handle = await getStoredDirectoryHandle();
      if (handle && (await verifyDirectoryPermission(handle))) {
        directoryStorage = createDirectoryStorage(handle);
      }
    } catch {
      directoryStorage = null;
    }
  }
  state.papers = await loadPapers();
  state.selectedId = state.papers[0]?.id || null;
  wireEvents();
  updateStorageStatus();
  render();
}

init();
