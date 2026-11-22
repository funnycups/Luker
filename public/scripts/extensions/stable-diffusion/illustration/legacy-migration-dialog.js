// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, put } from '../../../lens-shared/util.js';
import {
    clearPendingCharacterDesignPrompts,
    exportPendingCharacterDesignPromptsContent,
} from './settings.js';

const LEGACY_EXPORT_FILENAME = 'legacy-character-design-prompts.txt';

async function defaultExportFile(filename, content) {
    const text = String(content ?? '');
    const expectedBytes = new TextEncoder().encode(text).byteLength;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    if (blob.size !== expectedBytes) {
        throw new Error('Exported file size did not match the legacy prompt text.');
    }
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
}

async function defaultConfirmAction(context, message) {
    const popup = new context.Popup(
        h('p', { text: message }),
        context.POPUP_TYPE.CONFIRM,
        '',
        { okButton: context.translate?.('Confirm') ?? 'Confirm', cancelButton: context.translate?.('Cancel') ?? 'Cancel' },
    );
    const result = await popup.show();
    return result === context.POPUP_RESULT.AFFIRMATIVE || result === 1 || result === true;
}

export async function openLegacyCharacterDesignMigrationDialog({
    settings,
    context,
    exportFile = defaultExportFile,
    confirmAction = null,
    onResolved = null,
} = {}) {
    const pending = Array.isArray(settings?.pendingCharacterDesignPrompts)
        ? settings.pendingCharacterDesignPrompts.map(item => ({ ...item }))
        : [];
    if (pending.length === 0) {
        return { action: 'none' };
    }
    if (typeof context?.Popup !== 'function' || !context?.POPUP_TYPE) {
        throw new Error('Popup API is unavailable in the current context.');
    }

    const tr = text => context.translate?.(text) ?? String(text ?? '');
    const askConfirm = typeof confirmAction === 'function'
        ? confirmAction
        : message => defaultConfirmAction(context, message);

    let busy = false;
    let outcome = { action: 'cancelled' };
    let popup = null;

    const root = h('div', {
        class: 'sd-legacy-design-dialog',
        dataset: { sdRole: 'legacy-prompt-migration-dialog' },
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            textAlign: 'left',
            padding: '6px 2px',
        },
    });

    const errorEl = h('div', {
        role: 'alert',
        dataset: { sdRole: 'legacy-prompt-error' },
        style: { color: 'var(--warning, #d97706)', display: 'none', fontSize: '12.5px' },
    });

    const entriesWrap = h('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            maxHeight: '55vh',
            overflowY: 'auto',
        },
    });

    for (const entry of pending) {
        const ta = h('textarea', {
            class: 'textarea_compact text_pole',
            rows: 6,
            readonly: true,
            dataset: { sdRole: 'legacy-prompt-text', presetId: entry.presetId },
            style: { width: '100%', fontFamily: 'monospace' },
        });
        ta.value = entry.text;
        put(entriesWrap,
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('strong', { text: `${entry.presetName} (${entry.presetId})` }),
                ta));
    }

    const setError = message => {
        const text = String(message || '').trim();
        errorEl.textContent = text;
        errorEl.style.display = text ? 'block' : 'none';
    };

    const buttons = [];
    const setBusy = nextBusy => {
        busy = nextBusy;
        for (const btn of buttons) {
            btn.disabled = busy;
        }
    };

    async function persistClearedPending(actionName) {
        const previous = settings.pendingCharacterDesignPrompts
            ? settings.pendingCharacterDesignPrompts.map(item => ({ ...item }))
            : null;
        clearPendingCharacterDesignPrompts(settings);
        try {
            await context.workbench.saveSettingsChecked(context);
        } catch (error) {
            if (previous) {
                settings.pendingCharacterDesignPrompts = previous;
            }
            const msg = String(error?.message || error);
            setError(msg);
            globalThis.toastr?.error?.(msg, tr('Image Generation'));
            return false;
        }
        outcome = { action: actionName };
        onResolved?.(outcome);
        if (popup) {
            await popup.complete(context.POPUP_RESULT.AFFIRMATIVE);
        }
        return true;
    }

    const cancelBtn = h('button', {
        type: 'button',
        class: 'menu_button',
        text: tr('Cancel'),
        dataset: { sdRole: 'legacy-prompt-cancel' },
        onClick: async () => {
            if (busy) return;
            outcome = { action: 'cancelled' };
            if (popup) {
                await popup.complete(context.POPUP_RESULT.CANCELLED);
            }
        },
    });

    const discardBtn = h('button', {
        type: 'button',
        class: 'menu_button redWarningBG',
        text: tr('Discard legacy prompts'),
        dataset: { sdRole: 'legacy-prompt-discard' },
        onClick: async () => {
            if (busy) return;
            setError('');
            setBusy(true);
            try {
                const confirmed = await askConfirm(tr('Discard these legacy character design prompts permanently?'));
                if (!confirmed) return;
                await persistClearedPending('discarded');
            } finally {
                setBusy(false);
            }
        },
    });

    const exportBtn = h('button', {
        type: 'button',
        class: 'menu_button menu_button_icon',
        text: tr('Export & clear'),
        dataset: { sdRole: 'legacy-prompt-export' },
        onClick: async () => {
            if (busy) return;
            setError('');
            setBusy(true);
            try {
                const content = exportPendingCharacterDesignPromptsContent(pending);
                const exported = await exportFile(LEGACY_EXPORT_FILENAME, content);
                if (exported === false) {
                    return;
                }
                const confirmed = await askConfirm(tr('Confirm that you received the complete exported file before clearing these legacy prompts.'));
                if (!confirmed) return;
                await persistClearedPending('exported');
            } catch (error) {
                const msg = String(error?.message || error);
                setError(msg);
                globalThis.toastr?.error?.(msg, tr('Image Generation'));
            } finally {
                setBusy(false);
            }
        },
    });

    buttons.push(cancelBtn, discardBtn, exportBtn);

    put(root,
        h('h3', { style: { margin: '0' }, text: tr('Legacy character design prompts') }),
        h('p', {
            style: { margin: '0', fontSize: '12.5px' },
            text: tr('Character design prompt overrides are no longer used at runtime. Export these saved custom texts or discard them explicitly. Cancel keeps this record for later review.'),
        }),
        entriesWrap,
        errorEl,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
            cancelBtn,
            discardBtn,
            exportBtn));

    popup = new context.Popup(root, context.POPUP_TYPE.DISPLAY, '', {
        wide: true,
        allowEscapeClose: true,
    });
    await popup.show();
    return outcome;
}
