// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench IterateTarget implementations owned by Memory Graph:
//   - 'memory'       (global & character scopes: node-type schema + advanced settings + lorebook reads)
//   - 'memory_graph' (chat scope: graph-revision via ProposalBus + vector sync + graph preview)

import { h, put } from '../../../lens-shared/util.js';
import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import { SourceError } from '../../../workbench/model/errors.js';
import {
    conflictsLeftAlone,
    fieldPlan,
    mergeOps,
    requireApplied,
    reverseOps,
    saveSettingsChecked,
} from '../../../workbench/model/patch.js';
import {
    TOOL_DEFS as CONFIG_TOOL_DEFS,
    CONTROL_TOOL_NAMES,
    READ_TOOL_NAMES,
    buildToolCatalog,
    isMgConfigReadTool,
    isMgSchemaControlCall,
    normalizeToolCallToEdit,
} from '../config-iteration/tools.js';
import {
    CONFIG_FIELDS,
    buildConfigFieldCatalog,
    getDefaultSettingsView,
    resolveSettingsForView,
} from '../config-iteration/fields.js';
import {
    ADVANCED_SETTING_DEFAULTS,
    normalizeAdvancedSettings,
} from '../config-iteration/advanced-settings.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../config-iteration/system-prompt.js';
import { dispatchMgConfigReadFields } from '../config-iteration/read-fields-dispatcher.js';
import { applyConfigPlan, planConfigCommit } from '../config-iteration/commit-plan.js';
import {
    canonicalFromStore,
    applyCanonicalToStore,
    docsEqual,
    docsTouchNodes,
} from '../graph-iteration/canonical.js';
import {
    GRAPH_TOOL_DEFS,
    GraphToolError,
    executeGraphReadTool,
    executeGraphWriteTool,
    isGraphReadTool,
    isGraphWriteTool,
} from '../graph-iteration/tools.js';
import {
    DEFAULT_GRAPH_ITER_SYSTEM_PROMPT,
    buildGraphIterSystemPrompt,
} from '../graph-iteration/system-prompt.js';
import { buildGraphDiffSummary, diffGraphDocs } from '../graph-iteration/diff-cards.js';
import { i18n, i18nFormat, listSeparator } from './i18n.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const defaultGetContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;

const GROUP_LABELS = {
    extraction: 'Extraction settings',
    recall: 'Recall settings',
    query_rewrite: 'Query rewrite',
    iteration: 'Iteration',
    runtime: 'Runtime',
};

const SCHEMA_ORDER_KEY = 'schema:__order';

function resolveActiveAvatar(ctx) {
    if (!ctx || ctx.groupId) return '';
    return String(ctx.characters?.[ctx.characterId]?.avatar || '').trim();
}

function resolveActiveCharacterName(ctx, avatar) {
    if (!ctx || !avatar) return '';
    const ch = (ctx.characters || []).find(c => String(c?.avatar || '').trim() === avatar) || ctx.characters?.[ctx.characterId];
    return String(ch?.name || ch?.data?.name || avatar).trim();
}

function wrapToolCallForNormalize(call) {
    return {
        function: {
            name: String(call?.name || ''),
            arguments: typeof call?.args === 'string'
                ? call.args
                : JSON.stringify(call?.args ?? {}),
        },
    };
}

function appendScopeHintIfNeeded(basePrompt, { scope, hasOverride, characterDisplayName }) {
    if (scope !== 'character') return basePrompt;
    const display = String(characterDisplayName || '').trim() || 'this character';
    if (!hasOverride) {
        return [
            basePrompt,
            '',
            '# Iteration scope',
            `You are iterating on the character configuration for "${display}". This card has NO schema override yet.`,
            '',
            'Two paths exist; decide from the user\'s first message which applies:',
            '- Adjust the existing setup: the working schema starts as a copy of the GLOBAL schema. Make targeted edits as you normally would. This is the default path.',
            `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the global copy and start with a minimal blank shell. If you already called it earlier this session, the working schema is already blank — continue authoring from there without calling reset again.`,
            '',
            'Parameter and prompt writes are sparse character overrides — only keys differing from global are stored. Resets affect the schema only.',
            'Do not call the reset tool unless the user clearly wants a brand-new schema.',
        ].join('\n');
    }
    return [
        basePrompt,
        '',
        '# Iteration scope',
        `You are iterating on the character configuration for "${display}". This card ALREADY has a schema override.`,
        '',
        'Three paths exist; default to the first unless the user clearly asks for one of the others:',
        '- Continue adjusting the current override: the working schema starts as a copy of the existing OVERRIDE. Make targeted edits as you normally would. This is the default path.',
        `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the existing override and start with a minimal blank shell. If you already called it earlier this session, the working schema is already blank — continue authoring from there without calling reset again.`,
        `- Match the global schema: call \`${CONTROL_TOOL_NAMES.resetToGlobal}\` once to discard the existing override and start with a fresh clone of the current global schema. If you already called it earlier this session, the working schema already matches global — continue adjusting from there without calling reset again.`,
        '',
        'Parameter and prompt writes are sparse character overrides — only keys differing from global are stored. Resets affect the schema only.',
        'Do not call either reset tool unless the user clearly asks for that fresh-start path.',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Memory configuration (`memory`) target: unit conversion, rebuild, apply
// ---------------------------------------------------------------------------

function formatNodeTypeText(nt) {
    const cols = Array.isArray(nt.tableColumns) ? nt.tableColumns.join(', ') : '';
    const embedCols = Array.isArray(nt.embeddingColumns) ? nt.embeddingColumns.join(', ') : '';
    const reqCols = Array.isArray(nt.requiredColumns) ? nt.requiredColumns.join(', ') : '';
    const pkCols = Array.isArray(nt.primaryKeyColumns) ? nt.primaryKeyColumns.join(', ') : '';
    const keywords = Array.isArray(nt.keywords) ? nt.keywords.join(', ') : '';
    const flags = [
        nt.alwaysInject ? 'alwaysInject' : '',
        nt.latestOnly ? 'latestOnly' : '',
        nt.forceUpdate ? 'forceUpdate' : '',
        nt.editable ? 'editable' : 'createOnly',
    ].filter(Boolean).join(', ');
    const hints = nt.columnHints && typeof nt.columnHints === 'object'
        ? Object.entries(nt.columnHints).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${v}`)
        : [];
    const comp = nt.compression && typeof nt.compression === 'object' ? nt.compression : {};
    const compLine = [
        `mode=${comp.mode || 'none'}`,
        `threshold=${comp.threshold ?? 6}`,
        `fanIn=${comp.fanIn ?? 3}`,
        `maxDepth=${comp.maxDepth ?? 6}`,
        `keepRecentLeaves=${comp.keepRecentLeaves ?? 0}`,
        comp.rule ? `rule=${comp.rule}` : '',
    ].filter(Boolean).join(', ');

    const lines = [
        `label: ${String(nt.label || '')}`,
        `tableName: ${String(nt.tableName || '')}`,
        `tableColumns: [${cols}]`,
        `embeddingColumns: [${embedCols}]`,
        `requiredColumns: [${reqCols}]`,
        `primaryKeyColumns: [${pkCols}]`,
        `keywords: [${keywords}]`,
        `extractEveryN: ${nt.extractEveryN ?? 1}`,
        `flags: ${flags}`,
        `extractHint: ${String(nt.extractHint || '')}`,
        `extractionInstructions: ${String(nt.extractionInstructions || '')}`,
        `compression: ${compLine}`,
        comp.summarizeInstruction ? `summarizeInstruction: ${comp.summarizeInstruction}` : '',
        hints.length ? 'columnHints:\n' + hints.join('\n') : '',
    ];
    return lines.filter(Boolean).join('\n');
}

function nodeTypeHiddenFields(nt) {
    const hidden = {};
    if (nt.level !== undefined) hidden.level = nt.level;
    if (nt.ragPerTypeK !== undefined) hidden.ragPerTypeK = nt.ragPerTypeK;
    if (nt.recordsFloorRange !== undefined) hidden.recordsFloorRange = Boolean(nt.recordsFloorRange);
    return hidden;
}

export function memoryConfigUnits(live) {
    const out = new Map();
    const schema = Array.isArray(live?.schema) ? live.schema : [];
    const settings = live?.settings && typeof live.settings === 'object' && !Array.isArray(live.settings)
        ? live.settings
        : {};

    for (const nt of schema) {
        const id = String(nt?.id || '').trim();
        if (!id) continue;
        const label = nt.label && nt.label !== id ? `${nt.label} (${id})` : id;
        out.set(`schema:${id}`, {
            key: `schema:${id}`,
            label,
            group: i18n('Memory types'),
            text: formatNodeTypeText(nt),
            raw: clone(nt),
            fields: clone(nt),
            hidden: nodeTypeHiddenFields(nt),
        });
    }

    const ids = schema.map(nt => String(nt?.id || '').trim()).filter(Boolean);
    out.set(SCHEMA_ORDER_KEY, {
        key: SCHEMA_ORDER_KEY,
        label: i18n('Type order'),
        group: i18n('Memory types'),
        text: ids.join(' → '),
        raw: ids,
        fields: { ids },
    });

    for (const def of Object.values(CONFIG_FIELDS)) {
        const val = settings[def.key];
        out.set(`settings:${def.key}`, {
            key: `settings:${def.key}`,
            label: i18n(def.label),
            group: i18n(GROUP_LABELS[def.group] || 'Settings'),
            text: def.kind === 'text' ? String(val ?? '') : JSON.stringify(val ?? null),
            raw: clone(val),
            fields: { [def.key]: clone(val) },
        });
    }
    return out;
}

export function rebuildMemoryConfig(base, ai, accepted = []) {
    const acceptedSet = new Set(Array.isArray(accepted) ? accepted : []);
    const baseSchema = Array.isArray(base?.schema) ? clone(base.schema) : [];
    const aiSchema = Array.isArray(ai?.schema) ? clone(ai.schema) : [];
    const aiById = new Map(aiSchema.map(nt => [String(nt?.id || '').trim(), nt]));
    const nextSchema = [];
    const seen = new Set();

    for (const item of baseSchema) {
        const id = String(item?.id || '').trim();
        if (!id) continue;
        const unitKey = `schema:${id}`;
        if (acceptedSet.has(unitKey)) {
            const replacement = aiById.get(id);
            if (replacement) {
                nextSchema.push(clone(replacement));
                seen.add(id);
            }
            // If absent in aiById and accepted, this node type was removed.
        } else {
            nextSchema.push(clone(item));
            seen.add(id);
        }
    }

    for (const item of aiSchema) {
        const id = String(item?.id || '').trim();
        if (!id || seen.has(id)) continue;
        if (acceptedSet.has(`schema:${id}`)) {
            nextSchema.push(clone(item));
            seen.add(id);
        }
    }

    if (acceptedSet.has(SCHEMA_ORDER_KEY)) {
        const orderIndex = new Map(aiSchema.map((nt, idx) => [String(nt?.id || '').trim(), idx]));
        nextSchema.sort((a, b) => {
            const ia = orderIndex.has(a.id) ? orderIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
            const ib = orderIndex.has(b.id) ? orderIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
            return ia - ib;
        });
    }

    const nextSettings = clone(base?.settings || {});
    const aiSettings = ai?.settings || {};
    for (const def of Object.values(CONFIG_FIELDS)) {
        if (acceptedSet.has(`settings:${def.key}`)) {
            nextSettings[def.key] = clone(aiSettings[def.key]);
        }
    }

    return { schema: nextSchema, settings: nextSettings };
}

function applyMemoryConfigOps(doc, ops) {
    const next = {
        schema: Array.isArray(doc?.schema) ? clone(doc.schema) : [],
        settings: doc?.settings && typeof doc.settings === 'object' ? clone(doc.settings) : {},
    };
    const byId = new Map(next.schema.map(nt => [String(nt?.id || '').trim(), nt]));

    for (const op of ops) {
        if (op.key === SCHEMA_ORDER_KEY) continue;
        if (op.key.startsWith('schema:')) {
            const id = op.key.slice('schema:'.length);
            if (op.kind === 'remove') {
                byId.delete(id);
                next.schema = next.schema.filter(nt => String(nt?.id || '').trim() !== id);
                continue;
            }
            let target = byId.get(id);
            if (!target) {
                target = { id };
                byId.set(id, target);
                next.schema.push(target);
            }
            for (const c of op.changes) {
                if (c.after === undefined) delete target[c.field];
                else target[c.field] = clone(c.after);
            }
        } else if (op.key.startsWith('settings:')) {
            for (const c of op.changes) {
                if (c.after === undefined) delete next.settings[c.field];
                else next.settings[c.field] = clone(c.after);
            }
        }
    }

    const orderOp = ops.find(op => op.key === SCHEMA_ORDER_KEY);
    if (orderOp) {
        const ids = orderOp.changes.find(c => c.field === 'ids')?.after || [];
        const orderIndex = new Map(ids.map((id, idx) => [String(id || '').trim(), idx]));
        next.schema.sort((a, b) => {
            const ia = orderIndex.has(a.id) ? orderIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
            const ib = orderIndex.has(b.id) ? orderIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
            return ia - ib;
        });
    }

    return next;
}

function renderMemoryConfigPreview({ base, ai }) {
    const current = ai || base;
    if (!current || typeof current !== 'object') return null;
    const baseSchema = Array.isArray(base?.schema) ? base.schema : [];
    const aiSchema = Array.isArray(current?.schema) ? current.schema : [];
    const baseById = new Map(baseSchema.map(nt => [String(nt?.id || '').trim(), nt]));
    const aiById = new Map(aiSchema.map(nt => [String(nt?.id || '').trim(), nt]));

    const schemaNodes = [];
    if (!aiSchema.length && !baseSchema.length) {
        schemaNodes.push(h('div', { class: 'wb-note', text: i18n('No schema loaded.') }));
    } else {
        for (const nt of aiSchema) {
            const id = String(nt?.id || '').trim();
            const prev = baseById.get(id);
            const state = !prev ? 'is-add' : (JSON.stringify(prev) !== JSON.stringify(nt) ? 'is-change' : '');
            const cols = Array.isArray(nt?.tableColumns) ? nt.tableColumns.join(', ') : '';
            const flags = [
                nt?.alwaysInject ? i18n('Always on') : '',
                nt?.latestOnly ? i18n('Keep only the latest of the same name') : '',
                nt?.compression?.mode === 'hierarchical' ? i18n('Auto-merge into summaries') : '',
            ].filter(Boolean);
            schemaNodes.push(
                h('details', { class: `wb-mg-preview-type ${state}`.trim(), open: true },
                    h('summary', null,
                        h('span', { class: 'wb-mg-preview-label', text: nt?.label || id || '?' }),
                        state ? h('span', { class: 'wb-chg-tag', text: state === 'is-add' ? '+' : '~' }) : null),
                    cols ? h('div', { class: 'wb-note', text: cols }) : null,
                    flags.length ? h('div', { class: 'wb-note', text: flags.join(listSeparator()) }) : null),
            );
        }
        for (const nt of baseSchema) {
            const id = String(nt?.id || '').trim();
            if (!id || aiById.has(id)) continue;
            schemaNodes.push(
                h('div', { class: 'wb-mg-preview-type is-del' },
                    h('span', { class: 'wb-mg-preview-label', text: nt?.label || id }),
                    h('span', { class: 'wb-chg-tag is-del', text: '-' })),
            );
        }
    }

    const baseSettings = base?.settings || {};
    const aiSettings = current?.settings || {};
    const changedSettings = Object.values(CONFIG_FIELDS).filter(def => !Object.is(baseSettings[def.key], aiSettings[def.key]));

    return h('div', { class: 'wb-mg-preview' },
        h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Schema') })),
        h('div', { class: 'wb-mg-preview-list' }, schemaNodes),
        changedSettings.length
            ? h('div', { class: 'wb-mg-preview-settings' },
                h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Settings') })),
                changedSettings.map((def) => {
                    const val = aiSettings[def.key];
                    const preview = typeof val === 'string' ? val : JSON.stringify(val ?? null);
                    return h('div', { class: 'wb-mg-preview-row is-change' },
                        h('span', { class: 'wb-mg-preview-label', text: i18n(def.label) }),
                        h('div', { class: 'wb-note', text: preview }));
                }))
            : null);
}

/**
 * Creates the `'memory'` Workbench IterateTarget (configuration + node-type schema).
 * @param {() => object | null} getCtx
 * @param {object} [deps]
 */
export function createMemoryConfigTarget(getCtx = defaultGetContext, deps = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getCtx();
    const blankSeedAvatars = new Set();
    const metaByRef = new WeakMap();

    const reportError = (message) => {
        if (typeof deps.onError === 'function') {
            deps.onError(message);
        } else {
            globalThis.toastr?.error?.(message, i18n('Memory graph'));
        }
    };

    const resolveMeta = (live, targetRef = null, { scope = null, ctx = null } = {}) => {
        if (targetRef && typeof targetRef === 'object' && targetRef.scope) {
            return {
                scope: targetRef.scope === 'character' ? 'character' : 'global',
                avatar: String(targetRef.avatar || ''),
                hasOverride: Boolean(targetRef.hasOverride),
                characterName: String(targetRef.characterName || ''),
            };
        }
        if (targetRef && typeof targetRef === 'object' && metaByRef.has(targetRef)) {
            return metaByRef.get(targetRef);
        }
        if (live && typeof live === 'object' && metaByRef.has(live)) {
            return metaByRef.get(live);
        }
        const resolvedScope = scope === 'character' ? 'character' : 'global';
        if (resolvedScope === 'character') {
            const c = ctx || resolveCtx();
            const avatar = resolveActiveAvatar(c);
            const info = avatar ? resolveScopeInfo(c, getMgSettings()) : null;
            return {
                scope: 'character',
                avatar,
                hasOverride: Boolean(info?.hasOverride),
                characterName: String(info?.characterName || (avatar ? resolveActiveCharacterName(c, avatar) : '') || ''),
            };
        }
        return {
            scope: 'global',
            avatar: '',
            hasOverride: false,
            characterName: '',
        };
    };

    const getMgSettings = () => deps.getSettings?.() || resolveCtx()?.extensionSettings?.memory_graph || {};
    const normalizeSchema = (schema) => (typeof deps.normalizeNodeTypeSchema === 'function' ? deps.normalizeNodeTypeSchema(schema) : schema);
    const defaultSchema = () => (typeof deps.getDefaultNodeTypeSchema === 'function' ? deps.getDefaultNodeTypeSchema() : []);

    function resolveGlobalDoc(mgSettings) {
        return {
            schema: normalizeSchema(clone(mgSettings?.nodeTypeSchema || [])),
            settings: resolveSettingsForView(normalizeAdvancedSettings(mgSettings, ADVANCED_SETTING_DEFAULTS)),
        };
    }

    function resolveDefaultDoc() {
        return {
            schema: normalizeSchema(clone(defaultSchema())),
            settings: getDefaultSettingsView(),
        };
    }

    function resolveScopeInfo(ctx, mgSettings) {
        if (typeof deps.getSchemaScopeInfo === 'function') {
            return deps.getSchemaScopeInfo(ctx, mgSettings);
        }
        const avatar = resolveActiveAvatar(ctx);
        const override = avatar ? deps.getCharacterSchemaOverrideByAvatar?.(ctx, avatar) : null;
        return {
            avatar,
            hasAvatar: Boolean(avatar),
            characterName: resolveActiveCharacterName(ctx, avatar),
            hasOverride: Array.isArray(override) && override.length > 0,
            scope: Array.isArray(override) && override.length > 0 ? 'character' : 'global',
            schema: override ? normalizeSchema(clone(override)) : normalizeSchema(clone(mgSettings?.nodeTypeSchema || [])),
        };
    }

    return {
        id: 'memory',
        get label() { return i18n('Memory graph'); },
        tone: 'memory',
        order: 10,
        chips: () => [
            i18n('Why was something that should be remembered not recalled'),
            i18n('Create a new memory type'),
            i18n('What to do about high always-on injection'),
            i18n('Make the field descriptions clearer'),
        ],
        scopeNotes: {
            global: () => i18n('Edit the memory structure shared by all characters'),
            character: () => i18n('Edit only this character\'s own memory structure (created on save if there is none)'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            return { global: true, character: Boolean(resolveActiveAvatar(c)) };
        },
        getNativeAi() {
            const s = getMgSettings();
            if (!s) return null;
            return {
                connection: String(s.requestApiPresetName || '').trim(),
                preset: String(s.requestLlmPresetName || '').trim(),
            };
        },
        async promptInfo(ctx) {
            const c = resolveCtx(ctx);
            const mgSettings = getMgSettings();
            const effective = deps.getEffectiveSettings?.(c, mgSettings) || mgSettings;
            const stored = String(effective?.configIterSystemPrompt || '').trim();
            const custom = Boolean(stored) && stored !== DEFAULT_CONFIG_ITER_SYSTEM_PROMPT.trim();
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('Configuration Iteration Prompt (configuration-editor AI)')),
                custom,
                text: stored || DEFAULT_CONFIG_ITER_SYSTEM_PROMPT,
            };
        },
        renderControls({ scope, onReload } = {}) {
            if (scope !== 'character') return null;
            const c = resolveCtx();
            const avatar = resolveActiveAvatar(c);
            if (!avatar) return null;
            const info = resolveScopeInfo(c, getMgSettings());
            const isBlank = blankSeedAvatars.has(avatar);

            const blankBtn = h('button', {
                type: 'button',
                class: 'lw-btn is-ghost is-sm',
                'aria-pressed': String(isBlank),
                title: i18n('Start from a blank schema shell (keeps settings)'),
                dataset: { wbMemoryControl: 'reset-blank' },
                onClick: async () => {
                    try {
                        if (blankSeedAvatars.has(avatar)) blankSeedAvatars.delete(avatar);
                        else blankSeedAvatars.add(avatar);
                        await onReload?.();
                    } catch (err) {
                        reportError(String(err?.message || err || i18n('Operation failed')));
                    }
                },
            }, i18n('Reset to blank'));

            const globalBtn = h('button', {
                type: 'button',
                class: 'lw-btn is-ghost is-sm',
                disabled: !info?.hasOverride && !isBlank,
                title: i18n('Remove this character\'s schema override and use the global schema'),
                dataset: { wbMemoryControl: 'reset-global' },
                onClick: async () => {
                    try {
                        blankSeedAvatars.delete(avatar);
                        if (info?.hasOverride && typeof deps.removeCharacterSchemaOverride === 'function') {
                            const ok = await deps.removeCharacterSchemaOverride(c, avatar, { requireSaved: true });
                            if (ok !== true) {
                                throw new SourceError('write-failed', i18n('Failed to reset character schema override'));
                            }
                            deps.invalidateLatestRecallSnapshot?.();
                        }
                        await onReload?.();
                    } catch (err) {
                        reportError(String(err?.message || err || i18n('Failed to reset character schema override')));
                    }
                },
            }, i18n('Reset to global'));

            return h('div', { class: 'wb-preset-controls wb-memory-controls' }, blankBtn, globalBtn);
        },
        renderPreview: ({ base, ai }) => renderMemoryConfigPreview({ base, ai }),
        async load(scope, ctx) {
            const c = resolveCtx(ctx);
            const mgSettings = getMgSettings();
            const resolvedScope = scope === 'character' ? 'character' : 'global';

            if (resolvedScope === 'character') {
                const avatar = resolveActiveAvatar(c);
                if (!avatar) {
                    throw new SourceError('no-character', i18n('No active character selected.'));
                }
                const info = resolveScopeInfo(c, mgSettings);
                const effectiveSchema = blankSeedAvatars.has(avatar)
                    ? []
                    : normalizeSchema(clone(deps.getEffectiveNodeTypeSchema ? deps.getEffectiveNodeTypeSchema(c, mgSettings) : info.schema));
                const effectiveSettings = resolveSettingsForView(deps.getEffectiveSettings?.(c, mgSettings) || mgSettings);
                const characterName = String(info?.characterName || resolveActiveCharacterName(c, avatar) || avatar);
                const live = { schema: effectiveSchema, settings: effectiveSettings };
                const target = { scope: 'character', avatar, hasOverride: Boolean(info?.hasOverride) };
                const meta = { scope: 'character', avatar, hasOverride: Boolean(info?.hasOverride), characterName };
                metaByRef.set(live, meta);
                metaByRef.set(target, meta);
                return {
                    live,
                    target,
                    title: i18nFormat(
                        'Memory structure for "${0}" only${1}',
                        characterName,
                        info?.hasOverride ? '' : i18n(' (none yet, created on save)'),
                    ),
                };
            }

            const live = resolveGlobalDoc(mgSettings);
            const target = { scope: 'global', avatar: '', hasOverride: false };
            const meta = { scope: 'global', avatar: '', hasOverride: false };
            metaByRef.set(live, meta);
            metaByRef.set(target, meta);
            return {
                live,
                target,
                title: i18n('Memory structure shared by all characters'),
            };
        },
        async prompt(live, scope, ctx, extra = {}) {
            const c = resolveCtx(ctx);
            const mgSettings = getMgSettings();
            const meta = resolveMeta(live, extra?.target, { scope, ctx: c });
            if (meta.scope === 'character') {
                const effective = deps.getEffectiveSettings?.(c, mgSettings) || mgSettings;
                const base = String(effective?.configIterSystemPrompt || '').trim() || DEFAULT_CONFIG_ITER_SYSTEM_PROMPT;
                return appendScopeHintIfNeeded(base, {
                    scope: 'character',
                    hasOverride: Boolean(meta.hasOverride),
                    characterDisplayName: meta.characterName || resolveActiveCharacterName(c, meta.avatar || resolveActiveAvatar(c)),
                });
            }
            return String(mgSettings?.configIterSystemPrompt || '').trim() || DEFAULT_CONFIG_ITER_SYSTEM_PROMPT;
        },
        async tools(live, scope, ctx, extra = {}) {
            const c = resolveCtx(ctx);
            const meta = resolveMeta(live, extra?.target, { scope, ctx: c });
            if (meta.scope === 'character' && (meta.avatar || resolveActiveAvatar(c))) {
                const catalog = buildToolCatalog().filter((def) => {
                    const name = def?.function?.name;
                    if (name === CONTROL_TOOL_NAMES.resetToGlobal) return Boolean(meta.hasOverride);
                    return true;
                });
                return [...catalog, ...LOREBOOK_READ_TOOL_DEFS];
            }
            return [...CONFIG_TOOL_DEFS, ...LOREBOOK_READ_TOOL_DEFS];
        },
        isRead: (name) => isMgConfigReadTool({ name }) || isLorebookReadTool(name),
        async runRead(call, live, helpers = {}) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const meta = resolveMeta(live, helpers?.target, { ctx: c });

            if (isLorebookReadTool(name)) {
                const avatar = meta.scope === 'character' ? (meta.avatar || resolveActiveAvatar(c)) : '';
                const out = await runLorebookReadTool({ id: call?.id, name, args }, { context: c, avatar });
                if (!out?.ok) {
                    throw new SourceError('read', String(out?.error || i18n('Read failed')));
                }
                return out.result;
            }

            if (name === READ_TOOL_NAMES.listFields) {
                return buildConfigFieldCatalog({ schema: live?.schema, group: args.group });
            }

            if (name === READ_TOOL_NAMES.readFields) {
                const mgSettings = getMgSettings();
                return await dispatchMgConfigReadFields({
                    sources: {
                        working: live,
                        global: resolveGlobalDoc(mgSettings),
                        default: resolveDefaultDoc(),
                    },
                    args,
                });
            }

            throw new SourceError('unknown_tool', `Unknown read tool: ${name}`);
        },
        async runEdit(call, live, helpers = {}) {
            const name = String(call?.name || '');
            const mgSettings = getMgSettings();
            const meta = resolveMeta(live, helpers?.target);

            const tagNext = (next) => {
                if (next && typeof next === 'object' && next !== live) {
                    metaByRef.set(next, meta);
                }
                return next;
            };

            if (isMgSchemaControlCall({ name })) {
                if (meta.scope !== 'character') {
                    throw new SourceError('not_allowed', `${name}: not_allowed — schema resets are only available in character scope.`);
                }
                if (name === CONTROL_TOOL_NAMES.resetToBlank) {
                    return tagNext({ ...clone(live), schema: [] });
                }
                if (name === CONTROL_TOOL_NAMES.resetToGlobal) {
                    return tagNext({ ...clone(live), schema: normalizeSchema(clone(mgSettings?.nodeTypeSchema || [])) });
                }
            }

            const globalSettings = resolveGlobalDoc(mgSettings).settings;
            const defaultSettings = resolveDefaultDoc().settings;
            const normalized = await normalizeToolCallToEdit(
                wrapToolCallForNormalize(call),
                {
                    live,
                    normalizeNodeTypeSchema: normalizeSchema,
                    resolveUnsetBaseline: (rawPath) => {
                        const path = String(rawPath || '');
                        const key = path.startsWith('settings.') ? path.slice('settings.'.length) : path;
                        const source = meta.scope === 'character' ? globalSettings : defaultSettings;
                        return source?.[key];
                    },
                },
            );
            if (!Array.isArray(normalized) || !normalized.length) return live;
            return tagNext(normalized[normalized.length - 1].newValue);
        },
        units: (live) => memoryConfigUnits(live),
        rebuild: (base, ai, keys) => rebuildMemoryConfig(base, ai, keys),
        async commit(targetRef, base, next, keys) {
            const c = resolveCtx();
            const scope = targetRef?.scope === 'character' ? 'character' : 'global';
            const expectedAvatar = String(targetRef?.avatar || '').trim();

            const checkAvatar = () => {
                if (scope !== 'character') return '';
                const liveAvatar = resolveActiveAvatar(c);
                if (!expectedAvatar || liveAvatar !== expectedAvatar) {
                    throw new SourceError('character-changed', i18n('The active character has changed.'));
                }
                return expectedAvatar;
            };

            const readDiskDoc = (avatar) => {
                const mgSettings = getMgSettings();
                const globalDoc = resolveGlobalDoc(mgSettings);
                if (scope === 'character') {
                    const charSchemaOverride = deps.getCharacterSchemaOverrideByAvatar?.(c, avatar) || null;
                    const charSettings = resolveSettingsForView(deps.getEffectiveSettings?.(c, mgSettings) || mgSettings);
                    return {
                        doc: {
                            schema: normalizeSchema(clone(charSchemaOverride || mgSettings?.nodeTypeSchema || [])),
                            settings: charSettings,
                        },
                        globalDoc,
                        hasCharSchemaOverride: Array.isArray(charSchemaOverride) && charSchemaOverride.length > 0,
                    };
                }
                return { doc: globalDoc, globalDoc, hasCharSchemaOverride: false };
            };

            const writeDoc = async (avatar, beforeDoc, targetDoc, { removeOverrideIfMatchesGlobal = false, priorHadSchemaOverride = true } = {}) => {
                const mgSettings = getMgSettings();
                const globalSettings = resolveGlobalDoc(mgSettings).settings;
                const normalizedTarget = {
                    schema: normalizeSchema(clone(targetDoc.schema)),
                    settings: targetDoc.settings,
                };
                const inheritedSettings = scope === 'character' ? globalSettings : resolveDefaultDoc().settings;
                const plan = planConfigCommit({
                    before: beforeDoc,
                    next: normalizedTarget,
                    scope,
                    inheritedSettings,
                });

                if (scope === 'character') {
                    const matchesGlobalSchema = JSON.stringify(normalizedTarget.schema) === JSON.stringify(resolveGlobalDoc(mgSettings).schema);
                    await applyConfigPlan(plan, {
                        scope: 'character',
                        globalSettings: mgSettings,
                        persistCharacterSchema: async (schema) => {
                            if (removeOverrideIfMatchesGlobal && !priorHadSchemaOverride && matchesGlobalSchema) {
                                return deps.removeCharacterSchemaOverride(c, avatar, { requireSaved: true });
                            }
                            return deps.persistCharacterSchemaOverride(c, avatar, schema, { requireSaved: true });
                        },
                        persistCharacterSettings: (patch) => deps.persistCharacterAdvancedOverridePatch(c, avatar, patch, { requireSaved: true }),
                        saveGlobalSettings: () => Promise.resolve(),
                    });
                } else {
                    const prevSnapshot = {};
                    const prevHadKey = {};
                    for (const def of Object.values(CONFIG_FIELDS)) {
                        prevHadKey[def.key] = Object.prototype.hasOwnProperty.call(mgSettings, def.key);
                        prevSnapshot[def.key] = clone(mgSettings[def.key]);
                    }
                    const prevHadSchema = Object.prototype.hasOwnProperty.call(mgSettings, 'nodeTypeSchema');
                    const prevSchema = clone(mgSettings.nodeTypeSchema);
                    try {
                        await applyConfigPlan(plan, {
                            scope: 'global',
                            globalSettings: mgSettings,
                            persistCharacterSchema: async () => true,
                            persistCharacterSettings: async () => true,
                            saveGlobalSettings: () => {
                                // Keep seeded defaults present on mgSettings while leaving
                                // unseeded prompt/flag slots deleted when reset to default.
                                for (const key of plan.unset || []) {
                                    if (Object.prototype.hasOwnProperty.call(ADVANCED_SETTING_DEFAULTS, key)) {
                                        mgSettings[key] = ADVANCED_SETTING_DEFAULTS[key];
                                    }
                                }
                                return saveSettingsChecked(c);
                            },
                        });
                    } catch (err) {
                        if (prevHadSchema) mgSettings.nodeTypeSchema = prevSchema;
                        else delete mgSettings.nodeTypeSchema;
                        for (const def of Object.values(CONFIG_FIELDS)) {
                            if (prevHadKey[def.key]) mgSettings[def.key] = prevSnapshot[def.key];
                            else delete mgSettings[def.key];
                        }
                        throw err;
                    }
                }

                deps.invalidateLatestRecallSnapshot?.();
                try { deps.syncGenerationVisibleHistoryRuntimeRegexScripts?.(); } catch { /* runtime regex sync optional in isolated tests */ }
            };

            const avatar = checkAvatar();
            const { doc: beforeDisk, hasCharSchemaOverride } = readDiskDoc(avatar);
            const ops = fieldPlan(memoryConfigUnits(base), memoryConfigUnits(next), keys);
            const merged = mergeOps(memoryConfigUnits(beforeDisk), ops);
            const applied = [...merged.write, ...merged.already].map(op => op.key);
            requireApplied({ applied, skipped: merged.skipped });

            if (merged.write.length) {
                const mergedDoc = applyMemoryConfigOps(beforeDisk, merged.write);
                await writeDoc(avatar, beforeDisk, mergedDoc);
            }
            if (scope === 'character') blankSeedAvatars.delete(avatar);

            return {
                applied,
                skipped: merged.skipped,
                failure: '',
                async undo() {
                    if (!merged.write.length) return;
                    const undoAvatar = checkAvatar();
                    const { doc: nowDisk } = readDiskDoc(undoAvatar);
                    const back = mergeOps(memoryConfigUnits(nowDisk), reverseOps(merged.write));
                    if (back.write.length) {
                        const revertedDoc = applyMemoryConfigOps(nowDisk, back.write);
                        await writeDoc(undoAvatar, nowDisk, revertedDoc, {
                            removeOverrideIfMatchesGlobal: true,
                            priorHadSchemaOverride: hasCharSchemaOverride,
                        });
                    }
                    if (back.skipped.length) throw conflictsLeftAlone(back.skipped.length);
                },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Memory graph data (`memory_graph`) target: chat-scoped graph revisions
// ---------------------------------------------------------------------------

function formatGraphRecordsText(doc, nodeIds, linkKeys) {
    const lines = [];
    for (const id of nodeIds) {
        const n = doc?.nodes?.[id];
        if (!n) continue;
        const fields = n.fields && typeof n.fields === 'object' ? JSON.stringify(n.fields) : '{}';
        lines.push(`[node ${id}] ${n.type || ''} · ${n.title || ''}${n.archived ? ' (archived)' : ''} ${fields}`);
    }
    for (const k of linkKeys) {
        const e = doc?.links?.[k];
        if (!e) continue;
        lines.push(`[link] ${e.from} -${e.type}-> ${e.to}`);
    }
    return lines.join('\n');
}

function summarizeGraphEntry(entry) {
    const s = entry?.meta?.summary;
    if (!s || typeof s !== 'object') return i18n('Graph change');
    const parts = [];
    const addedN = s.addedNodes?.length || 0;
    const modN = s.modifiedNodes?.length || 0;
    const remN = s.removedNodes?.length || 0;
    const addedL = s.addedLinks?.length || 0;
    const modL = s.modifiedLinks?.length || 0;
    const remL = s.removedLinks?.length || 0;
    const totalN = addedN + modN + remN;
    const totalL = addedL + modL + remL;
    if (totalN === 1 && totalL === 0) {
        const n = s.addedNodes?.[0] || s.modifiedNodes?.[0] || s.removedNodes?.[0];
        const kindLabel = addedN ? i18n('Added node') : (remN ? i18n('Removed node') : (n?.archivedTransition ? i18n('Archived node') : i18n('Modified node')));
        const name = n?.title || n?.id || '';
        return name ? `${kindLabel}: ${name}` : kindLabel;
    }
    if (totalL === 1 && totalN === 0) {
        const l = s.addedLinks?.[0] || s.modifiedLinks?.[0] || s.removedLinks?.[0];
        const kindLabel = addedL ? i18n('Added link') : (remL ? i18n('Removed link') : i18n('Modified link'));
        return l ? `${kindLabel}: ${l.from} -> ${l.to} (${l.type})` : kindLabel;
    }
    if (totalN) parts.push(`${totalN} ${i18n('Nodes')}`);
    if (totalL) parts.push(`${totalL} ${i18n('Links')}`);
    return parts.join(' · ') || i18n('Graph change');
}

function renderMemoryGraphPreview({ base, ai }) {
    const stagedDoc = ai || base;
    if (!stagedDoc || typeof stagedDoc !== 'object') return null;
    const stagedNodes = (stagedDoc.nodes && typeof stagedDoc.nodes === 'object') ? stagedDoc.nodes : {};
    const liveNodes = (base?.nodes && typeof base.nodes === 'object') ? base.nodes : {};
    const stagedLinks = (stagedDoc.links && typeof stagedDoc.links === 'object') ? stagedDoc.links : {};
    const liveLinks = (base?.links && typeof base.links === 'object') ? base.links : {};
    const diff = diffGraphDocs(base, stagedDoc);
    const addedNodes = new Set(diff.addedNodes);
    const removedNodes = new Set(diff.removedNodes);
    const modifiedNodes = new Set(diff.modifiedNodes);
    const addedLinks = new Set(diff.addedLinks);
    const removedLinks = new Set(diff.removedLinks);
    const modifiedLinks = new Set(diff.modifiedLinks);

    const groups = new Map();
    const sortedNodes = Object.values(stagedNodes).slice().sort((a, b) => {
        const archDelta = Number(Boolean(a?.archived)) - Number(Boolean(b?.archived));
        if (archDelta !== 0) return archDelta;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
    for (const node of sortedNodes) {
        const type = String(node?.type || 'unknown');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(node);
    }
    for (const id of diff.removedNodes) {
        const node = liveNodes[id];
        if (!node) continue;
        const type = String(node?.type || 'unknown');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push({ ...node, __removed: true });
    }

    const container = h('div', { class: 'wb-mg-graph-preview' });
    const totalNodes = Object.keys(stagedNodes).length;
    const totalLinks = Object.keys(stagedLinks).length;
    put(container,
        h('div', { class: 'wb-sec-title' },
            h('span', { text: i18n('Graph') }),
            h('span', { class: 'wb-note', text: i18nFormat('${0} node(s), ${1} link(s)', totalNodes, totalLinks) })));

    if (totalNodes === 0 && removedNodes.size === 0) {
        put(container, h('div', { class: 'wb-note', text: i18n('This chat has no memory nodes yet.') }));
        return container;
    }

    for (const [type, nodes] of groups) {
        put(container, h('details', { class: 'wb-mg-preview-group', open: true },
            h('summary', null,
                h('span', { class: 'wb-mg-preview-label', text: type }),
                h('span', { class: 'wb-note', text: String(nodes.length) })),
            nodes.map((node) => {
                const id = String(node?.id || '');
                const state = (node.__removed || removedNodes.has(id))
                    ? 'is-del'
                    : (addedNodes.has(id) ? 'is-add' : (modifiedNodes.has(id) ? 'is-change' : ''));
                const marker = state === 'is-add' ? '+' : state === 'is-del' ? '-' : state === 'is-change' ? '~' : '';
                return h('div', { class: `wb-mg-preview-row ${state}`.trim(), dataset: { mgGraphNodeId: id } },
                    marker ? h('span', { class: 'wb-chg-tag', text: marker }) : null,
                    h('span', { class: 'wb-mg-preview-label', text: node?.title || id }),
                    h('span', { class: 'wb-note', text: node?.archived ? `${id} · ${i18n('Archived')}` : id }));
            })));
    }

    const linkEls = [];
    for (const key of [...addedLinks, ...modifiedLinks]) {
        const edge = stagedLinks[key];
        if (!edge) continue;
        const isAdd = addedLinks.has(key);
        linkEls.push(h('div', { class: `wb-mg-preview-row ${isAdd ? 'is-add' : 'is-change'}`, dataset: { mgGraphLinkKey: key } },
            h('span', { class: 'wb-chg-tag', text: isAdd ? '+' : '~' }),
            h('span', { class: 'wb-note', text: `${edge.from} —${edge.type}→ ${edge.to}` })));
    }
    for (const key of removedLinks) {
        const edge = liveLinks[key];
        if (!edge) continue;
        linkEls.push(h('div', { class: 'wb-mg-preview-row is-del', dataset: { mgGraphLinkKey: key } },
            h('span', { class: 'wb-chg-tag is-del', text: '-' }),
            h('span', { class: 'wb-note', text: `${edge.from} —${edge.type}→ ${edge.to}` })));
    }
    if (linkEls.length > 0) {
        put(container, h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Links') })), linkEls);
    }

    return container;
}

/**
 * Creates the `'memory_graph'` Workbench IterateTarget (chat-scoped graph revision).
 * @param {() => object | null} getCtx
 * @param {object} [deps]
 */
export function createMemoryGraphTarget(getCtx = defaultGetContext, deps = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getCtx();
    const getMgSettings = () => deps.getSettings?.() || resolveCtx()?.extensionSettings?.memory_graph || {};

    const reportError = (message) => {
        if (typeof deps.onError === 'function') {
            deps.onError(message);
        } else {
            globalThis.toastr?.error?.(message, i18n('Memory graph'));
        }
    };

    const resolveChatKey = (ctx) => {
        const key = String(deps.getChatKey?.(ctx) || '').trim();
        return key && key !== 'invalid_target' ? key : '';
    };

    const hasOpenChat = (ctx) => {
        if (!ctx) return false;
        const chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
        if (!chatId) return false;
        return Boolean(resolveChatKey(ctx));
    };

    const chatDisplayLabel = (ctx) => {
        if (!ctx) return '';
        if (ctx.groupId) {
            const g = (ctx.groups || []).find(item => String(item.id) === String(ctx.groupId));
            return String(g?.name || '');
        }
        return String(ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '').trim();
    };

    const graphTargetHandler = {
        async read(target) {
            const c = resolveCtx();
            const expectedKey = String(target?.chatKey || target?.name || '').trim();
            const liveKey = resolveChatKey(c);
            if (!expectedKey || !liveKey || liveKey !== expectedKey) {
                throw new SourceError('chat-changed', i18n('The active chat has changed.'));
            }
            const liveStore = await deps.ensureStoreSyncedWithChat?.(c);
            if (!liveStore) {
                throw new SourceError('no-chat', i18n('Open a chat first.'));
            }
            return canonicalFromStore(liveStore);
        },
        async write(target, nextDoc) {
            const c = resolveCtx();
            const expectedKey = String(target?.chatKey || target?.name || '').trim();
            const liveKey = resolveChatKey(c);
            if (!expectedKey || !liveKey || liveKey !== expectedKey) {
                throw new SourceError('chat-changed', i18n('The active chat has changed.'));
            }
            const liveStore = await deps.ensureStoreSyncedWithChat?.(c);
            if (!liveStore) {
                throw new SourceError('no-chat', i18n('Open a chat first.'));
            }
            const beforeDoc = canonicalFromStore(liveStore);
            const nextStore = applyCanonicalToStore(nextDoc, liveStore);
            const inner = await deps.commitGraphUiMutation?.(c, liveKey, {
                beforeStore: liveStore,
                afterStore: nextStore,
                replaceGraph: false,
                seq: null,
            });
            if (inner && inner.skipped) {
                throw new SourceError('write-skipped', String(inner.hint || inner.reason || 'commit skipped'));
            }
            if (docsTouchNodes(beforeDoc, canonicalFromStore(nextStore))) {
                try {
                    await deps.syncGraphVectorsAfterMutation?.(c, liveKey, nextStore);
                } catch (err) {
                    console.error('[memory-graph/lens] vector sync after graph revision failed', err);
                    reportError(i18nFormat('Vector recompute failed: ${0}', String(err?.message || err)));
                }
            }
        },
        describe: (target) => String(target?.chatKey || target?.name || 'memory-graph'),
    };

    const proposalKinds = {
        'graph-revision': {
            kind: 'graph-revision',
            targetType: 'memory-graph',
            inverseAvailable: true,
            targetHandler: graphTargetHandler,
            changeKind: (entry) => {
                const s = entry?.meta?.summary;
                if (!s) return 'change';
                const adds = (s.addedNodes?.length || 0) + (s.addedLinks?.length || 0);
                const mods = (s.modifiedNodes?.length || 0) + (s.modifiedLinks?.length || 0);
                const rems = (s.removedNodes?.length || 0) + (s.removedLinks?.length || 0);
                if (adds > 0 && mods === 0 && rems === 0) return 'add';
                if (rems > 0 && adds === 0 && mods === 0) return 'remove';
                return 'change';
            },
            label: summarizeGraphEntry,
            group: () => i18n('Memory graph'),
            beforeText: (entry) => {
                const before = entry?.meta?.before;
                const after = entry?.meta?.after;
                if (!before || !after) return '';
                const d = diffGraphDocs(before, after);
                return formatGraphRecordsText(before, [...d.modifiedNodes, ...d.removedNodes], [...d.modifiedLinks, ...d.removedLinks]);
            },
            afterText: (entry) => {
                const before = entry?.meta?.before;
                const after = entry?.meta?.after;
                if (!before || !after) return '';
                const d = diffGraphDocs(before, after);
                return formatGraphRecordsText(after, [...d.modifiedNodes, ...d.addedNodes], [...d.modifiedLinks, ...d.addedLinks]);
            },
        },
    };

    return {
        id: 'memory_graph',
        get label() { return i18n('Graph'); },
        tone: 'memory',
        order: 15,
        proposalKinds,
        chips: () => [
            i18n('Merge duplicate nodes'),
            i18n('Fix outdated character or location state'),
            i18n('Add missing relationships between nodes'),
            i18n('Check the graph against recent chat messages'),
        ],
        scopeNotes: {
            chat: () => i18n('Edit the memory graph stored in this chat'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            return { chat: hasOpenChat(c) };
        },
        getNativeAi() {
            const s = getMgSettings();
            if (!s) return null;
            return {
                connection: String(s.requestApiPresetName || '').trim(),
                preset: String(s.requestLlmPresetName || '').trim(),
            };
        },
        async promptInfo(ctx) {
            const c = resolveCtx(ctx);
            const mgSettings = getMgSettings();
            const effective = deps.getEffectiveSettings?.(c, mgSettings) || mgSettings;
            const stored = String(effective?.graphIterSystemPrompt || '').trim();
            const custom = Boolean(stored) && stored !== DEFAULT_GRAPH_ITER_SYSTEM_PROMPT.trim();
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('Graph Revision Prompt (graph-editor AI)')),
                custom,
                text: stored || DEFAULT_GRAPH_ITER_SYSTEM_PROMPT,
            };
        },
        renderPreview: ({ base, ai, target }) => renderMemoryGraphPreview({ base, ai, target }),
        async load(_scope, ctx) {
            const c = resolveCtx(ctx);
            const chatKey = resolveChatKey(c);
            if (!hasOpenChat(c) || !chatKey) {
                throw new SourceError('no-chat', i18n('Open a chat first.'));
            }
            const liveStore = await deps.ensureStoreSyncedWithChat?.(c);
            if (!liveStore) {
                throw new SourceError('no-chat', i18n('Open a chat first.'));
            }
            const label = chatDisplayLabel(c);
            const chatTarget = c.resolveChatStateTarget?.() || null;
            return {
                live: canonicalFromStore(liveStore),
                target: { scope: 'chat', chatKey, ...(chatTarget ? { target: clone(chatTarget) } : {}) },
                title: label ? i18nFormat('Memory graph of "${0}"', label) : i18n('Memory graph'),
            };
        },
        async prompt(_live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const mgSettings = getMgSettings();
            const effective = deps.getEffectiveSettings?.(c, mgSettings) || mgSettings;
            return buildGraphIterSystemPrompt(effective);
        },
        async tools() {
            return [...GRAPH_TOOL_DEFS, ...LOREBOOK_READ_TOOL_DEFS];
        },
        isRead: (name) => isGraphReadTool(name) || isLorebookReadTool(name),
        async runRead(call, live) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            if (isLorebookReadTool(name)) {
                const avatar = resolveActiveAvatar(c);
                const out = await runLorebookReadTool({ id: call?.id, name, args }, { context: c, avatar });
                if (!out?.ok) {
                    throw new SourceError('read', String(out?.error || i18n('Read failed')));
                }
                return out.result;
            }
            const baseStore = await deps.ensureStoreSyncedWithChat?.(c);
            if (!baseStore) {
                throw new GraphToolError(name || 'unknown', 'not_allowed', 'no graph is loaded for this chat');
            }
            const working = applyCanonicalToStore(live, baseStore);
            const effective = deps.getEffectiveSettings?.(c, getMgSettings()) || getMgSettings();
            const toolDeps = {
                getEffectiveNodeTypeSchema: deps.getEffectiveNodeTypeSchema,
                readChatRange: (from, to) => deps.readChatRange?.(c, from, to),
                searchSimilarNodes: (query, opts) => deps.searchGraphSimilarNodes?.(c, query, opts),
            };
            return await executeGraphReadTool(
                { name, args },
                { working, deps: toolDeps, context: c, settings: effective },
            );
        },
        async runEdit(call, live, helpers) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            if (!isGraphWriteTool(name)) {
                throw new GraphToolError(name || 'unknown', 'unknown_tool', `unknown tool "${name}"`);
            }
            const baseStore = await deps.ensureStoreSyncedWithChat?.(c);
            if (!baseStore) {
                throw new GraphToolError(name, 'not_allowed', 'no graph is loaded for this chat');
            }
            const working = applyCanonicalToStore(live, baseStore);
            const effective = deps.getEffectiveSettings?.(c, getMgSettings()) || getMgSettings();
            const writeApi = deps.getMemoryGraphWriteApi?.(working, c, {
                onCommit: null,
                settings: effective,
                useInFlightAnchor: false,
                preserveSeqOnEdit: true,
            });
            const toolDeps = {
                getEffectiveNodeTypeSchema: deps.getEffectiveNodeTypeSchema,
                readChatRange: (from, to) => deps.readChatRange?.(c, from, to),
                searchSimilarNodes: (query, opts) => deps.searchGraphSimilarNodes?.(c, query, opts),
            };
            const payload = await executeGraphWriteTool(
                { name, args },
                { working, writeApi, deps: toolDeps, context: c, settings: effective },
            );
            const afterDoc = canonicalFromStore(working);
            if (payload?.changed === false || docsEqual(live, afterDoc)) {
                return live;
            }
            const chatKey = resolveChatKey(c);
            await helpers.propose({
                kind: 'graph-revision',
                target: { type: 'memory-graph', name: chatKey, chatKey },
                before: live,
                after: afterDoc,
                meta: {
                    summary: buildGraphDiffSummary(live, afterDoc),
                    before: live,
                    after: afterDoc,
                },
            });
            return afterDoc;
        },
        units: () => new Map(),
        rebuild: (_base, ai) => ai,
        commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
    };
}
