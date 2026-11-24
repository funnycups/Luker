// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary model for Regex Editor rules.
// All runtime scope, lane, depth, and conflict checks mirror
// public/scripts/extensions/regex/engine.js and core call sites.
// No DOM dependencies.

const PLACEMENT_ORDER = Object.freeze([1, 2, 3, 5, 6]);

const ALL_RULE_FIELDS = Object.freeze([
    'placements',
    'pluginRequest',
    'pluginReply',
    'minDepth',
    'maxDepth',
    'runOnEdit',
    'substituteRegex',
    'markdownOnly',
    'promptOnly',
]);

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function normalizePlacements(rawPlacements) {
    if (!Array.isArray(rawPlacements)) {
        return [];
    }
    const present = new Set();
    for (const item of rawPlacements) {
        const num = Number.parseInt(String(item), 10);
        if (Number.isFinite(num)) {
            present.add(num);
        }
    }
    const ordered = PLACEMENT_ORDER.filter((code) => present.has(code));
    for (const code of present) {
        if (!ordered.includes(code)) {
            ordered.push(code);
        }
    }
    return ordered;
}

function parseDepthBound(raw, minValid) {
    if (raw === null || raw === undefined) {
        return null;
    }
    const str = String(raw).trim();
    if (!str || str === '-') {
        return null;
    }
    if (!/^-?\d+$/.test(str)) {
        return null;
    }
    const parsed = Number.parseInt(str, 10);
    if (!Number.isFinite(parsed) || parsed < minValid) {
        return null;
    }
    return parsed;
}

function placementLabel(code, translate) {
    switch (code) {
        case 1:
            return translate('User Input', 'ext_regex_user_input');
        case 2:
            return translate('AI Output', 'ext_regex_ai_output');
        case 3:
            return translate('Slash Commands');
        case 5:
            return translate('World Info');
        case 6:
            return translate('Reasoning');
        default:
            return String(code);
    }
}

function substituteLabel(rawMode, translate) {
    switch (Number(rawMode)) {
        case 1:
            return { text: translate('raw macro substitution'), tone: 'active' };
        case 2:
            return { text: translate('escaped macro substitution'), tone: 'active' };
        case 0:
        default:
            return { text: translate('no macro substitution'), tone: 'off' };
    }
}

function formatDepthToken(minDepth, maxDepth, hasInvertedDepth, translate) {
    const field = (minDepth === null && maxDepth !== null)
        ? ['maxDepth', 'minDepth']
        : ['minDepth', 'maxDepth'];

    if (hasInvertedDepth) {
        return {
            field,
            text: translate('depths ${min}–${max} (invalid: min > max)')
                .replace('${min}', String(minDepth))
                .replace('${max}', String(maxDepth)),
            tone: 'danger',
        };
    }

    if (minDepth !== null && maxDepth !== null) {
        if (minDepth === maxDepth) {
            return {
                field,
                text: translate('exact depth ${depth}').replace('${depth}', String(minDepth)),
                tone: 'active',
            };
        }
        if (minDepth === -1) {
            return {
                field,
                text: translate('Continue (-1) to depth ${max}').replace('${max}', String(maxDepth)),
                tone: 'active',
            };
        }
        return {
            field,
            text: translate('depths ${min}–${max}')
                .replace('${min}', String(minDepth))
                .replace('${max}', String(maxDepth)),
            tone: 'active',
        };
    }

    if (minDepth !== null) {
        if (minDepth === -1) {
            return {
                field,
                text: translate('all depths (includes Continue)'),
                tone: 'off',
            };
        }
        return {
            field,
            text: translate('depths >= ${min} (excludes Continue)').replace('${min}', String(minDepth)),
            tone: 'active',
        };
    }

    if (maxDepth !== null) {
        return {
            field,
            text: translate('depths <= ${max} (includes Continue)').replace('${max}', String(maxDepth)),
            tone: 'active',
        };
    }

    return {
        field,
        text: translate('all depths (includes Continue)'),
        tone: 'off',
    };
}

function buildScopeRow({
    placements,
    markdownOnly,
    promptOnly,
    pluginRequest,
    pluginReply,
    hasScopedTarget,
    isPluginReplyOnly,
    depthToken,
    substituteToken,
    translate,
}) {
    const listSep = translate(', ');
    const hasPlacements = placements.length > 0;
    const placementsText = hasPlacements
        ? placements.map((code) => placementLabel(code, translate)).join(listSep)
        : translate('no message types');

    if (isPluginReplyOnly) {
        return {
            role: translate('Scope'),
            template: translate('Applies to ${pluginReply} (${substituteRegex}) — ${placements} and ${depth} are ignored.'),
            tokens: {
                pluginReply: {
                    field: 'pluginReply',
                    text: translate('Plugin Replies'),
                    tone: 'active',
                },
                substituteRegex: substituteToken,
                placements: {
                    field: 'placements',
                    text: hasPlacements ? placementsText : translate('message types'),
                    tone: 'off',
                },
                depth: {
                    ...depthToken,
                    tone: depthToken.tone === 'danger' ? 'danger' : 'off',
                },
            },
        };
    }

    const placementsToken = {
        field: 'placements',
        text: placementsText,
        tone: hasPlacements ? 'active' : 'danger',
    };

    if (!hasScopedTarget) {
        return {
            role: translate('Scope'),
            template: translate('Targets ${placements} (${substituteRegex}) — ${depth} ignored on permanent history writes.'),
            tokens: {
                placements: placementsToken,
                substituteRegex: substituteToken,
                depth: {
                    ...depthToken,
                    tone: depthToken.tone === 'danger' ? 'danger' : 'off',
                },
            },
        };
    }

    const tokens = {
        placements: placementsToken,
        depth: depthToken,
        substituteRegex: substituteToken,
    };

    if (pluginRequest) {
        tokens.pluginRequest = {
            field: 'pluginRequest',
            text: translate('Plugin Requests'),
            tone: hasPlacements ? 'active' : 'danger',
        };
    }
    if (pluginReply) {
        tokens.pluginReply = {
            field: 'pluginReply',
            text: translate('Plugin Replies'),
            tone: 'active',
        };
    }

    if (!pluginRequest && !pluginReply) {
        return {
            role: translate('Scope'),
            template: translate('Targets ${placements}, ${depth}, ${substituteRegex}.'),
            tokens,
        };
    }

    if (pluginRequest && !pluginReply) {
        return {
            role: translate('Scope'),
            template: (!markdownOnly && !promptOnly)
                ? translate('Targets ${placements} on ${pluginRequest}, ${depth}, ${substituteRegex}.')
                : translate('Targets ${placements} (and ${pluginRequest}), ${depth}, ${substituteRegex}.'),
            tokens,
        };
    }

    if (!pluginRequest && pluginReply) {
        return {
            role: translate('Scope'),
            template: translate('Targets ${placements} (${depth}) plus ${pluginReply} (ignores message types and depth), ${substituteRegex}.'),
            tokens,
        };
    }

    return {
        role: translate('Scope'),
        template: translate('Targets ${placements} (and ${pluginRequest}, ${depth}) plus ${pluginReply} (ignores message types and depth), ${substituteRegex}.'),
        tokens,
    };
}

function buildEffectRow({
    hasScopedTarget,
    markdownOnly,
    promptOnly,
    pluginRequest,
    pluginReply,
    runOnEdit,
    translate,
}) {
    if (!hasScopedTarget) {
        return {
            role: translate('Effect'),
            tone: 'warn',
            template: translate('${ephemerality} — permanently rewrites saved chat history (${runOnEdit}).'),
            tokens: {
                ephemerality: {
                    field: ['markdownOnly', 'promptOnly', 'pluginRequest', 'pluginReply'],
                    text: translate('Permanent chat rewrite mode'),
                    tone: 'danger',
                },
                runOnEdit: {
                    field: 'runOnEdit',
                    text: runOnEdit
                        ? translate('also runs on message edits')
                        : translate('does not run on message edits'),
                    tone: runOnEdit ? 'active' : 'off',
                },
            },
        };
    }

    const activePassFields = [];
    const activePassLabels = [];
    if (markdownOnly) {
        activePassFields.push('markdownOnly');
        activePassLabels.push(translate('Chat Display', 'Only Format Display'));
    }
    if (promptOnly) {
        activePassFields.push('promptOnly');
        activePassLabels.push(translate('Outgoing Main Prompt', 'Only Format Prompt (?)'));
    }
    if (pluginRequest) {
        activePassFields.push('pluginRequest');
        activePassLabels.push(translate('Plugin Requests'));
    }
    if (pluginReply) {
        activePassFields.push('pluginReply');
        activePassLabels.push(translate('Plugin Replies'));
    }

    return {
        role: translate('Effect'),
        template: translate('Non-destructive — runs only on ${passes}, leaving saved chat history untouched (${runOnEdit}).'),
        tokens: {
            passes: {
                field: activePassFields,
                text: activePassLabels.join(translate(', ')),
                tone: 'active',
            },
            runOnEdit: {
                field: 'runOnEdit',
                text: translate('Run On Edit inactive'),
                tone: runOnEdit ? 'warn' : 'off',
            },
        },
    };
}

/**
 * Builds the live behavioral summary model for a Regex Editor rule.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildRegexBehaviorSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    if (state.disabled) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Scope'),
                tone: 'off',
                template: translate('${disabled} — never runs.'),
                tokens: {
                    disabled: {
                        field: 'disabled',
                        text: translate('Rule is disabled'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...ALL_RULE_FIELDS],
        };
    }

    const placements = normalizePlacements(state.placements);
    const markdownOnly = Boolean(state.markdownOnly);
    const promptOnly = Boolean(state.promptOnly);
    const pluginRequest = Boolean(state.pluginRequest);
    const pluginReply = Boolean(state.pluginReply);
    const runOnEdit = Boolean(state.runOnEdit);

    const hasPlacements = placements.length > 0;
    const hasSlashCommand = placements.includes(3);
    const hasWorldInfo = placements.includes(5);
    const hasReasoning = placements.includes(6);

    const hasNonReplyScoped = markdownOnly || promptOnly || pluginRequest;
    const hasScopedTarget = hasNonReplyScoped || pluginReply;
    const isPluginReplyOnly = pluginReply && !hasNonReplyScoped;
    const isWorldInfoOnly = hasPlacements && placements.every((code) => code === 5);

    const minDepth = parseDepthBound(state.minDepthRaw, -1);
    const maxDepth = parseDepthBound(state.maxDepthRaw, 0);
    const hasInvertedDepth = minDepth !== null && maxDepth !== null && minDepth > maxDepth;
    const hasDepthBounds = (minDepth !== null && minDepth >= 0) || maxDepth !== null;

    const depthToken = formatDepthToken(minDepth, maxDepth, hasInvertedDepth, translate);
    const substituteToken = {
        field: 'substituteRegex',
        ...substituteLabel(state.substituteRegex, translate),
    };

    const scopeRow = buildScopeRow({
        placements,
        markdownOnly,
        promptOnly,
        pluginRequest,
        pluginReply,
        hasScopedTarget,
        isPluginReplyOnly,
        depthToken,
        substituteToken,
        translate,
    });

    const effectRow = buildEffectRow({
        hasScopedTarget,
        markdownOnly,
        promptOnly,
        pluginRequest,
        pluginReply,
        runOnEdit,
        translate,
    });

    const warnings = [];

    if (!hasPlacements && !pluginReply) {
        if (pluginRequest) {
            warnings.push({
                severity: 'danger',
                template: translate('No message type is selected in ${placements} — ${pluginRequest} (and this rule) will never trigger until at least one message type is checked.'),
                tokens: {
                    placements: { field: 'placements', text: translate('Affects', 'ext_regex_affects'), tone: 'danger' },
                    pluginRequest: { field: 'pluginRequest', text: translate('Plugin Requests'), tone: 'danger' },
                },
            });
        } else {
            warnings.push({
                severity: 'danger',
                template: translate('No message type is selected in ${placements} — this rule has no target and will never trigger.'),
                tokens: {
                    placements: { field: 'placements', text: translate('Affects', 'ext_regex_affects'), tone: 'danger' },
                },
            });
        }
    } else if (!hasPlacements && pluginReply && hasNonReplyScoped) {
        warnings.push({
            severity: 'warn',
            template: translate('No message type is selected in ${placements} — only ${pluginReply} can trigger while message types are empty.'),
            tokens: {
                placements: { field: 'placements', text: translate('Affects', 'ext_regex_affects'), tone: 'warn' },
                pluginReply: { field: 'pluginReply', text: translate('Plugin Replies'), tone: 'active' },
            },
        });
    }

    if (!hasScopedTarget) {
        warnings.push({
            severity: 'danger',
            template: translate('Permanent irreversible chat rewrite — none of ${markdownOnly}, ${promptOnly}, ${pluginRequest}, or ${pluginReply} is ticked, so this rule edits saved chat files directly and ignores depth filters.'),
            tokens: {
                markdownOnly: { field: 'markdownOnly', text: translate('Alter Chat Display', 'Only Format Display'), tone: 'danger' },
                promptOnly: { field: 'promptOnly', text: translate('Alter Outgoing Prompt', 'Only Format Prompt (?)'), tone: 'danger' },
                pluginRequest: { field: 'pluginRequest', text: translate('Plugin Requests'), tone: 'danger' },
                pluginReply: { field: 'pluginReply', text: translate('Plugin Replies'), tone: 'danger' },
            },
        });
    }

    if (hasWorldInfo && !promptOnly && !pluginRequest) {
        warnings.push({
            severity: 'warn',
            template: translate('${worldInfo} only runs on prompt or plugin-request passes — check ${promptOnly} or ${pluginRequest}, otherwise World Info entries are never affected.'),
            tokens: {
                worldInfo: { field: 'placementWorldInfo', text: translate('World Info'), tone: 'warn' },
                promptOnly: { field: 'promptOnly', text: translate('Alter Outgoing Prompt', 'Only Format Prompt (?)'), tone: 'warn' },
                pluginRequest: { field: 'pluginRequest', text: translate('Plugin Requests'), tone: 'warn' },
            },
        });
    }

    if (hasSlashCommand && !markdownOnly && (promptOnly || pluginRequest)) {
        warnings.push({
            severity: 'warn',
            template: translate('${slashCommands} never matches outgoing prompt or plugin-request passes — it only triggers in Chat Display or permanent chat rewrite mode.'),
            tokens: {
                slashCommands: { field: 'placementSlashCommand', text: translate('Slash Commands'), tone: 'warn' },
            },
        });
    }

    if (hasReasoning && pluginRequest && !markdownOnly && !promptOnly) {
        warnings.push({
            severity: 'warn',
            template: translate('${reasoning} is not passed to ${pluginRequest} — Reasoning rules only trigger in Chat Display, Outgoing Main Prompt, or permanent mode.'),
            tokens: {
                reasoning: { field: 'placementReasoning', text: translate('Reasoning'), tone: 'warn' },
                pluginRequest: { field: 'pluginRequest', text: translate('Plugin Requests'), tone: 'warn' },
            },
        });
    }

    const isRunOnEditDormant = hasScopedTarget || isWorldInfoOnly;
    if (runOnEdit && isRunOnEditDormant) {
        if (hasScopedTarget) {
            warnings.push({
                severity: 'warn',
                template: translate('${runOnEdit} is inactive — it only runs in permanent chat rewrite mode, not when Display, Prompt, or Plugin options are checked.'),
                tokens: {
                    runOnEdit: { field: 'runOnEdit', text: translate('Run On Edit'), tone: 'warn' },
                },
            });
        } else {
            warnings.push({
                severity: 'warn',
                template: translate('${runOnEdit} is inactive — message editing never runs ${worldInfo} rules.'),
                tokens: {
                    runOnEdit: { field: 'runOnEdit', text: translate('Run On Edit'), tone: 'warn' },
                    worldInfo: { field: 'placementWorldInfo', text: translate('World Info'), tone: 'warn' },
                },
            });
        }
    }

    if (hasInvertedDepth) {
        warnings.push({
            severity: 'danger',
            template: translate('Min Depth ${minDepth} exceeds Max Depth ${maxDepth} — no message depth can match an inverted range.'),
            tokens: {
                minDepth: { field: 'minDepth', text: String(minDepth), tone: 'danger' },
                maxDepth: { field: 'maxDepth', text: String(maxDepth), tone: 'danger' },
            },
        });
    }

    if (isPluginReplyOnly && (hasPlacements || hasDepthBounds)) {
        warnings.push({
            severity: 'warn',
            template: translate('${pluginReply} bypasses ${placements} and ${depth} filters — those selections have no effect here.'),
            tokens: {
                pluginReply: { field: 'pluginReply', text: translate('Plugin Replies'), tone: 'warn' },
                placements: { field: 'placements', text: translate('Affects', 'ext_regex_affects'), tone: 'warn' },
                depth: { field: depthToken.field, text: translate('depth limits'), tone: 'warn' },
            },
        });
    }

    const dormantSet = new Set();
    if (isRunOnEditDormant) {
        dormantSet.add('runOnEdit');
    }
    if (!hasScopedTarget || isPluginReplyOnly) {
        dormantSet.add('minDepth');
        dormantSet.add('maxDepth');
    }
    if (isPluginReplyOnly) {
        dormantSet.add('placements');
    }

    let tone = 'active';
    if (warnings.some((w) => w.severity === 'danger')) {
        tone = 'danger';
    } else if (warnings.some((w) => w.severity === 'warn')) {
        tone = 'warn';
    }

    return {
        tone,
        rows: [scopeRow, effectRow],
        warnings,
        dormantFields: Array.from(dormantSet),
    };
}
