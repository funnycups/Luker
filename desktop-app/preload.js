// The bridge the renderer uses to hand a downloaded update to the OS. The
// main process owns the network and the filesystem, so the renderer only
// names the asset to fetch and listens for progress; no Node API crosses the
// context boundary.
//
// Preload scripts run as sandboxed CommonJS regardless of the package's
// `"type": "module"`, so this file uses `require`, not ESM imports.
const { contextBridge, ipcRenderer } = require('electron');

let progressCallback = null;
let moveProgressCallback = null;

ipcRenderer.on('luker:update-progress', (_event, progress) => {
    if (typeof progressCallback === 'function') {
        progressCallback(progress);
    }
});

ipcRenderer.on('luker:data-move-progress', (_event, progress) => {
    if (typeof moveProgressCallback === 'function') {
        moveProgressCallback(progress);
    }
});

contextBridge.exposeInMainWorld('LukerDesktop', {
    platform: process.platform,
    arch: process.arch,
    installFlavour: ipcRenderer.sendSync('luker:install-flavour'),
    getDataDirectory: () => ipcRenderer.invoke('luker:get-data-directory'),
    chooseDataDirectory: () => ipcRenderer.invoke('luker:choose-data-directory'),
    installUpdateFromUrl: (url, name) => ipcRenderer.invoke('luker:install-update', { url, name }),
    setOpenExternalLinksInBrowser: (enabled) => ipcRenderer.invoke('luker:external-link-policy', Boolean(enabled)),
    onUpdateProgress: (callback) => {
        progressCallback = callback;
    },
    onDataMoveProgress: (callback) => {
        moveProgressCallback = callback;
    },
});
