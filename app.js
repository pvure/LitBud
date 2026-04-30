const STORAGE_KEY = "litbud.papers.v1";
const DB_NAME = "litbud-db";
const DB_VERSION = 1;
const FILE_STORE = "pdfs";

const els = {
  searchInput: document.querySelector("#searchInput"),
  categoryFilters: document.querySelector("#categoryFilters"),
  paperList: document.querySelector("#paperList"),
  emptyState: document.querySelector("#emptyState"),
  reader: document.querySelector("#reader"),
  newPaperBtn: document.querySelector("#newPaperBtn"),
  dropNotice: document.querySelector("#dropNotice"),
  paperDialog: document.querySelector("#paperDialog"),
  paperForm: document.querySelector("#paperForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  formTitle: document.querySelector("#formTitle"),
  formAuthors: document.querySelector("#formAuthors"),
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
  editingId: null,
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function loadPapers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistPapers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.papers));
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

  return {
    title: title && !/^Microsoft Word|^untitled$/i.test(title) ? title : "",
    authors,
    source: title || authors ? "PDF metadata" : "",
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
    metadataSource: metadata.source || "",
    status,
    categories: [],
    tags: [],
    question: "",
    notes: "",
    highlights: "",
    takeaways: "",
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

  return patch;
}

function applyMetadataToForm(metadata) {
  if (!metadata) return;
  if (metadata.title && !els.formTitle.value.trim()) els.formTitle.value = metadata.title;
  if (metadata.authors && !els.formAuthors.value.trim()) els.formAuthors.value = metadata.authors;
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

function setSaveState(message) {
  els.saveState.textContent = message;
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
        <span>${escapeHtml(compactAuthors(paper.authors))}</span>
        <div class="paper-item-tags">
          ${paper.pdfId ? "<small>PDF</small>" : ""}
        </div>
      </button>
      <button class="paper-edit" type="button" aria-label="Edit ${escapeHtml(paper.title)}" title="Edit title and authors">✎</button>
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

async function renderPdf(paper) {
  if (state.pdfUrl) {
    URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = null;
  }

  els.openPdfLink.classList.add("hidden");
  els.openPdfLink.removeAttribute("href");

  if (!paper?.pdfId) {
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
    state.pdfUrl = URL.createObjectURL(record.blob);
    els.pdfViewer.innerHTML = `<object data="${state.pdfUrl}" type="application/pdf"><iframe src="${state.pdfUrl}" title="PDF viewer"></iframe></object>`;
    els.openPdfLink.href = state.pdfUrl;
    els.openPdfLink.classList.remove("hidden");
  } catch {
    els.pdfViewer.innerHTML = `
      <div class="pdf-placeholder">
        <strong>PDF could not be loaded.</strong>
        <span>The paper entry remains saved. Attach the file again to restore the viewer.</span>
      </div>
    `;
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
  setFormMetadataStatus("");
  els.paperDialog.showModal();
  window.setTimeout(() => els.formTitle.focus(), 0);
}

async function createPaperFromForm(event) {
  event.preventDefault();
  if (state.editingId) {
    updatePaper(state.editingId, {
      title: els.formTitle.value.trim() || "Untitled paper",
      authors: els.formAuthors.value.trim(),
    });
    state.editingId = null;
    els.paperDialog.close();
    return;
  }

  const files = [...(els.formPdf.files || [])].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  const hasManualFields = Boolean(els.formTitle.value.trim() || els.formAuthors.value.trim());

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
      setFormMetadataStatus("Reading title and authors...");
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
  setSaveState("Reading title and authors...");
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

async function populateFormFromPdf(file) {
  if (!file) {
    state.pendingFormMetadata = null;
    setFormMetadataStatus("");
    return;
  }

  setFormMetadataStatus("Reading title and authors...");
  const metadata = await lookupPdfMetadata(file);
  state.pendingFormMetadata = metadata;
  applyMetadataToForm(metadata);

  if (metadata.title || metadata.authors) {
    setFormMetadataStatus(`<strong>Title/author metadata found.</strong> ${escapeHtml(metadata.title || metadata.authors || "")}`);
  } else {
    setFormMetadataStatus("No embedded title or authors were found. You can edit the fields manually.", true);
  }
}

function wireEvents() {
  els.newPaperBtn.addEventListener("click", openAddDialog);
  document.querySelectorAll("[data-open-add]").forEach((button) => {
    button.addEventListener("click", openAddDialog);
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingId = null;
      els.paperDialog.close();
    });
  });
  els.paperForm.addEventListener("submit", createPaperFromForm);

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

function seedIfEmpty() {
  if (state.papers.length) return;
  state.papers = [
    {
      id: uid(),
      title: "Example: A paper I want to read",
      authors: "Future You",
      status: "queue",
      categories: [],
      tags: ["sample"],
      question: "Why is this worth reading now?",
      notes: "Start notes as you read. Add page numbers so your PDF and notes stay linked.",
      highlights: "",
      takeaways: "",
      pdfId: null,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpened: "",
      readAt: "",
    },
  ];
  state.selectedId = state.papers[0].id;
  persistPapers();
}

function init() {
  state.papers = loadPapers();
  seedIfEmpty();
  state.selectedId = state.papers[0]?.id || null;
  wireEvents();
  render();
}

init();
