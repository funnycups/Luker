// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// CardApp file API shared by the CardApp Studio shell (studio.js) and its
// AI tool executor (ai-chat.js).

function getRequestHeaders() {
    return Luker.getContext().getRequestHeaders();
}

function createHttpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}

export async function fetchFileList(charId) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/files`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
    });
    if (!response.ok) throw createHttpError(`Failed to list files: ${response.status}`, response.status);
    const data = await response.json();
    return data.files || [];
}

export async function fetchFileContent(charId, filePath) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
    });
    if (!response.ok) throw createHttpError(`Failed to read file: ${response.status}`, response.status);
    return await response.text();
}

export async function saveFileContent(charId, filePath, content) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    if (!response.ok) throw createHttpError(`Failed to save file: ${response.status}`, response.status);
    return await response.json();
}

export async function deleteFile(charId, filePath) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
        headers: getRequestHeaders(),
    });
    if (!response.ok) throw createHttpError(`Failed to delete file: ${response.status}`, response.status);
    return await response.json();
}

export async function renameFile(charId, fromPath, toPath) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/rename`, {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromPath, to: toPath }),
    });
    if (!response.ok) throw createHttpError(`Failed to rename file: ${response.status}`, response.status);
    return await response.json();
}
