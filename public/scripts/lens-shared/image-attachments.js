// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared DOM image attachment tray, message attachment grid, and lightbox
// overlay for Workbench, SD Lens, Character Builder, and CardApp Studio.

import { h, clear, put } from './util.js';
import { sharedIcon } from './ui.js';
import { normalizeImageAttachments } from '../lib/multimodal-messages.js';

const CSS_LINK_ID = 'luker-lens-shared-image-attachments-css';

const i18n = (text) => globalThis.Luker?.getContext?.()?.translate?.(text) ?? String(text ?? '');

/**
 * Idempotently injects `lens-shared/image-attachments.css` into `document.head`
 * so both workbench views and standalone overlays (such as CardApp Studio) share
 * identical styles without requiring manual stylesheet imports.
 */
export function ensureImageAttachmentsStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    if (doc.getElementById(CSS_LINK_ID) || doc.querySelector('link[href*="lens-shared/image-attachments.css"]')) {
        return;
    }
    const link = doc.createElement('link');
    link.id = CSS_LINK_ID;
    link.rel = 'stylesheet';
    link.href = new URL('./image-attachments.css', import.meta.url).href;
    doc.head.appendChild(link);
}

/**
 * Opens a lightweight fullscreen lightbox overlay for an attached image.
 *
 * @param {string} src
 * @param {{ alt?: string, caption?: string, doc?: Document, renderIcon?: Function }} [options]
 */
export function openImageLightbox(src, {
    alt = '',
    caption = '',
    doc = globalThis.document,
    renderIcon = sharedIcon,
} = {}) {
    if (!src || !doc?.body) return null;
    ensureImageAttachmentsStyles(doc);

    const close = () => {
        doc.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };

    const closeBtn = h('button', {
        type: 'button',
        class: 'lw-att-lightbox-close',
        title: i18n('Close'),
        'aria-label': i18n('Close'),
        onClick: close,
    }, renderIcon('x', { size: 16 }));

    const overlay = h('div', {
        class: 'lw-att-lightbox',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': i18n('Image preview'),
        dataset: { lwRole: 'att-lightbox' },
        onClick: (e) => {
            if (e.target === overlay) close();
        },
    },
    h('div', { class: 'lw-att-lightbox-inner' },
        closeBtn,
        h('img', { class: 'lw-att-lightbox-img', src, alt: alt || caption || i18n('Image preview') }),
        caption ? h('div', { class: 'lw-att-lightbox-caption', text: caption }) : null));

    doc.addEventListener('keydown', onKeydown, true);
    doc.body.appendChild(overlay);
    closeBtn.focus?.({ preventScroll: true });
    return { close, el: overlay };
}

function isImageFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/')) return true;
    const name = String(file.name || '').toLowerCase();
    return /\.(png|jpe?g|webp|gif|bmp|jfif)$/i.test(name);
}

function extractImageFilesFromDataTransfer(dt) {
    if (!dt) return [];
    const files = [];
    if (dt.items && dt.items.length > 0) {
        for (const item of dt.items) {
            if (item?.kind === 'file') {
                const file = item.getAsFile?.();
                if (file && isImageFile(file)) {
                    files.push(file);
                }
            }
        }
    }
    if (files.length === 0 && dt.files && dt.files.length > 0) {
        for (const file of dt.files) {
            if (isImageFile(file)) {
                files.push(file);
            }
        }
    }
    return files;
}

/**
 * Creates a reusable, memory-staged image attachment controller bound to any
 * composer container and textarea. Pending images remain in memory as `File`
 * + `blob:` preview URLs until `commit(uploader)` is called on send.
 *
 * @param {{
 *   composerEl?: HTMLElement | null,
 *   textareaEl?: HTMLTextAreaElement | null,
 *   disabled?: boolean,
 *   buttonClass?: string,
 *   renderIcon?: Function,
 *   loadManagedPreview?: ((path: string) => Promise<string>) | null,
 *   onChange?: ((count: number) => void) | null,
 *   onError?: ((message: string) => void) | null,
 *   doc?: Document,
 * }} [options]
 */
export function createImageAttachmentTray({
    composerEl = null,
    textareaEl = null,
    disabled = false,
    buttonClass = '',
    renderIcon = sharedIcon,
    loadManagedPreview = null,
    onChange = null,
    onError = null,
    doc = globalThis.document,
} = {}) {
    ensureImageAttachmentsStyles(doc);

    let isDisabled = Boolean(disabled);
    let nextId = 1;
    let items = [];
    let dragDepth = 0;

    const fileInput = h('input', {
        type: 'file',
        accept: 'image/*',
        multiple: true,
        hidden: true,
        disabled: isDisabled,
        dataset: { lwRole: 'att-file-input' },
        onChange: (e) => {
            const list = e.target?.files;
            if (list && list.length > 0) {
                addFiles(list);
            }
            if (e.target) e.target.value = '';
        },
    });

    const attachButton = h('button', {
        type: 'button',
        class: `lw-att-btn ${buttonClass}`.trim(),
        title: i18n('Attach images'),
        'aria-label': i18n('Attach images'),
        disabled: isDisabled,
        dataset: { lwRole: 'att-button' },
        onClick: () => {
            if (isDisabled) return;
            fileInput.click();
        },
    }, renderIcon('image', { size: 16 }));

    const trayEl = h('div', {
        class: 'lw-att-tray',
        hidden: true,
        dataset: { lwRole: 'att-tray' },
    });

    function revokeItem(item) {
        if (item?.kind === 'file' && item.previewUrl && typeof URL?.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ }
        }
    }

    function createPreviewImg(item) {
        if (item.previewUrl) {
            return h('img', { src: item.previewUrl, alt: item.name || i18n('Attached image') });
        }
        if (item.kind === 'managed' && typeof loadManagedPreview === 'function') {
            const img = h('img', { alt: item.name || i18n('Attached image'), dataset: { loading: 'true' } });
            Promise.resolve(loadManagedPreview(item.path)).then(url => {
                if (url) {
                    item.previewUrl = url;
                    img.src = url;
                }
                delete img.dataset.loading;
            }).catch(err => {
                console.error(`[image-attachments] Failed to load managed preview for "${item.path}":`, err);
                img.dataset.previewError = String(err?.message || err);
                delete img.dataset.loading;
            });
            return img;
        }
        return h('img', { src: item.path, alt: item.name || i18n('Attached image') });
    }

    function paint() {
        clear(trayEl);
        trayEl.hidden = items.length === 0;
        for (const item of items) {
            const imgEl = createPreviewImg(item);
            const previewBtn = h('button', {
                type: 'button',
                class: 'lw-att-chip-preview',
                title: item.name || i18n('Preview image'),
                'aria-label': item.name || i18n('Preview image'),
                onClick: () => {
                    const src = imgEl.getAttribute('src') || item.previewUrl || item.path || '';
                    if (src) openImageLightbox(src, { alt: item.name, caption: item.name, doc, renderIcon });
                },
            }, imgEl);

            const removeBtn = h('button', {
                type: 'button',
                class: 'lw-att-chip-remove',
                title: i18n('Remove image'),
                'aria-label': i18n('Remove image'),
                disabled: isDisabled,
                dataset: { lwRole: 'att-remove', attId: item.id },
                onClick: (e) => {
                    e.stopPropagation();
                    if (isDisabled) return;
                    removeById(item.id);
                },
            }, renderIcon('x', { size: 11 }));

            put(trayEl, h('div', {
                class: 'lw-att-chip',
                dataset: { lwRole: 'att-chip', attId: item.id, attKind: item.kind },
            }, previewBtn, removeBtn));
        }
    }

    function notifyChange() {
        paint();
        onChange?.(items.length);
    }

    function addFiles(fileList) {
        if (isDisabled || !fileList) return 0;
        const arr = Array.from(fileList);
        let added = 0;
        let rejected = 0;
        for (const file of arr) {
            if (!isImageFile(file)) {
                rejected += 1;
                continue;
            }
            const previewUrl = typeof URL?.createObjectURL === 'function'
                ? URL.createObjectURL(file)
                : '';
            items.push({
                id: `att_${nextId++}`,
                kind: 'file',
                file,
                previewUrl,
                name: String(file.name || '').trim(),
                mime: String(file.type || '').trim(),
            });
            added += 1;
        }
        if (rejected > 0) {
            onError?.(i18n('Only image files can be attached.'));
        }
        if (added > 0) {
            notifyChange();
        }
        return added;
    }

    function setManagedItems(attachments, { cloneOnCommit = false } = {}) {
        clearItems();
        for (const att of normalizeImageAttachments(attachments)) {
            items.push({
                id: `att_${nextId++}`,
                kind: 'managed',
                path: att.path,
                name: att.name || '',
                mime: att.mime || '',
                previewUrl: '',
                cloneOnCommit: Boolean(cloneOnCommit),
            });
        }
        notifyChange();
    }

    function removeById(id) {
        const idx = items.findIndex(item => item.id === id);
        if (idx < 0) return;
        const [removed] = items.splice(idx, 1);
        revokeItem(removed);
        notifyChange();
    }

    function clearItems() {
        for (const item of items) {
            revokeItem(item);
        }
        items = [];
        notifyChange();
    }

    function setDisabled(nextDisabled) {
        isDisabled = Boolean(nextDisabled);
        attachButton.disabled = isDisabled;
        fileInput.disabled = isDisabled;
        if (isDisabled && composerEl) {
            dragDepth = 0;
            composerEl.classList.remove('lw-att-drop-active');
        }
        paint();
    }

    /**
     * Uploads all pending local `File` items via `uploader(files)` and resolves
     * any managed items (optionally cloning them via `cloneManaged(paths)`).
     * Preserves visual order. Does NOT clear the tray automatically unless `clearAfter: true`.
     */
    async function commit(uploader, { cloneManaged = null, clearAfter = true } = {}) {
        if (items.length === 0) return [];
        const snapshot = items.slice();
        const localEntries = snapshot.filter(item => item.kind === 'file');
        const cloneEntries = snapshot.filter(item => item.kind === 'managed' && item.cloneOnCommit);

        const uploadedList = localEntries.length > 0
            ? await uploader(localEntries.map(entry => entry.file))
            : [];
        if (uploadedList.length !== localEntries.length) {
            throw new Error('Image attachment upload returned an unexpected number of results.');
        }

        let copyMap = new Map();
        if (cloneEntries.length > 0 && typeof cloneManaged === 'function') {
            copyMap = await cloneManaged(cloneEntries.map(entry => entry.path));
        }

        let uploadCursor = 0;
        const resolved = [];
        for (const entry of snapshot) {
            if (entry.kind === 'file') {
                resolved.push(uploadedList[uploadCursor++]);
            } else {
                const nextPath = (entry.cloneOnCommit && copyMap instanceof Map && copyMap.get(entry.path))
                    || entry.path;
                resolved.push({
                    path: nextPath,
                    ...(entry.name ? { name: entry.name } : {}),
                    ...(entry.mime ? { mime: entry.mime } : {}),
                });
            }
        }

        const normalized = normalizeImageAttachments(resolved);
        if (clearAfter) {
            clearItems();
        }
        return normalized;
    }

    const onPaste = (e) => {
        if (isDisabled) return;
        const images = extractImageFilesFromDataTransfer(e.clipboardData);
        if (images.length === 0) return;
        const hasPlainText = Boolean(e.clipboardData?.getData?.('text/plain'));
        if (!hasPlainText) {
            e.preventDefault();
        }
        addFiles(images);
    };

    const hasFileDrag = (e) => {
        const types = e.dataTransfer?.types;
        if (!types) return false;
        return Array.from(types).includes('Files');
    };

    const onDragEnter = (e) => {
        if (isDisabled || !hasFileDrag(e)) return;
        e.preventDefault();
        dragDepth += 1;
        composerEl?.classList.add('lw-att-drop-active');
    };

    const onDragOver = (e) => {
        if (isDisabled || !hasFileDrag(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (e) => {
        if (!composerEl) return;
        if (!hasFileDrag(e) && dragDepth === 0) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            composerEl.classList.remove('lw-att-drop-active');
        }
    };

    const onDrop = (e) => {
        if (!composerEl) return;
        dragDepth = 0;
        composerEl.classList.remove('lw-att-drop-active');
        if (isDisabled) return;
        const images = extractImageFilesFromDataTransfer(e.dataTransfer);
        if (images.length === 0) return;
        e.preventDefault();
        addFiles(images);
    };

    textareaEl?.addEventListener('paste', onPaste);
    if (composerEl) {
        composerEl.addEventListener('dragenter', onDragEnter);
        composerEl.addEventListener('dragover', onDragOver);
        composerEl.addEventListener('dragleave', onDragLeave);
        composerEl.addEventListener('drop', onDrop);
    }

    function destroy() {
        textareaEl?.removeEventListener('paste', onPaste);
        if (composerEl) {
            composerEl.removeEventListener('dragenter', onDragEnter);
            composerEl.removeEventListener('dragover', onDragOver);
            composerEl.removeEventListener('dragleave', onDragLeave);
            composerEl.removeEventListener('drop', onDrop);
            composerEl.classList.remove('lw-att-drop-active');
        }
        for (const item of items) {
            revokeItem(item);
        }
        items = [];
    }

    return {
        attachButton,
        fileInput,
        trayEl,
        addFiles,
        setManagedItems,
        removeById,
        clear: clearItems,
        setDisabled,
        commit,
        destroy,
        hasItems: () => items.length > 0,
        getItems: () => items.slice(),
    };
}

/**
 * Renders persisted image attachments inside a sent user message bubble.
 *
 * @param {Array<{ path: string, name?: string, mime?: string }>} attachments
 * @param {{
 *   loadPreview?: ((path: string) => Promise<string>) | null,
 *   className?: string,
 *   doc?: Document,
 *   renderIcon?: Function,
 * }} [options]
 * @returns {HTMLElement | null}
 */
export function renderMessageAttachments(attachments, {
    loadPreview = null,
    className = '',
    doc = globalThis.document,
    renderIcon = sharedIcon,
} = {}) {
    const list = normalizeImageAttachments(attachments);
    if (list.length === 0) return null;
    ensureImageAttachmentsStyles(doc);

    return h('div', {
        class: `lw-att-msg-grid ${className}`.trim(),
        dataset: { lwRole: 'msg-attachments' },
    }, list.map(att => {
        const useAsyncPreview = typeof loadPreview === 'function';
        const img = useAsyncPreview
            ? h('img', { alt: att.name || i18n('Attached image'), dataset: { imagePath: att.path, loading: 'true' } })
            : h('img', { src: att.path, alt: att.name || i18n('Attached image'), dataset: { imagePath: att.path } });

        if (useAsyncPreview) {
            Promise.resolve(loadPreview(att.path)).then(url => {
                if (url) img.src = url;
                delete img.dataset.loading;
            }).catch(err => {
                console.error(`[image-attachments] Failed to load preview for "${att.path}":`, err);
                img.dataset.previewError = String(err?.message || err);
                delete img.dataset.loading;
            });
        }

        return h('button', {
            type: 'button',
            class: 'lw-att-msg-thumb',
            title: att.name || i18n('Preview image'),
            'aria-label': att.name || i18n('Preview image'),
            dataset: { lwRole: 'msg-att-thumb', imagePath: att.path },
            onClick: () => {
                const src = img.getAttribute('src') || (!useAsyncPreview ? att.path : '');
                if (src) openImageLightbox(src, { alt: att.name, caption: att.name, doc, renderIcon });
            },
        }, img);
    }));
}
