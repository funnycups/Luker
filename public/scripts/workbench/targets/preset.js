// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Platform-owned `preset` IterateTarget for Workbench AI iteration.
// Provides full CPA parity: mode selector (general / orchestrator-optimize /
// jailbreak-only), reference preset selector, skill authoring & preset-clone
// proposals via ProposalBus, prompt simulation, and honoring custom CPA
// prompts from extensionSettings.completion_preset_assistant when present.

import { resolveLodash } from './lodash-fallback.js';
import { createEngine } from '../../lib/edits/engine.js';
import { createSetOp } from '../../lib/edits/ops/set.js';
import { createUnsetOp } from '../../lib/edits/ops/unset.js';
import { createStrReplaceOp } from '../../lib/edits/ops/str-replace.js';
import { createStrInsertOp } from '../../lib/edits/ops/str-insert.js';
import { createStrDeleteOp } from '../../lib/edits/ops/str-delete.js';
import { createListInsertOp } from '../../lib/edits/ops/list-insert.js';
import { createListRemoveOp } from '../../lib/edits/ops/list-remove.js';
import { createListMoveOp } from '../../lib/edits/ops/list-move.js';
import { h } from '../../lens-shared/util.js';
import { skillAuthor, presetClone } from '../../iteration-library/proposal-bus/index.js';
import { i18n, i18nFormat } from '../i18n.js';
import { SourceError } from '../model/errors.js';
import { requireStoredPrompt } from '../../lib/prompt-values.js';
import { commitFields, fieldPlan } from '../model/patch.js';
import { presetUnits, applyPresetOps, presetRebuild } from '../model/adapters.js';
import { select } from '../ui/components.js';
import {
    buildBaseSystemPrompt,
    buildOrchestratorOptimizeModeBlock,
    buildJailbreakOnlyModeBlock,
    sanitizeSessionMode,
    SESSION_MODE_DEFAULT,
} from './preset-prompts.js';
import { buildCpaSkillsBlock } from './preset-skill-prompt.js';
import {
    buildToolCatalog,
    normalizeToolCallToEdit,
    runCpaReadTool,
    runCpaSkillTool,
    commitApprovedSkillProposal,
    isCpaSkillTool,
    isCpaSkillReadTool,
} from './preset-tools.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const defaultGetContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;

function getLocalApplyEdits(ctx) {
    const lodash = resolveLodash(ctx);
    const engine = createEngine({
        get: lodash.get,
        set: lodash.set,
        unset: lodash.unset,
        isEqual: lodash.isEqual,
        cloneDeep: lodash.cloneDeep,
    });
    for (const [name, handler] of [
        ['set', createSetOp()],
        ['unset', createUnsetOp()],
        ['str_replace', createStrReplaceOp()],
        ['str_insert', createStrInsertOp()],
        ['str_delete', createStrDeleteOp()],
        ['list_insert', createListInsertOp()],
        ['list_remove', createListRemoveOp()],
        ['list_move', createListMoveOp()],
    ]) {
        engine.registerOp(name, handler);
    }
    return engine.applyEdits;
}

function applyEditsTo(edits, live, ctx) {
    const applyFn = ctx?.edits?.applyEdits || ctx?.iterationLibrary?.applyEdits || getLocalApplyEdits(ctx);
    const res = applyFn(edits, clone(live));
    if (res?.conflicts?.length) {
        const c = res.conflicts[0];
        throw new SourceError('conflict', i18nFormat('Not changed (${0}): ${1}. Read the latest content first.', c.reason, c.edit?.path || ''));
    }
    return res.newLive;
}

function listOpenAiPresetRefs(ctx) {
    const refs = ctx?.presets?.list?.('openai');
    if (Array.isArray(refs) && refs.length) return refs;
    const names = ctx?.getPresetManager?.('openai')?.getAllPresets?.();
    return Array.isArray(names)
        ? names.map((name) => ({ collection: 'openai', name: String(name || '').trim() })).filter((r) => r.name)
        : [];
}

function listOpenAiPresetNames(ctx) {
    return [...new Set(
        listOpenAiPresetRefs(ctx)
            .map((r) => String(r?.name || r || '').trim())
            .filter(Boolean),
    )].sort((a, b) => a.localeCompare(b));
}

function findCanonicalPresetName(names, requestedName) {
    const target = String(requestedName || '').trim().toLocaleLowerCase();
    if (!target) return '';
    return names.find((name) => String(name || '').trim().toLocaleLowerCase() === target) || '';
}

function samePresetRef(a, b) {
    if (!a || !b) return false;
    if (String(a.collection || '') !== String(b.collection || '')) return false;
    if (String(a.name || '') !== String(b.name || '')) return false;
    const originOf = (ref) => (ref.origin?.kind === 'character' ? `character:${ref.origin.avatar || ''}` : 'global');
    return originOf(a) === originOf(b);
}

async function loadReferenceBody(ctx, refName) {
    const name = String(refName || '').trim();
    if (!name || !ctx?.presets) return null;
    const refs = listOpenAiPresetRefs(ctx);
    const matchedRef = refs.find((r) => String(r?.name || r || '').trim() === name);
    const ref = matchedRef && typeof matchedRef === 'object' ? matchedRef : { collection: 'openai', name };
    const stored = ctx.presets.getStored?.(ref);
    const raw = stored?.body ?? (typeof ctx.presets.get === 'function' ? await ctx.presets.get(ref) : null);
    if (!raw || typeof raw !== 'object') return null;
    const strip = ctx.openai?.stripPresetConnectionFields || ((b) => b);
    return clone(strip(raw));
}

const SKILL_OP_LABELS = Object.freeze({
    create: 'Create skill',
    content: 'Update skill file',
    frontmatter: 'Update skill frontmatter',
    rename: 'Rename skill',
    change_scope: 'Move skill scope',
    delete: 'Delete skill',
});

const PRESET_READ_TOOLS = new Set([
    'preset_read_live_fields',
    'preset_read_reference_fields',
    'preset_diff_reference',
    'preset_simulate',
]);

/**
 * Creates a stateful `preset` IterateTarget (holds current mode + reference
 * preset selection across controls, prompt, tools, and reads).
 * @param {{ getContext?: () => object | null }} [opts]
 */
export function createPresetTarget({ getContext = defaultGetContext } = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getContext();
    const state = {
        mode: SESSION_MODE_DEFAULT,
        referenceName: '',
    };

    const skillTargetHandler = {
        read: async (target) => ({ skill: target?.name || '', path: target?.path || '' }),
        write: async (target) => {
            if (target?._op) {
                await commitApprovedSkillProposal(target._op);
            }
        },
        describe: (target) => String(target?.name || 'skill'),
    };

    const presetCloneTargetHandler = {
        read: async (target) => {
            const ctx = resolveCtx();
            const op = target?._cloneOp || {};
            const sourceName = String(op.sourceName || target?.sourceName || '').trim();
            const newName = String(op.newName || target?.newName || '').trim();
            const existing = findCanonicalPresetName(listOpenAiPresetNames(ctx), newName);
            return {
                sourceName,
                newName,
                exists: Boolean(existing),
            };
        },
        write: async (target) => {
            const ctx = resolveCtx();
            const op = target?._cloneOp || {};
            const newName = String(op.newName || target?.newName || '').trim();
            if (!newName) throw new SourceError('bad-args', 'New preset name is required.');
            const existing = findCanonicalPresetName(listOpenAiPresetNames(ctx), newName);
            if (existing) {
                throw new SourceError('conflict', i18nFormat('Preset "${0}" already exists', existing));
            }
            const sourceRef = op.sourceRef || (op.sourceName ? { collection: 'openai', name: op.sourceName } : ctx?.presets?.getSelected?.('openai'));
            if (!sourceRef?.name) throw new SourceError('no-preset', i18n('No chat completion preset selected'));
            const stored = ctx?.presets?.getStored?.(sourceRef);
            const sourceBody = stored?.body ?? (typeof ctx?.presets?.get === 'function' ? await ctx.presets.get(sourceRef) : null);
            if (!sourceBody || typeof sourceBody !== 'object') {
                throw new SourceError('no-preset', i18nFormat('Preset "${0}" is unreadable', sourceRef.name));
            }
            const res = await ctx.presets.save(
                { collection: 'openai', name: newName },
                clone(sourceBody),
                { select: true },
            );
            if (res?.ok !== true) {
                throw new SourceError('write-failed', i18n('Failed to save the preset'));
            }
        },
        describe: (target) => {
            const src = String(target?.sourceName || target?._cloneOp?.sourceName || '');
            const dst = String(target?.newName || target?._cloneOp?.newName || '');
            return src && dst ? `${src} → ${dst}` : (dst || src || 'preset');
        },
    };

    const proposalKinds = {
        'skill-author': {
            ...skillAuthor,
            inverseAvailable: false,
            targetHandler: skillTargetHandler,
            label: (entry) => {
                const opKind = entry?.meta?.kind || entry?.meta?.op?.name;
                const name = String(entry?.meta?.skillName || entry?.target?.name || '').trim();
                const prefix = i18n(SKILL_OP_LABELS[opKind] || 'Create skill');
                return name ? `${prefix}: ${name}` : prefix;
            },
            group: () => i18n('Preset skills'),
        },
        'preset-clone': {
            ...presetClone,
            inverseAvailable: false,
            targetHandler: presetCloneTargetHandler,
            label: () => i18n('Clone preset'),
            group: () => i18n('Preset'),
        },
    };

    function buildPromptText(ctx, { includeRuntimeContext = true, validate = true } = {}) {
        const s = ctx?.extensionSettings?.completion_preset_assistant;
        const readPrompt = key => validate
            ? requireStoredPrompt(s?.[key], i18n('Fill in the prompt or reset it to the default.'))
            : String(s?.[key] ?? '');
        const base = readPrompt('iterBaseSystemPrompt');
        const mode = sanitizeSessionMode(state.mode);
        let modeBlock = '';
        if (mode === 'orchestrator-optimize') {
            modeBlock = readPrompt('iterModePromptOrchestratorOptimize');
        } else if (mode === 'jailbreak-only') {
            modeBlock = readPrompt('iterModePromptJailbreakOnly');
        }
        const parts = [modeBlock ? `${base}\n${modeBlock}` : base];
        if (includeRuntimeContext && state.referenceName) {
            parts.push([
                `Selected reference preset: ${state.referenceName}`,
                'You can read it via preset_read_reference_fields or preset_diff_reference.',
                'preset_copy_from_reference can pull one field from the reference into the live preset.',
            ].join('\n'));
        }
        return parts;
    }

    const target = {
        id: 'preset',
        get label() { return i18n('Preset'); },
        tone: 'preset',
        order: 30,
        proposalKinds,
        chips: () => [
            i18n('Find contradicting requirements'),
            i18n('Trim the style entries'),
            i18n('Replies are too long — what should change'),
            i18n('This reply is out of character — check the preset'),
        ],
        scopeNotes: {
            preset: () => i18n('Presets are not per character — this edits the selected preset'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            return { preset: Boolean(c?.presets?.getSelected?.('openai')?.name) };
        },
        getNativeAi(ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.completion_preset_assistant;
            if (!s) return null;
            return {
                connection: String(s.requestApiPresetName || '').trim(),
                preset: String(s.requestLlmPresetName || '').trim(),
            };
        },
        async promptInfo(ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.completion_preset_assistant;
            const storedBase = String(s?.iterBaseSystemPrompt ?? '');
            const storedOrch = String(s?.iterModePromptOrchestratorOptimize ?? '');
            const storedJb = String(s?.iterModePromptJailbreakOnly ?? '');
            const custom = (Boolean(storedBase) && storedBase !== buildBaseSystemPrompt().trim())
                || (Boolean(storedOrch) && storedOrch !== buildOrchestratorOptimizeModeBlock().trim())
                || (Boolean(storedJb) && storedJb !== buildJailbreakOnlyModeBlock().trim());
            const text = buildPromptText(c, { includeRuntimeContext: false, validate: false }).join('\n\n');
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('"Iteration base prompt" in Preset Assistant settings')),
                custom,
                text,
            };
        },
        applyLaunch(launch = {}) {
            const mode = String(launch?.presetMode || '').trim();
            if (mode) state.mode = sanitizeSessionMode(mode);
        },
        renderControls({ onReload } = {}) {
            const ctx = resolveCtx();            const currentName = String(ctx?.presets?.getSelected?.('openai')?.name || '').trim();
            const allNames = listOpenAiPresetNames(ctx).filter((n) => n !== currentName);
            if (state.referenceName && !allNames.includes(state.referenceName)) {
                state.referenceName = '';
            }

            const modeSelect = select(
                [
                    { value: 'general', label: i18n('General editing') },
                    { value: 'orchestrator-optimize', label: i18n('Adapt for orchestrator') },
                    { value: 'jailbreak-only', label: i18n('Jailbreak-only') },
                ],
                state.mode,
                (v) => {
                    state.mode = sanitizeSessionMode(v);
                    onReload?.();
                },
                { ariaLabel: i18n('Editing mode'), className: 'wb-preset-mode-select' },
            );
            modeSelect.dataset.wbPresetControl = 'mode';

            const refSelect = select(
                [
                    { value: '', label: i18n('No reference preset') },
                    ...allNames.map((name) => ({ value: name, label: name })),
                ],
                state.referenceName,
                (v) => {
                    state.referenceName = String(v || '').trim();
                    onReload?.();
                },
                { ariaLabel: i18n('Compare with reference'), className: 'wb-preset-ref-select', follow: true },
            );
            refSelect.dataset.wbPresetControl = 'reference';

            return h(
                'div',
                { class: 'wb-preset-controls' },
                h('label', { class: 'wb-iter-ctrl', title: i18n('Editing mode') }, modeSelect),
                h('label', { class: 'wb-iter-ctrl', title: i18n('Compare with reference') }, refSelect),
            );
        },
        async load(_scope, ctx) {
            const c = resolveCtx(ctx);
            const snapshot = c?.presets?.getLive?.('openai');
            if (!snapshot?.ref?.name) throw new SourceError('no-preset', i18n('No chat completion preset selected'));
            if (!snapshot.body) throw new SourceError('no-preset', i18nFormat('Preset "${0}" is unreadable', snapshot.ref.name));
            const strip = c.openai?.stripPresetConnectionFields || ((b) => b);
            const live = clone(strip(snapshot.body));
            return {
                live,
                target: { scope: 'preset', ref: clone(snapshot.ref) },
                title: i18nFormat('Preset "${0}"${1}', snapshot.ref.name, snapshot.ref.origin?.kind === 'character' ? i18n(' (bound to the character card)') : ''),
            };
        },
        async prompt(_live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const parts = buildPromptText(c, { includeRuntimeContext: true });
            const mode = sanitizeSessionMode(state.mode);
            if (mode === 'orchestrator-optimize') {
                const presetName = String(c?.presets?.getSelected?.('openai')?.name || '').trim();
                const listFn = typeof c?.skills?.list === 'function'
                    ? async () => {
                        const all = await c.skills.list({ scope: 'all' });
                        return Array.isArray(all) ? all : [];
                    }
                    : null;
                const skillsBlock = await buildCpaSkillsBlock(
                    mode,
                    { presetName },
                    listFn ? { listSkillsInScope: listFn } : {},
                );
                if (skillsBlock) parts.push(skillsBlock.trim());
            }
            return parts.filter(Boolean).join('\n\n');
        },
        async tools() {
            const mode = sanitizeSessionMode(state.mode);
            return buildToolCatalog({
                hasReference: Boolean(state.referenceName),
                includeSkills: mode === 'orchestrator-optimize',
            });
        },
        isRead: (name) => PRESET_READ_TOOLS.has(String(name || '')) || isCpaSkillReadTool(name),
        async runRead(call, live) {
            const name = String(call?.name || '');
            if (isCpaSkillReadTool(name)) {
                const out = await runCpaSkillTool({
                    id: call.id,
                    name,
                    args: call.args || {},
                });
                if (!out?.ok) throw new SourceError('read', String(out?.error || i18n('Read failed')));
                return out.result;
            }
            const ctx = resolveCtx();
            const referenceName = state.referenceName;
            const reference = referenceName ? await loadReferenceBody(ctx, referenceName) : null;
            const presetName = String(ctx?.presets?.getSelected?.('openai')?.name || '').trim();
            const res = await runCpaReadTool(
                { id: call.id, name, args: call.args || {} },
                {
                    live,
                    reference,
                    referenceName,
                    presetName,
                    context: ctx,
                    getContext: () => resolveCtx(),
                },
            );
            if (res?.ok === false) {
                throw new SourceError('read', res.error || res.toolResultText || i18n('Read failed'));
            }
            return res?.toolResultText || res?.result;
        },
        async runEdit(call, live, helpers) {
            const ctx = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};

            if (name === 'preset_clone_to_new') {
                const selectedRef = ctx?.presets?.getSelected?.('openai') || null;
                const presetName = String(selectedRef?.name || '').trim();
                const out = await runCpaReadTool(
                    { id: call.id, name, args },
                    {
                        live,
                        presetName,
                        context: ctx,
                        cloneAndSwitchTarget: typeof ctx?.presets?.save === 'function'
                            ? async () => ({ ok: true })
                            : null,
                        checkPresetNameAvailable: (candidate) => {
                            const canonical = findCanonicalPresetName(listOpenAiPresetNames(ctx), candidate);
                            return canonical ? { exists: true, canonical } : { exists: false };
                        },
                    },
                );
                if (!out?.ok) {
                    throw new SourceError('clone-failed', String(out?.error || i18n('Failed to save the preset')));
                }
                if (out.pendingCloneEdit) {
                    const sourceName = String(out.pendingCloneEdit.sourceName || presetName);
                    const newName = String(out.pendingCloneEdit.newName || '');
                    const cloneOp = {
                        sourceName,
                        newName,
                        sourceRef: clone(selectedRef),
                    };
                    await helpers.propose({
                        kind: 'preset-clone',
                        target: {
                            type: 'preset',
                            sourceName,
                            newName,
                            _cloneOp: cloneOp,
                        },
                        before: { sourceName, newName, exists: false },
                        after: { sourceName, newName, exists: true },
                        meta: {
                            op: { sourceName, newName },
                            sourceName,
                            newName,
                        },
                    });
                }
                return live;
            }

            if (isCpaSkillTool(name)) {
                const out = await runCpaSkillTool({ id: call.id, name, args });
                if (!out?.ok) {
                    throw new SourceError('skill-error', String(out?.error || 'Skill tool failed'));
                }
                if (out.pendingSkillEdit) {
                    const pending = out.pendingSkillEdit;
                    const stableShape = {
                        skillName: pending.skillName || '',
                        scope: pending.scope || null,
                        path: pending.path || '',
                    };
                    await helpers.propose({
                        kind: 'skill-author',
                        target: {
                            type: 'skill-registry',
                            name: stableShape.skillName,
                            path: stableShape.path,
                            _op: pending.op,
                        },
                        before: stableShape,
                        after: stableShape,
                        meta: {
                            kind: pending.kind,
                            op: pending.op,
                            skillName: pending.skillName,
                            scope: pending.scope,
                            path: pending.path,
                            before: pending.before,
                            after: pending.after,
                            extras: pending.extras || null,
                        },
                    });
                }
                return live;
            }

            const edits = await normalizeToolCallToEdit(
                { function: { name, arguments: JSON.stringify(args) } },
                {
                    live,
                    context: ctx,
                    session: { surfaceState: { referencePresetName: state.referenceName } },
                    getReferencePresetBody: (refName) => loadReferenceBody(ctx, refName),
                },
            );
            if (!edits) throw new SourceError('bad-args', i18n('Invalid arguments'));
            return edits.length ? applyEditsTo(edits, live, ctx) : live;
        },
        units: (live) => presetUnits(live),
        rebuild: (base, ai, keys) => presetRebuild(base, ai, keys),
        async commit(targetRef, base, next, keys) {
            return commitFields({
                read() {
                    const c = resolveCtx();
                    const ref = targetRef.ref;
                    const snapshot = c?.presets?.getLive?.(ref?.collection || 'openai');
                    if (!snapshot?.body) throw new SourceError('no-preset', i18nFormat('Preset "${0}" is unreadable', ref?.name || ''));
                    if (!samePresetRef(snapshot.ref, ref)) {
                        throw new SourceError('target-gone', i18nFormat('Preset "${0}" is no longer selected, so nothing was written', ref?.name || ''));
                    }
                    return clone(snapshot.body);
                },
                units: presetUnits,
                apply: applyPresetOps,
                async write(body) {
                    const c = resolveCtx();
                    const res = await c?.presets?.save?.(targetRef.ref, body);
                    if (res?.ok !== true) throw new SourceError('write-failed', i18n('Failed to save the preset'));
                },
            }, fieldPlan(presetUnits(base), presetUnits(next), keys));
        },
    };

    return target;
}

export const presetTarget = createPresetTarget();
