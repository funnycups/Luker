// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Preload scripts run as sandboxed CommonJS regardless of the package's
// `"type": "module"`, so this file uses `require`, not ESM imports.
const { contextBridge, ipcRenderer } = require('electron');

let contextCallback = null;

ipcRenderer.on('luker:http-auth:context', (_event, context) => {
    if (typeof contextCallback === 'function') {
        contextCallback(context);
    }
});

contextBridge.exposeInMainWorld('lukerHttpAuth', {
    submit(username, password) {
        ipcRenderer.send('luker:http-auth:submit', { username, password });
    },
    cancel() {
        ipcRenderer.send('luker:http-auth:cancel');
    },
    onContext(callback) {
        contextCallback = callback;
    },
});
