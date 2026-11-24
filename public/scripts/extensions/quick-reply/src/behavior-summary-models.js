// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Quick Reply (Global & Per-Set).
// All runtime checks mirror ButtonUi.js, AutoExecuteHandler.js,
// QuickReplySet.js, and QuickReplySettings.js. No DOM dependencies.

const GLOBAL_SUBFIELDS = Object.freeze([
    'isCombined',
    'showPopoutButton',
]);

const SET_SUBFIELDS = Object.freeze([
    'disableSend',
    'placeBeforeInput',
    'injectInput',
    'onlyBorderColor',
]);

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function clampNonNegInt(raw, fallback = 0) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, parsed);
}

function resolveScopeLabel(scope, translate) {
    switch (scope) {
        case 'global':
            return translate('Global');
        case 'chat':
            return translate('Chat');
        case 'character':
            return translate('Character');
        default:
            return String(scope);
    }
}

/**
 * Card 1: Quick Reply global settings summary (enablement, linked set counts,
 * bar layout, and desktop >1000px popout button visibility).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildQuickReplyGlobalSummary(state = {}) {
    const translate = typeof state.i18n === 'function'
        ? state.i18n
        : (typeof state.translate === 'function' ? state.translate : defaultTranslate);

    const isEnabled = Boolean(state.isEnabled);
    if (!isEnabled) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('${isEnabled} is off — Quick Reply bar and auto-execute triggers are inactive, while manual /run still works.'),
                tokens: {
                    isEnabled: {
                        field: 'isEnabled',
                        text: translate('Enable Quick Replies'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...GLOBAL_SUBFIELDS],
        };
    }

    const isCombined = Boolean(state.isCombined);
    const showPopoutButton = Boolean(state.showPopoutButton);
    const globalCount = clampNonNegInt(state.globalCount, 0);
    const chatCount = clampNonNegInt(state.chatCount, 0);
    const charCount = clampNonNegInt(state.charCount, 0);
    const hiddenCount = state.hiddenCount !== undefined
        ? clampNonNegInt(state.hiddenCount, 0)
        : (clampNonNegInt(state.globalHiddenCount, 0)
            + clampNonNegInt(state.chatHiddenCount, 0)
            + clampNonNegInt(state.charHiddenCount, 0));
    const hasChat = state.hasChat !== false;
    const hasCharacter = state.hasCharacter !== false;

    const scopeRow = {
        role: translate('Scope'),
        template: hiddenCount > 0
            ? translate('Bar sets: ${globalSets} global · ${chatSets} chat · ${charSets} character (${hiddenSets} hidden, auto-execute only).')
            : translate('Bar sets: ${globalSets} global · ${chatSets} chat · ${charSets} character.'),
        tokens: {
            globalSets: {
                field: 'globalSets',
                text: String(globalCount),
                tone: globalCount > 0 ? 'active' : 'off',
            },
            chatSets: {
                field: 'chatSets',
                text: hasChat ? String(chatCount) : translate('no active chat'),
                tone: hasChat && chatCount > 0 ? 'active' : 'off',
            },
            charSets: {
                field: 'charSets',
                text: hasCharacter ? String(charCount) : translate('no active character'),
                tone: hasCharacter && charCount > 0 ? 'active' : 'off',
            },
            ...(hiddenCount > 0
                ? {
                    hiddenSets: {
                        field: null,
                        text: String(hiddenCount),
                        tone: 'off',
                    },
                }
                : {}),
        },
    };

    const layoutRow = {
        role: translate('Behavior'),
        template: translate('${isCombined} · ${showPopoutButton}.'),
        tokens: {
            isCombined: {
                field: 'isCombined',
                text: isCombined
                    ? translate('combines all sets into one bar')
                    : translate('renders each set in its own bar'),
                tone: isCombined ? 'active' : 'off',
            },
            showPopoutButton: {
                field: 'showPopoutButton',
                text: showPopoutButton
                    ? translate('shows popout button on desktop (>1000px only, hidden on <=1000px)')
                    : translate('popout button hidden'),
                tone: showPopoutButton ? 'active' : 'off',
            },
        },
    };

    return {
        tone: 'active',
        rows: [scopeRow, layoutRow],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * Card 2: Quick Reply per-set editor summary (linked scopes, Disable Send vs
 * /commands, automatic input injection, and before-input placement).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildQuickReplySetSummary(state = {}) {
    const translate = typeof state.i18n === 'function'
        ? state.i18n
        : (typeof state.translate === 'function' ? state.translate : defaultTranslate);

    const setName = String(state.setName ?? '').trim();
    if (!setName) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('No Quick Reply set selected.'),
                tokens: {},
            }],
            warnings: [],
            dormantFields: [...SET_SUBFIELDS],
        };
    }

    const disableSend = Boolean(state.disableSend);
    const placeBeforeInput = Boolean(state.placeBeforeInput);
    const injectInput = Boolean(state.injectInput);
    const rawScopes = Array.isArray(state.linkedScopes) ? state.linkedScopes.filter(Boolean) : [];
    const linkedScopes = [];
    for (const s of rawScopes) {
        if (!linkedScopes.includes(s)) linkedScopes.push(s);
    }
    const isLinked = linkedScopes.length > 0;

    let visibleScopes;
    if (Array.isArray(state.visibleScopes)) {
        visibleScopes = [];
        for (const s of state.visibleScopes.filter(Boolean)) {
            if (linkedScopes.includes(s) && !visibleScopes.includes(s)) {
                visibleScopes.push(s);
            }
        }
    } else {
        visibleScopes = [...linkedScopes];
    }
    const hiddenScopes = linkedScopes.filter((s) => !visibleScopes.includes(s));
    const hasVisibleScope = visibleScopes.length > 0;

    const listSep = translate(', ');
    let scopeRow;
    if (!isLinked) {
        scopeRow = {
            role: translate('Scope'),
            tone: 'off',
            template: translate('${setName} is not linked to Global, Chat, or Character sets — inactive in the Quick Reply bar and auto-execute (manual /run only).'),
            tokens: {
                setName: {
                    field: 'setName',
                    text: setName,
                    tone: 'off',
                },
            },
        };
    } else if (!hasVisibleScope) {
        scopeRow = {
            role: translate('Scope'),
            template: translate('${setName} is linked in ${scopes} with Buttons off — hidden from the Quick Reply bar, active for auto-execute triggers only.'),
            tokens: {
                setName: {
                    field: 'setName',
                    text: setName,
                    tone: 'active',
                },
                scopes: {
                    field: null,
                    text: linkedScopes.map((scope) => resolveScopeLabel(scope, translate)).join(listSep),
                    tone: 'active',
                },
            },
        };
    } else if (hiddenScopes.length > 0) {
        scopeRow = {
            role: translate('Scope'),
            template: translate('${setName} is linked in ${scopes} (Buttons off in ${hiddenScopes}) — active in the Quick Reply bar and auto-execute triggers.'),
            tokens: {
                setName: {
                    field: 'setName',
                    text: setName,
                    tone: 'active',
                },
                scopes: {
                    field: null,
                    text: linkedScopes.map((scope) => resolveScopeLabel(scope, translate)).join(listSep),
                    tone: 'active',
                },
                hiddenScopes: {
                    field: null,
                    text: hiddenScopes.map((scope) => resolveScopeLabel(scope, translate)).join(listSep),
                    tone: 'off',
                },
            },
        };
    } else {
        scopeRow = {
            role: translate('Scope'),
            template: translate('${setName} is linked in ${scopes} — active in the Quick Reply bar and auto-execute triggers.'),
            tokens: {
                setName: {
                    field: 'setName',
                    text: setName,
                    tone: 'active',
                },
                scopes: {
                    field: null,
                    text: linkedScopes.map((scope) => resolveScopeLabel(scope, translate)).join(listSep),
                    tone: 'active',
                },
            },
        };
    }

    const disableSendToken = {
        field: 'disableSend',
        text: disableSend
            ? translate('inserts into input box without sending and pastes /commands as text instead of executing')
            : translate('sends message immediately or executes /commands'),
        tone: disableSend ? 'active' : 'off',
    };

    const injectInputToken = {
        field: 'injectInput',
        text: injectInput
            ? translate('auto-injects user input')
            : translate('manual {{input}} macro only'),
        tone: injectInput ? 'active' : 'off',
    };

    const behaviorRow = injectInput
        ? {
            role: translate('Behavior'),
            template: translate('On click: ${disableSend} · ${injectInput} (${placeBeforeInput}).'),
            tokens: {
                disableSend: disableSendToken,
                injectInput: injectInputToken,
                placeBeforeInput: {
                    field: 'placeBeforeInput',
                    text: placeBeforeInput
                        ? translate('places quick reply before user input')
                        : translate('appends quick reply after user input'),
                    tone: placeBeforeInput ? 'active' : 'off',
                },
            },
        }
        : {
            role: translate('Behavior'),
            template: translate('On click: ${disableSend} · ${injectInput}.'),
            tokens: {
                disableSend: disableSendToken,
                injectInput: injectInputToken,
            },
        };

    const warnings = [];
    if (placeBeforeInput && !injectInput) {
        warnings.push({
            severity: 'warn',
            template: translate('${placeBeforeInput} has no effect while ${injectInput} is off.'),
            tokens: {
                placeBeforeInput: {
                    field: 'placeBeforeInput',
                    text: translate('Place quick reply before input', 'Place Quick Reply Before Input'),
                    tone: 'warn',
                },
                injectInput: {
                    field: 'injectInput',
                    text: translate('Inject user input automatically'),
                    tone: 'warn',
                },
            },
        });
    }

    const dormantFields = [];
    if (!injectInput) {
        dormantFields.push('placeBeforeInput');
    }

    let tone = 'active';
    if (warnings.length > 0) {
        tone = 'warn';
    } else if (!isLinked) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [scopeRow, behaviorRow],
        warnings,
        dormantFields,
    };
}
