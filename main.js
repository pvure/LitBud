const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const libraryFile = () => path.join(app.getPath("userData"), "library.json");
const pdfDirectory = () => path.join(app.getPath("userData"), "pdfs");

async function ensureStorage() {
  await fs.mkdir(pdfDirectory(), { recursive: true });
  try {
    await fs.access(libraryFile());
  } catch {
    await fs.writeFile(libraryFile(), JSON.stringify({ papers: [] }, null, 2));
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
    return { papers: [] };
  }
}

async function writeLibrary(papers) {
  await ensureStorage();
  const payload = {
    savedAt: new Date().toISOString(),
    papers: Array.isArray(papers) ? papers : [],
  };
  await fs.writeFile(libraryFile(), JSON.stringify(payload, null, 2));
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
  await fs.writeFile(pdfPath(payload.id), buffer);
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
    dataDir: app.getPath("userData"),
    libraryFile: libraryFile(),
    pdfDir: pdfDirectory(),
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
