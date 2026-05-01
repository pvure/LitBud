const http = require("http");
const fs = require("fs/promises");
const createReadStream = require("fs").createReadStream;
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT || 4317);
const ROOT = __dirname;
const LIBRARY_DIR = process.env.PAPERS_LIBRARY_DIR || path.join(os.homedir(), "Documents", "Papers Library");
const PDF_DIR = path.join(LIBRARY_DIR, "pdfs");
const BACKUP_DIR = path.join(LIBRARY_DIR, "backups");
const LIBRARY_FILE = path.join(LIBRARY_DIR, "library.json");
const MAX_LIBRARY_BACKUPS = 100;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".map": "application/json; charset=utf-8",
};

async function ensureStorage() {
  await fs.mkdir(PDF_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  try {
    await fs.access(LIBRARY_FILE);
  } catch {
    await atomicWriteJson(LIBRARY_FILE, { savedAt: new Date().toISOString(), papers: [] }, false);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readRequestBody(req, limitBytes = 800 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buffer = await readRequestBody(req, 200 * 1024 * 1024);
  return JSON.parse(buffer.toString("utf8") || "{}");
}

async function readLibrary() {
  await ensureStorage();
  const raw = await fs.readFile(LIBRARY_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return { papers: Array.isArray(parsed.papers) ? parsed.papers : [] };
  } catch {
    const corruptName = `library-corrupt-${Date.now()}.json`;
    await fs.copyFile(LIBRARY_FILE, path.join(BACKUP_DIR, corruptName));
    return { papers: [] };
  }
}

async function atomicWriteJson(filePath, payload, backupExisting = true) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (backupExisting) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.copyFile(filePath, path.join(BACKUP_DIR, `library-${stamp}.json`));
      await pruneBackups();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
  await fs.rename(tempFile, filePath);
}

async function pruneBackups() {
  const entries = await fs.readdir(BACKUP_DIR);
  const backups = entries
    .filter((name) => name.startsWith("library-") && name.endsWith(".json"))
    .sort()
    .reverse();

  await Promise.all(
    backups.slice(MAX_LIBRARY_BACKUPS).map((name) => fs.unlink(path.join(BACKUP_DIR, name)).catch(() => {}))
  );
}

function safePdfPath(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error("Invalid PDF id");
  }
  return path.join(PDF_DIR, `${id}.pdf`);
}

async function savePdf(id, buffer) {
  await fs.mkdir(PDF_DIR, { recursive: true });
  const destination = safePdfPath(id);
  const tempFile = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, buffer);
  await fs.rename(tempFile, destination);
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(ROOT)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendError(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": stat.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendError(res, 404, "Not found");
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/storage-info" && req.method === "GET") {
    sendJson(res, 200, {
      mode: "local-server",
      libraryDir: LIBRARY_DIR,
      libraryFile: LIBRARY_FILE,
      pdfDir: PDF_DIR,
      backupDir: BACKUP_DIR,
    });
    return;
  }

  if (url.pathname === "/api/library" && req.method === "GET") {
    sendJson(res, 200, await readLibrary());
    return;
  }

  if (url.pathname === "/api/library" && req.method === "PUT") {
    const body = await readJsonBody(req);
    const payload = {
      savedAt: new Date().toISOString(),
      papers: Array.isArray(body.papers) ? body.papers : [],
    };
    await atomicWriteJson(LIBRARY_FILE, payload);
    sendJson(res, 200, payload);
    return;
  }

  const pdfMatch = url.pathname.match(/^\/api\/pdf\/([^/]+)$/);
  if (pdfMatch && req.method === "GET") {
    const id = decodeURIComponent(pdfMatch[1]);
    const filePath = safePdfPath(id);
    const stat = await fs.stat(filePath);
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": stat.size,
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  if (pdfMatch && req.method === "PUT") {
    const id = decodeURIComponent(pdfMatch[1]);
    const buffer = await readRequestBody(req);
    await savePdf(id, buffer);
    sendJson(res, 200, { id });
    return;
  }

  if (pdfMatch && req.method === "DELETE") {
    const id = decodeURIComponent(pdfMatch[1]);
    try {
      await fs.unlink(safePdfPath(id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, "Not found");
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || "Internal server error");
  }
}

ensureStorage()
  .then(() => {
    http.createServer(handleRequest).listen(PORT, "127.0.0.1", () => {
      console.log(`Papers is running at http://localhost:${PORT}`);
      console.log(`Library folder: ${LIBRARY_DIR}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
