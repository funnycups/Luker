// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { collectUnembeddedPresets } from './collect-unembedded-presets.js';

/**
 * Shared preflight for orchestrator paths that write a profile onto a
 * character card override — both the editor-panel "Save To Character
 * Override" action and the iter-studio "Apply to Character" commit.
 *
 * Runs the classifier in `collect-unembedded-presets.js` against the
 * profile the caller is about to persist.  If every referenced preset
 * name is either already embedded on the card or unknown locally
 * (runtime falls back to `settings.llmNodePresetName`), returns
 * `{ proceed: true, embeddedCount: 0 }` and the caller persists as-is.
 *
 * Otherwise the caller sees a 3-button popup:
 *
 *   - Embed all       → for each candidate, `ctx.character.presets.add`
 *                       is called with the local stored body from
 *                       `getPresetManager('openai').getStoredPreset`;
 *                       returns { proceed: true, embeddedCount: N }.
 *   - Save names only → skip embed, caller persists the profile as-is;
 *                       returns { proceed: true, embeddedCount: 0 }.
 *   - Cancel          → abort; caller MUST NOT persist the profile;
 *                       returns { proceed: false, embeddedCount: 0 }.
 *
 * The popup body / button labels come from the orchestrator's in-file
 * i18n table so both callers share the same wording without hard-coding
 * English strings here.
 *
 * @param {object}   deps
 * @param {object}   deps.context             SillyTavern context (Luker-augmented).
 * @param {object}   deps.activeCharacter     Character object (proxy-safe; caller
 *                                            resolves via ctx.characters.find).
 * @param {object}   deps.profile             Sanitized profile draft (loop/agenda/
 *                                            director shape with `mode` field set).
 * @param {(k: string) => string}                    deps.i18n
 * @param {(k: string, ...args: any[]) => string}    deps.i18nFormat
 * @param {(msg: string) => void}                    deps.notifyError
 * @param {(v: unknown) => string}                   deps.escapeHtml
 * @returns {Promise<{proceed: boolean, embeddedCount: number}>}
 */
export async function promptEmbedUnembeddedPresetsForCharacterApply({
    context,
    activeCharacter,
    profile,
    i18n,
    i18nFormat,
    notifyError,
    escapeHtml,
}) {
    const resolveByName = context?.character?.presets?.resolveByName;
    const unembedded = activeCharacter
        ? collectUnembeddedPresets(profile, activeCharacter, resolveByName)
        : [];

    if (unembedded.length === 0) {
        return { proceed: true, embeddedCount: 0 };
    }

    const EMBED_RESULT = context.POPUP_RESULT?.AFFIRMATIVE ?? 1;
    const NAMES_ONLY_RESULT = context.POPUP_RESULT?.CUSTOM1 ?? 1001;
    const CANCEL_RESULT = context.POPUP_RESULT?.CANCELLED ?? 0;
    const listHtml = unembedded.map((entry) => {
        const usageText = entry.usages.join(', ');
        return `<li><b>${escapeHtml(entry.name)}</b> <span class="dim">(${escapeHtml(usageText)})</span></li>`;
    }).join('');
    const bodyHtml = [
        `<p>${escapeHtml(i18n('The orchestrator profile references the following presets not yet embedded in this card:'))}</p>`,
        `<ul>${listHtml}</ul>`,
        `<p>${escapeHtml(i18n('Embed them alongside the profile so recipients can use the card immediately?'))}</p>`,
    ].join('');
    // Button layout: [Embed all] [Save names only] [Cancel]. The popup
    // framework's template DOM order is [ok] [cancel]; a custom button
    // with `appendAtEnd: true` renders AFTER cancel, so keeping the
    // built-in cancel would yield [Embed all] [Cancel] [Save names only].
    // Hide the built-in cancel and re-express it as a trailing custom
    // button so cancel sits at the far right — the conventional escape
    // position — with the destructive-scale order primary→alternative→
    // abort reading left-to-right.
    const choice = await context.callGenericPopup(
        bodyHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Save orchestrator profile to character card'),
        {
            okButton: i18n('Embed all'),
            cancelButton: false,
            customButtons: [
                { text: i18n('Save names only'), result: NAMES_ONLY_RESULT, appendAtEnd: true },
                { text: i18n('Cancel'), result: CANCEL_RESULT, appendAtEnd: true },
            ],
        },
    );

    if (choice === CANCEL_RESULT || choice === undefined || choice === null) {
        return { proceed: false, embeddedCount: 0 };
    }

    if (choice !== EMBED_RESULT) {
        // NAMES_ONLY_RESULT (or any non-cancel non-embed sentinel) →
        // caller persists the profile as-is without adding preset embeds.
        return { proceed: true, embeddedCount: 0 };
    }

    // Embed all path.
    const presetManager = context.getPresetManager?.('openai');
    const addPreset = context?.character?.presets?.add;
    if (typeof addPreset !== 'function') {
        notifyError(i18n('Character-bound preset API is unavailable; cannot embed.'));
        // Fall through and let the caller persist the profile; the
        // orchestrator profile write is independent of the preset embed
        // step and preserving that behavior avoids surprising the user
        // when their apply completes but the popup couldn't reach the
        // preset API.
        return { proceed: true, embeddedCount: 0 };
    }

    let embeddedCount = 0;
    for (const entry of unembedded) {
        const body = presetManager?.getStoredPreset?.(entry.name);
        if (!body) {
            notifyError(i18nFormat('Local preset "${0}" not found; skipped.', entry.name));
            continue;
        }
        await addPreset(activeCharacter, entry.name, body);
        embeddedCount += 1;
    }
    return { proceed: true, embeddedCount };
}
