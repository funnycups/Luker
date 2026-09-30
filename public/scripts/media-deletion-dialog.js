import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { humanFileSize } from './utils.js';

export const MEDIA_GC_ACTION = {
    DELETE: 'delete',
    SKIP: 'skip',
    CANCEL: 'cancel',
};

/**
 * Fetch associated media for a chat or character deletion.
 * @param {{scope: 'chat'|'character'} & Record<string, unknown>} target
 */
export async function fetchMediaDeletionCandidates(target) {
    const response = await fetch('/api/media/deletion-candidates', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(target),
    });
    if (!response.ok) {
        throw new Error(`deletion-candidates failed with status ${response.status}`);
    }
    return response.json();
}

/**
 * Delete explicitly selected media files.
 * @param {string[]} paths Client-relative paths returned by the candidate endpoint
 */
export async function deleteMediaFiles(paths) {
    const response = await fetch('/api/media/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ paths }),
    });
    if (!response.ok) {
        throw new Error(`media delete failed with status ${response.status}`);
    }
    return response.json();
}

function collectSelectedPaths(dialog) {
    return Array.from(dialog.querySelectorAll('.mediaDeletionItemCheckbox'))
        .filter(checkbox => checkbox.checked)
        .map(checkbox => checkbox.dataset.path)
        .filter(Boolean);
}

function updateSelectedCount(dialog, confirmLabel) {
    const count = collectSelectedPaths(dialog).length;
    const countLabel = dialog.querySelector('.mediaDeletionSelectedCount');
    if (countLabel) {
        countLabel.textContent = t`Selected: ${count}`;
    }
    const confirmButton = dialog.querySelector('.mediaDeletionConfirm');
    if (confirmButton) {
        confirmButton.textContent = `${confirmLabel} (${count})`;
    }
}

function wireSelectionControls(dialog, confirmLabel) {
    const checkboxes = Array.from(dialog.querySelectorAll('.mediaDeletionItemCheckbox'));
    const toggleAll = dialog.querySelector('.mediaDeletionToggleAll');
    const toggleNone = dialog.querySelector('.mediaDeletionToggleNone');
    if (toggleAll) {
        toggleAll.addEventListener('click', () => {
            checkboxes.forEach(checkbox => { checkbox.checked = true; });
            updateSelectedCount(dialog, confirmLabel);
        });
    }
    if (toggleNone) {
        toggleNone.addEventListener('click', () => {
            checkboxes.forEach(checkbox => { checkbox.checked = false; });
            updateSelectedCount(dialog, confirmLabel);
        });
    }
    checkboxes.forEach(checkbox => checkbox.addEventListener('change', () => updateSelectedCount(dialog, confirmLabel)));
    dialog.querySelectorAll('.mediaDeletionThumb').forEach(thumbnail => {
        thumbnail.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const preview = document.createElement('img');
            preview.src = thumbnail.getAttribute('src') ?? '';
            preview.alt = '';
            void callGenericPopup(preview, POPUP_TYPE.DISPLAY, '', { wide: true });
        });
    });
    updateSelectedCount(dialog, confirmLabel);
}

/**
 * Shows the media preview dialog.
 * @param {object} options
 * @param {Array<{kind: string, title: string, items: Array<{path: string, size: number}>}>} options.groups
 * @param {string[]} [options.notes] Already-translated note lines
 * @param {string} options.confirmLabel Label for the "delete with media" button
 * @param {string} options.skipLabel Label for the "delete entity only" button
 * @returns {Promise<{action: string, paths: string[]}>}
 */
export async function promptMediaDeletion({ groups, notes = [], confirmLabel, skipLabel }) {
    const viewModel = {
        groups: groups.map(group => ({
            kind: group.kind,
            title: group.title,
            totalLabel: humanFileSize(group.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0)),
            items: group.items.map(item => ({
                path: item.path,
                name: String(item.path).split('/').pop(),
                sizeLabel: humanFileSize(item.size),
            })),
        })),
        notes,
    };
    const content = await renderTemplateAsync('mediaDeletionDialog', viewModel);
    let selectedPaths = [];

    const result = await callGenericPopup(content, POPUP_TYPE.TEXT, '', {
        wide: true,
        okButton: false,
        cancelButton: false,
        customButtons: [
            {
                text: confirmLabel,
                result: POPUP_RESULT.CUSTOM1,
                classes: ['mediaDeletionConfirm'],
            },
            {
                text: skipLabel,
                result: POPUP_RESULT.CUSTOM2,
                classes: ['mediaDeletionSkip'],
            },
            {
                text: t`Cancel`,
                result: POPUP_RESULT.CANCELLED,
                classes: ['mediaDeletionCancel'],
                appendAtEnd: true,
            },
        ],
        onOpen: (popup) => wireSelectionControls(popup.dlg, confirmLabel),
        onClosing: (popup) => {
            selectedPaths = collectSelectedPaths(popup.dlg);
            return true;
        },
    });

    if (result === POPUP_RESULT.CUSTOM1) {
        return { action: MEDIA_GC_ACTION.DELETE, paths: selectedPaths };
    }
    if (result === POPUP_RESULT.CUSTOM2) {
        return { action: MEDIA_GC_ACTION.SKIP, paths: [] };
    }
    return { action: MEDIA_GC_ACTION.CANCEL, paths: [] };
}

/**
 * Shared toast for a media delete outcome.
 * @param {{failed?: string[]}} result
 */
export function notifyMediaDeleteResult(result) {
    if (Array.isArray(result?.failed) && result.failed.length > 0) {
        toastr.error(t`Some files could not be deleted.`, t`Media cleanup`);
    }
}
