const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("litbudStorage", {
  loadLibrary: () => ipcRenderer.invoke("library:load"),
  saveLibrary: (papers) => ipcRenderer.invoke("library:save", papers),
  savePdf: (payload) => ipcRenderer.invoke("pdf:save", payload),
  readPdf: (id) => ipcRenderer.invoke("pdf:read", id),
  deletePdf: (id) => ipcRenderer.invoke("pdf:delete", id),
  storageInfo: () => ipcRenderer.invoke("storage:info"),
});
