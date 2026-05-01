const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const MAX_LIBRARY_BACKUPS = 100;
const libraryDirectory = () => path.join(app.getPath("documents"), "Papers Library");
const libraryFile = () => path.join(libraryDirectory(), "library.json");
const pdfDirectory = () => path.join(libraryDirectory(), "pdfs");
const backupDirectory = () => path.join(libraryDirectory(), "backups");

async function ensureStorage() {
  await fs.mkdir(pdfDirectory(), { recursive: true });
  await fs.mkdir(backupDirectory(), { recursive: true });
  try {
    await fs.access(libraryFile());
  } catch {
    await atomicWriteJson(libraryFile(), { savedAt: new Date().toISOString(), papers: [] }, false);
  }
}

function pdfPath(id) {
  return path.join(pdfDirectory(), `${id}.pdf`);
}

async function readLibrary() {
  await ensureStorage();
  const raw = await fs.readFile(libraryFile(), "utf8");
  try {
    const parsed = JSON.parse(raw);
    return { papers: Array.isArray(parsed.papers) ? parsed.papers : [] };
  } catch {
    const corruptName = `library-corrupt-${Date.now()}.json`;
    await fs.copyFile(libraryFile(), path.join(backupDirectory(), corruptName));
    return { papers: [] };
  }
}

async function pruneBackups() {
  const entries = await fs.readdir(backupDirectory());
  const backups = entries
    .filter((name) => name.startsWith("library-") && name.endsWith(".json"))
    .sort()
    .reverse();

  await Promise.all(
    backups.slice(MAX_LIBRARY_BACKUPS).map((name) => fs.unlink(path.join(backupDirectory(), name)).catch(() => {}))
  );
}

async function atomicWriteJson(filePath, payload, backupExisting = true) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (backupExisting) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.copyFile(filePath, path.join(backupDirectory(), `library-${stamp}.json`));
      await pruneBackups();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
  await fs.rename(tempFile, filePath);
}

async function writeLibrary(papers) {
  await ensureStorage();
  const payload = {
    savedAt: new Date().toISOString(),
    papers: Array.isArray(papers) ? papers : [],
  };
  await atomicWriteJson(libraryFile(), payload);
  return payload;
}

async function createWindow() {
  await ensureStorage();

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    title: "Papers",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("library:load", readLibrary);

ipcMain.handle("library:save", async (_event, papers) => {
  return writeLibrary(papers);
});

ipcMain.handle("pdf:save", async (_event, payload) => {
  await ensureStorage();
  const buffer = Buffer.from(payload.arrayBuffer);
  const destination = pdfPath(payload.id);
  const tempFile = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, buffer);
  await fs.rename(tempFile, destination);
  return {
    id: payload.id,
    name: payload.name,
    type: payload.type || "application/pdf",
  };
});

ipcMain.handle("pdf:read", async (_event, id) => {
  const buffer = await fs.readFile(pdfPath(id));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return {
    id,
    name: `${id}.pdf`,
    type: "application/pdf",
    arrayBuffer,
  };
});

ipcMain.handle("pdf:delete", async (_event, id) => {
  try {
    await fs.unlink(pdfPath(id));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return true;
});

ipcMain.handle("storage:info", async () => {
  await ensureStorage();
  return {
    dataDir: libraryDirectory(),
    libraryFile: libraryFile(),
    pdfDir: pdfDirectory(),
    backupDir: backupDirectory(),
  };
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
