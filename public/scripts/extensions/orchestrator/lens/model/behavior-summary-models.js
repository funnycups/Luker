// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Orchestrator Settings (2A–2D)
// and Setup (2E). No DOM dependencies.

import { i18n, i18nFormat } from '../i18n.js';

const DEFAULT_CAPSULE_INSTRUCTION_TEXT = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';

function safeInt(raw, fallback, { min = -Infinity, max = Infinity } = {}) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const num = isBlank ? NaN : Number(raw);
    let value = Math.floor(Number.isFinite(num) ? num : fallback);
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);
    return value;
}

function modelPresetToken(field, rawValue, list) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return { field, text: i18n('Current'), tone: 'active' };
    }
    const hasLoadedList = Array.isArray(list) && list.length > 0;
    const missing = hasLoadedList && !list.includes(value);
    return {
        field,
        text: value,
        tone: missing ? 'warn' : 'active',
    };
}

function defaultPositionLabels() {
    return {
        '0': i18n('Before Character Definitions'),
        '1': i18n('After Character Definitions'),
        '2': i18n('Before Author\'s Note'),
        '3': i18n('After Author\'s Note'),
        '4': i18n('Before Example Messages'),
        '5': i18n('After Example Messages'),
        '6': i18n('At Chat Depth'),
    };
}

function defaultRoleLabels() {
    return {
        '0': i18n('System'),
        '1': i18n('User'),
        '2': i18n('Assistant'),
    };
}

function analyzeRegexLines(source) {
    const raw = typeof source === 'string' ? source : '';
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    let validCount = 0;
    let invalidCount = 0;
    for (const line of lines) {
        try {
            void new RegExp(line);
            validCount += 1;
        } catch {
            invalidCount += 1;
        }
    }
    return { totalCount: lines.length, validCount, invalidCount };
}

/**
 * 2A. Default API & prompt preset + World Info attachment summary.
 * `includeWorldInfoWithPreset` is dormant in `loop` and `director` modes.
 */
export function buildOrchDefaultModelSummary({ mode = 'spec', values = {}, options = null } = {}) {
    const m = String(mode || 'spec');
    const includeWi = values?.includeWorldInfoWithPreset !== false;
    const isSingle = m === 'single';
    const isLoop = m === 'loop';
    const isDirector = m === 'director';
    const wiInactive = isLoop || isDirector;

    const modelRow = {
        role: i18n('Agent model'),
        template: isSingle
            ? i18n('Single assistant calls ${llmNodeApiPresetName} + ${llmNodePresetName}.')
            : i18n('Agents without an individual override call ${llmNodeApiPresetName} + ${llmNodePresetName}.'),
        tokens: {
            llmNodeApiPresetName: modelPresetToken('llmNodeApiPresetName', values?.llmNodeApiPresetName, options?.connections),
            llmNodePresetName: modelPresetToken('llmNodePresetName', values?.llmNodePresetName, options?.presets),
        },
    };

    let wiRow;
    if (isLoop) {
        wiRow = {
            role: i18n('World info'),
            tone: 'off',
            template: i18n('${includeWorldInfoWithPreset} does not apply in Research loop mode (reads lorebook on demand via tools).'),
            tokens: {
                includeWorldInfoWithPreset: {
                    field: 'includeWorldInfoWithPreset',
                    text: includeWi ? i18n('On (inactive in this mode)') : i18n('Off (inactive in this mode)'),
                    tone: 'off',
                },
            },
        };
    } else if (isDirector) {
        wiRow = {
            role: i18n('World info'),
            tone: 'off',
            template: i18n('${includeWorldInfoWithPreset} does not apply in Director team mode (receives main chat world info directly).'),
            tokens: {
                includeWorldInfoWithPreset: {
                    field: 'includeWorldInfoWithPreset',
                    text: includeWi ? i18n('On (inactive in this mode)') : i18n('Off (inactive in this mode)'),
                    tone: 'off',
                },
            },
        };
    } else if (includeWi) {
        wiRow = {
            role: i18n('World info'),
            template: i18n('${includeWorldInfoWithPreset} to agent prompts.'),
            tokens: {
                includeWorldInfoWithPreset: {
                    field: 'includeWorldInfoWithPreset',
                    text: i18n('Attaches active world info'),
                    tone: 'active',
                },
            },
        };
    } else {
        wiRow = {
            role: i18n('World info'),
            tone: 'off',
            template: i18n('${includeWorldInfoWithPreset} from agent prompts.'),
            tokens: {
                includeWorldInfoWithPreset: {
                    field: 'includeWorldInfoWithPreset',
                    text: i18n('Excludes world info'),
                    tone: 'off',
                },
            },
        };
    }

    const hasMissingModel = modelRow.tokens.llmNodeApiPresetName.tone === 'warn'
        || modelRow.tokens.llmNodePresetName.tone === 'warn';

    return {
        tone: hasMissingModel ? 'warn' : 'active',
        rows: [modelRow, wiRow],
        warnings: [],
        dormantFields: wiInactive ? ['includeWorldInfoWithPreset'] : [],
    };
}

/**
 * 2B. Mode-specific runtime limits summary covering all 5 execution modes.
 */
export function buildOrchRuntimeLimitsSummary({ mode = 'spec', profile = {}, values = {} } = {}) {
    const m = String(mode || 'spec');

    if (m === 'director') {
        const maxRounds = safeInt(profile?.maxRounds, 40, { min: 1 });
        const maxConcurrent = safeInt(profile?.maxConcurrentSubagents, 4, { min: 1 });
        const maxTotal = safeInt(profile?.maxTotalSubagentRuns, 16, { min: 1 });
        const discardOnAbort = Boolean(profile?.discardOnAbort);
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Limits'),
                    template: i18n('Lead writer runs up to ${maxRounds} tool rounds. Sub-agents run up to ${maxConcurrentSubagents} concurrently and ${maxTotalSubagentRuns} total per turn.'),
                    tokens: {
                        maxRounds: { field: 'maxRounds', text: String(maxRounds), tone: 'active' },
                        maxConcurrentSubagents: { field: 'maxConcurrentSubagents', text: String(maxConcurrent), tone: 'active' },
                        maxTotalSubagentRuns: { field: 'maxTotalSubagentRuns', text: String(maxTotal), tone: 'active' },
                    },
                },
                {
                    role: i18n('On user abort'),
                    template: i18n('When aborted by user, ${discardOnAbort}.'),
                    tokens: {
                        discardOnAbort: {
                            field: 'discardOnAbort',
                            text: discardOnAbort ? i18n('discards partial output') : i18n('preserves partial output without finalizing'),
                            tone: discardOnAbort ? 'active' : 'off',
                        },
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    if (m === 'agenda') {
        const limits = profile?.limits && typeof profile.limits === 'object' ? profile.limits : {};
        const plannerMaxRounds = safeInt(limits.plannerMaxRounds, 6, { min: 1 });
        const maxConcurrentAgents = safeInt(limits.maxConcurrentAgents, 3, { min: 1 });
        const maxTotalRuns = safeInt(limits.maxTotalRuns, 24, { min: 1 });
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Limits'),
                    template: i18n('Dispatcher plans up to ${plannerMaxRounds} rounds. Workers run up to ${maxConcurrentAgents} concurrently and ${maxTotalRuns} total per turn.'),
                    tokens: {
                        plannerMaxRounds: { field: 'plannerMaxRounds', text: String(plannerMaxRounds), tone: 'active' },
                        maxConcurrentAgents: { field: 'maxConcurrentAgents', text: String(maxConcurrentAgents), tone: 'active' },
                        maxTotalRuns: { field: 'maxTotalRuns', text: String(maxTotalRuns), tone: 'active' },
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    if (m === 'loop') {
        const maxRounds = safeInt(profile?.max_rounds, 40, { min: 1 });
        const budgetSec = Math.max(10, Math.round(safeInt(profile?.wall_clock_budget_ms, 300000, { min: 10000 }) / 1000));
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Limits'),
                    template: i18n('Research loop runs up to ${max_rounds} rounds or ${wall_clock_budget_ms} seconds, stopping early after 3 consecutive prose-only rounds.'),
                    tokens: {
                        max_rounds: { field: 'max_rounds', text: String(maxRounds), tone: 'active' },
                        wall_clock_budget_ms: { field: 'wall_clock_budget_ms', text: String(budgetSec), tone: 'active' },
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    const nodeRounds = safeInt(values?.nodeIterationMaxRounds, 40, { min: 1 });
    const rerunRounds = safeInt(values?.reviewRerunMaxRounds, 2, { min: 0 });

    if (m === 'single') {
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Limits'),
                    template: i18n('Single assistant runs up to ${nodeIterationMaxRounds} tool rounds (${reviewRerunMaxRounds} review reruns — unused in this mode).'),
                    tokens: {
                        nodeIterationMaxRounds: { field: 'nodeIterationMaxRounds', text: String(nodeRounds), tone: 'active' },
                        reviewRerunMaxRounds: { field: 'reviewRerunMaxRounds', text: i18nFormat('${0} (unused)', rerunRounds), tone: 'off' },
                    },
                },
            ],
            warnings: [],
            dormantFields: ['reviewRerunMaxRounds'],
        };
    }

    return {
        tone: 'active',
        rows: [
            {
                role: i18n('Limits'),
                template: rerunRounds === 0
                    ? i18n('Worker nodes run up to ${nodeIterationMaxRounds} tool rounds. Review stage reruns are ${reviewRerunMaxRounds}.')
                    : i18n('Worker nodes run up to ${nodeIterationMaxRounds} tool rounds. Review nodes may trigger up to ${reviewRerunMaxRounds} stage reruns.'),
                tokens: {
                    nodeIterationMaxRounds: { field: 'nodeIterationMaxRounds', text: String(nodeRounds), tone: 'active' },
                    reviewRerunMaxRounds: {
                        field: 'reviewRerunMaxRounds',
                        text: rerunRounds === 0 ? i18n('disabled (0)') : String(rerunRounds),
                        tone: rerunRounds === 0 ? 'off' : 'active',
                    },
                },
            },
        ],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * 2C. Cross-mode limits summary.
 * `maxRecentMessages` is dormant in `loop` and `director`; `rpmLimit` is dormant in `director`.
 */
export function buildOrchCrossModeLimitsSummary({ mode = 'spec', values = {} } = {}) {
    const m = String(mode || 'spec');
    const maxRecent = safeInt(values?.maxRecentMessages, 14, { min: 1 });
    const retries = safeInt(values?.toolCallRetryMax, 2, { min: 0 });
    const rpm = safeInt(values?.rpmLimit, 0, { min: 0 });
    const isLoop = m === 'loop';
    const isDirector = m === 'director';

    let contextRow;
    if (isLoop) {
        contextRow = {
            role: i18n('Context'),
            tone: 'off',
            template: i18n('${maxRecentMessages} is inactive in Research loop mode (reads chat on demand via chat tools).'),
            tokens: {
                maxRecentMessages: { field: 'maxRecentMessages', text: String(maxRecent), tone: 'off' },
            },
        };
    } else if (isDirector) {
        contextRow = {
            role: i18n('Context'),
            tone: 'off',
            template: i18n('${maxRecentMessages} is inactive in Director team mode (receives main chat context directly).'),
            tokens: {
                maxRecentMessages: { field: 'maxRecentMessages', text: String(maxRecent), tone: 'off' },
            },
        };
    } else {
        contextRow = {
            role: i18n('Context'),
            template: i18n('Agents read the latest ${maxRecentMessages} assistant turns as context.'),
            tokens: {
                maxRecentMessages: { field: 'maxRecentMessages', text: String(maxRecent), tone: 'active' },
            },
        };
    }

    const rpmText = rpm > 0 ? i18nFormat('${0} RPM', rpm) : i18n('unlimited (0)');
    const reliabilityRow = isDirector
        ? {
            role: i18n('Reliability'),
            template: i18n('Retries invalid or missing tool calls up to ${toolCallRetryMax} times. ${rpmLimit} is inactive in Director team mode (connection profile RPM applies).'),
            tokens: {
                toolCallRetryMax: { field: 'toolCallRetryMax', text: String(retries), tone: retries > 0 ? 'active' : 'off' },
                rpmLimit: { field: 'rpmLimit', text: rpmText, tone: 'off' },
            },
        }
        : {
            role: i18n('Reliability'),
            template: i18n('Retries invalid or missing tool calls up to ${toolCallRetryMax} times, rate limit ${rpmLimit}.'),
            tokens: {
                toolCallRetryMax: { field: 'toolCallRetryMax', text: String(retries), tone: retries > 0 ? 'active' : 'off' },
                rpmLimit: { field: 'rpmLimit', text: rpmText, tone: rpm > 0 ? 'active' : 'off' },
            },
        };

    const dormantFields = [];
    if (isLoop || isDirector) dormantFields.push('maxRecentMessages');
    if (isDirector) dormantFields.push('rpmLimit');

    return {
        tone: 'active',
        rows: [contextRow, reliabilityRow],
        warnings: [],
        dormantFields,
    };
}

/**
 * 2D. Capsule injection summary (non-director modes).
 */
export function buildOrchCapsuleSummary({
    values = {},
    positionLabels = null,
    roleLabels = null,
    atDepthValue = null,
    defaultCustomInstruction = DEFAULT_CAPSULE_INSTRUCTION_TEXT,
} = {}) {
    const posMap = positionLabels && typeof positionLabels === 'object' ? positionLabels : defaultPositionLabels();
    const roleMap = roleLabels && typeof roleLabels === 'object' ? roleLabels : defaultRoleLabels();
    const posKey = String(values?.capsuleInjectPosition ?? '6');
    const resolvedAtDepth = atDepthValue != null
        ? String(atDepthValue)
        : String(globalThis.Luker?.getContext?.()?.constants?.wiPosition?.atDepth ?? '6');
    const isAtDepth = posKey === resolvedAtDepth;
    const depth = safeInt(values?.capsuleInjectDepth, 0, { min: 0 });
    const roleKey = String(values?.capsuleInjectRole ?? '0');

    const posLabel = String(posMap[posKey] ?? posKey);
    const roleLabel = String(roleMap[roleKey] ?? roleKey);

    const trimmedCustom = String(values?.capsuleCustomInstruction ?? '').trim();
    const trimmedDefault = String(defaultCustomInstruction || DEFAULT_CAPSULE_INSTRUCTION_TEXT).trim();
    let instructionToken;
    if (!trimmedCustom) {
        instructionToken = { field: 'capsuleCustomInstruction', text: i18n('without wrapper instruction'), tone: 'off' };
    } else if (trimmedCustom === trimmedDefault) {
        instructionToken = { field: 'capsuleCustomInstruction', text: i18n('with default instruction'), tone: 'active' };
    } else {
        instructionToken = { field: 'capsuleCustomInstruction', text: i18n('with custom instruction'), tone: 'active' };
    }

    const row = isAtDepth
        ? {
            role: i18n('Main model injection'),
            template: i18n('Injects only the final stage output into the main model prompt at ${capsuleInjectPosition}, depth ${capsuleInjectDepth} as ${capsuleInjectRole}, ${capsuleCustomInstruction}.'),
            tokens: {
                capsuleInjectPosition: { field: 'capsuleInjectPosition', text: posLabel, tone: 'active' },
                capsuleInjectDepth: { field: 'capsuleInjectDepth', text: String(depth), tone: 'active' },
                capsuleInjectRole: { field: 'capsuleInjectRole', text: roleLabel, tone: 'active' },
                capsuleCustomInstruction: instructionToken,
            },
        }
        : {
            role: i18n('Main model injection'),
            template: i18n('Injects only the final stage output into the main model prompt at ${capsuleInjectPosition}, ${capsuleCustomInstruction}.'),
            tokens: {
                capsuleInjectPosition: { field: 'capsuleInjectPosition', text: posLabel, tone: 'active' },
                capsuleCustomInstruction: instructionToken,
            },
        };

    return {
        tone: 'active',
        rows: [row],
        warnings: [],
        dormantFields: [],
    };
}

function countEnabledTools(mode, defaultTools, customToolNames) {
    if (!defaultTools || typeof defaultTools !== 'object') return 0;
    const groups = mode === 'director'
        ? ['note', 'chat', 'lorebook', 'collab', 'message']
        : ['note', 'chat', 'lorebook'];

    let builtinCount = 0;
    for (const group of groups) {
        const bag = defaultTools[group];
        if (!bag || typeof bag !== 'object') continue;
        for (const val of Object.values(bag)) {
            if (val === true) builtinCount += 1;
        }
    }

    const customBag = defaultTools.custom && typeof defaultTools.custom === 'object'
        ? defaultTools.custom
        : {};
    let explicitCustomCount = 0;
    for (const val of Object.values(customBag)) {
        if (val === true) explicitCustomCount += 1;
    }

    let implicitCustomCount = 0;
    if (Array.isArray(customToolNames) && (mode === 'director' || mode === 'loop' || builtinCount + explicitCustomCount > 0)) {
        for (const name of customToolNames) {
            if (name && !Object.hasOwn(customBag, name)) {
                implicitCustomCount += 1;
            }
        }
    }

    return builtinCount + explicitCustomCount + implicitCustomCount;
}

/**
 * 2E (Tools). Profile default tools & per-agent override count (read-only `field: null`).
 */
export function buildOrchToolsSummary({
    mode = 'spec',
    defaultTools = null,
    agentOverrideCount = 0,
    totalAgents = 0,
    customToolNames = null,
} = {}) {
    const m = String(mode || 'spec');
    const enabledCount = countEnabledTools(m, defaultTools, customToolNames);
    const total = safeInt(totalAgents, 0, { min: 0 });
    const overrides = safeInt(agentOverrideCount, 0, { min: 0, max: total > 0 ? total : Infinity });

    const defaultToken = {
        field: 'defaultTools',
        text: enabledCount > 0 ? i18nFormat('${0} enabled', enabledCount) : i18n('none enabled (0)'),
        tone: enabledCount > 0 ? 'active' : 'off',
    };

    if (m === 'single') {
        return {
            tone: 'dormant',
            rows: [
                {
                    role: i18n('Default tools'),
                    tone: 'off',
                    template: i18n('Single assistant does not use profile default tools.'),
                    tokens: {},
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    if (m === 'loop') {
        return {
            tone: enabledCount > 0 ? 'active' : 'dormant',
            rows: [
                {
                    role: i18n('Default tools'),
                    template: i18n('Researcher enables ${defaultTools} in addition to finalize.'),
                    tokens: { defaultTools: defaultToken },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    let overrideText;
    if (total === 0) {
        overrideText = i18n('0 agents');
    } else if (overrides > 0) {
        overrideText = i18nFormat('${0} of ${1} agents override', overrides, total);
    } else {
        overrideText = i18nFormat('all ${0} agents inherit', total);
    }

    const overrideToken = {
        field: null,
        text: overrideText,
        tone: overrides > 0 ? 'active' : 'off',
    };

    if (m === 'director') {
        return {
            tone: enabledCount > 0 || overrides > 0 ? 'active' : 'dormant',
            rows: [
                {
                    role: i18n('Default tools'),
                    template: i18n('Profile default enables ${defaultTools} (${agentOverrides}).'),
                    tokens: {
                        defaultTools: defaultToken,
                        agentOverrides: overrideToken,
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    // spec / agenda
    return {
        tone: enabledCount > 0 || overrides > 0 ? 'active' : 'dormant',
        rows: [
            {
                role: i18n('Default tools'),
                template: enabledCount > 0
                    ? i18n('Profile default enables ${defaultTools} (${agentOverrides}). Having any enabled tool switches workers from single-call output to multi-round tool loops.')
                    : i18n('Profile default has ${defaultTools} (${agentOverrides}). Workers without overrides run as single-call nodes (enabling any tool switches them to multi-round tool loops).'),
                tokens: {
                    defaultTools: defaultToken,
                    agentOverrides: overrideToken,
                },
            },
        ],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * 2E (Lorebook filter). Summarizes OR-matched world-book & entry regex filtering.
 */
export function buildOrchLorebookFilterSummary({ bookPattern = '', entryPattern = '' } = {}) {
    const bookStats = analyzeRegexLines(bookPattern);
    const entryStats = analyzeRegexLines(entryPattern);
    const hasBook = bookStats.totalCount > 0;
    const hasEntry = entryStats.totalCount > 0;

    const bookToken = hasBook
        ? {
            field: 'bookPattern',
            text: i18nFormat('book regex (${0})', bookStats.validCount),
            tone: bookStats.invalidCount > 0 ? 'warn' : 'active',
        }
        : {
            field: 'bookPattern',
            text: i18n('book pattern (empty)'),
            tone: 'off',
        };

    const entryToken = hasEntry
        ? {
            field: 'entryPattern',
            text: i18nFormat('entry regex (${0})', entryStats.validCount),
            tone: entryStats.invalidCount > 0 ? 'warn' : 'active',
        }
        : {
            field: 'entryPattern',
            text: i18n('entry pattern (empty)'),
            tone: 'off',
        };

    const warnings = [];
    if (bookStats.invalidCount > 0 && entryStats.invalidCount > 0) {
        warnings.push({
            severity: 'warn',
            template: i18n('Invalid regex syntax in ${bookPattern} and ${entryPattern} — invalid lines are skipped at runtime.'),
            tokens: {
                bookPattern: { field: 'bookPattern', text: i18n('book pattern'), tone: 'warn' },
                entryPattern: { field: 'entryPattern', text: i18n('entry pattern'), tone: 'warn' },
            },
        });
    } else if (bookStats.invalidCount > 0) {
        warnings.push({
            severity: 'warn',
            template: i18n('Invalid regex syntax in ${bookPattern} — invalid lines are skipped at runtime.'),
            tokens: {
                bookPattern: { field: 'bookPattern', text: i18n('book pattern'), tone: 'warn' },
            },
        });
    } else if (entryStats.invalidCount > 0) {
        warnings.push({
            severity: 'warn',
            template: i18n('Invalid regex syntax in ${entryPattern} — invalid lines are skipped at runtime.'),
            tokens: {
                entryPattern: { field: 'entryPattern', text: i18n('entry pattern'), tone: 'warn' },
            },
        });
    }

    if (!hasBook && !hasEntry) {
        return {
            tone: 'dormant',
            rows: [
                {
                    role: i18n('World info filter'),
                    tone: 'off',
                    template: i18n('No entries filtered — both ${bookPattern} and ${entryPattern} are empty, so all active world info passes through.'),
                    tokens: { bookPattern: bookToken, entryPattern: entryToken },
                },
            ],
            warnings,
            dormantFields: [],
        };
    }

    let template;
    if (hasBook && hasEntry) {
        template = i18n('Strips entries matching ${bookPattern} OR ${entryPattern} across all world info channels before orchestration and main generation.');
    } else if (hasBook) {
        template = i18n('Strips entries matching ${bookPattern} across all world info channels before orchestration and main generation — ${entryPattern} is unset, OR match.');
    } else {
        template = i18n('Strips entries matching ${entryPattern} across all world info channels before orchestration and main generation — ${bookPattern} is unset, OR match.');
    }

    return {
        tone: warnings.length > 0 ? 'warn' : 'active',
        rows: [
            {
                role: i18n('World info filter'),
                template,
                tokens: { bookPattern: bookToken, entryPattern: entryToken },
            },
        ],
        warnings,
        dormantFields: [],
    };
}
