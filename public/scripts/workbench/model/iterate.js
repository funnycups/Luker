// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI iteration conversation loop and proposal lifecycle, shared by all
// workbench IterateTargets.
//
// Each round in runIterateTurn: the model may call read tools (results go back
// to it) and edit tools (applied to the AI's own working copy and/or staged as
// ProposalBus entries for non-field operations). There is no arbitrary round
// limit: the loop terminates ONLY when a round produces zero tool calls or
// signal.aborted becomes true (user Stop).

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { SourceError } from './errors.js';
import { diffUnits } from './units.js';
import {
    createProposalBus,
    profileEdit,
    lorebookWrite,
    skillAuthor,
    presetClone,
    customToolAuthor,
} from '../../iteration-library/proposal-bus/index.js';
import { registerTarget, resolveTarget } from '../../iteration-library/storage/target-registry.js';
import { applyOps } from '../../iteration-library/storage/patch-codec.js';

const cloneValue = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const BUILTIN_PROPOSAL_KINDS = {
    'profile-edit': profileEdit,
    'lorebook-write': lorebookWrite,
    'skill-author': skillAuthor,
    'preset-clone': presetClone,
    'custom-tool-author': customToolAuthor,
};

const hashString = (text) => {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
};

/** Prompt that wraps every workbench's own instructions. */
export function wrapperPrompt({ wsName, scopeText, builtin = true }) {
    if (!builtin) return '';
    return [
        `【工作台说明】你在 Luker「工作台」里帮用户修改「${wsName}」（${scopeText}）。`,
        '这是修改设定的工具任务，不是写故事；生成预设里关于文风、扮演、篇幅、格式的要求在这里不适用。',
        '你的修改只进入草稿：用户会看到逐条的改动清单，自己决定哪些要应用。不要让用户逐步确认，改完用一两句话说明改了什么、为什么。',
        '回复用户用简体中文、短句，不要提工具名、字段名和英文 id；被修改的内容本身沿用原来的语言。',
        '改动从根上改：调整规则、判断标准、结构，不要针对某一句加「不要写 X」式的补丁。改动少而准。',
    ].join('\n');
}

function normalizeProposalAdapters(proposalKinds) {
    const out = new Map();
    if (!proposalKinds) return out;
    const list = Array.isArray(proposalKinds)
        ? proposalKinds
        : Object.entries(proposalKinds).map(([kind, cfg]) => ({ ...(cfg || {}), kind: cfg?.kind || kind }));
    for (const item of list) {
        if (!item) continue;
        if (typeof item === 'string') {
            const builtin = BUILTIN_PROPOSAL_KINDS[item];
            if (builtin) out.set(item, { ...builtin });
            continue;
        }
        const kindId = String(item.kind || '').trim();
        if (!kindId) continue;
        const builtin = BUILTIN_PROPOSAL_KINDS[kindId] || {};
        out.set(kindId, { ...builtin, ...item, kind: kindId });
    }
    return out;
}

/**
 * Creates a ProposalBus pre-wired with any target-supplied proposalKinds and
 * target-registry handlers.
 */
export function createIterateBus({ proposalKinds = null, onChange = null, onCommitted = null } = {}) {
    const adapters = normalizeProposalAdapters(proposalKinds);
    const bus = createProposalBus({
        i18n: i18nFormat,
        onChange: typeof onChange === 'function' ? onChange : () => {},
        onCommitted: typeof onCommitted === 'function' ? onCommitted : null,
    });
    for (const [kindId, adapter] of adapters) {
        if (adapter.targetType && adapter.targetHandler) {
            let existingHandler = null;
            try { existingHandler = resolveTarget({ type: adapter.targetType }); } catch { existingHandler = null; }
            if (existingHandler !== adapter.targetHandler) {
                registerTarget(adapter.targetType, adapter.targetHandler);
            }
        }
        bus.registerKind(kindId, adapter);
    }
    return bus;
}

/**
 * Runs one user turn to completion (no round cap; stops only on 0 tool calls or abort).
 * @param {{
 *   messages: object[],
 *   live: any,
 *   tools: object[],
 *   isRead(name): boolean,
 *   runRead(call, live, helpers): Promise<any>,
 *   runEdit(call, live, helpers): Promise<any>,
 *   request(messages, tools): Promise<{ text, calls, reasoning? }>,
 *   bus?: object | null,
 *   proposalKinds?: Array<object | string> | Record<string, object> | null,
 *   onRound?(info),
 *   signal?: AbortSignal | null,
 * }} opts
 * @returns {Promise<{ messages, live, text: string, reads: object[], edits: object[], failed: object[], bus: object | null, proposalIds: string[] }>}
 */
export async function runIterateTurn({
    messages,
    live,
    tools,
    isRead,
    runRead,
    runEdit,
    request,
    bus = null,
    proposalKinds = null,
    targetRef = null,
    onRound = null,
    signal = null,
}) {
    const msgs = [...messages];
    let current = live;
    const reads = [];
    const edits = [];
    const failed = [];
    const toolCalls = [];
    const reasonings = [];
    const proposalIds = [];
    const activeBus = bus || (proposalKinds ? createIterateBus({ proposalKinds }) : null);
    let text = '';

    for (let round = 0; ; round++) {
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const res = await request(msgs, tools);
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        text = res?.text || text;
        const roundReasoning = typeof res?.reasoning === 'string' ? res.reasoning.trim() : '';
        if (roundReasoning) reasonings.push(roundReasoning);
        const calls = Array.isArray(res?.calls) ? res.calls : [];
        if (!calls.length) {
            if (res?.text) {
                const finalMsg = { role: 'assistant', content: res.text };
                if (roundReasoning) finalMsg.reasoning = roundReasoning;
                msgs.push(finalMsg);
            }
            break;
        }
        const assistantMsg = {
            role: 'assistant',
            content: res?.text || '',
            tool_calls: calls.map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
            })),
        };
        if (roundReasoning) assistantMsg.reasoning = roundReasoning;
        msgs.push(assistantMsg);

        for (const call of calls) {
            if (signal?.aborted) throw new Error(i18n('Stopped'));
            let content;
            let callError = null;
            try {
                const helpers = {
                    bus: activeBus,
                    sourceCallId: call.id,
                    target: targetRef,
                    signal: signal || null,
                    propose: async (input) => {
                        if (!activeBus) throw new SourceError('unsupported', 'ProposalBus is not configured for this target');
                        const out = await activeBus.propose({ sourceCallId: call.id, ...input });
                        return out;
                    },
                };
                if (isRead(call.name)) {
                    content = await runRead(call, current, helpers);
                    reads.push({ name: call.name, args: call.args });
                } else {
                    const beforeIds = activeBus
                        ? new Set(activeBus._testOnly_entries().map(e => e.id))
                        : new Set();
                    const rawOutcome = await runEdit(call, current, helpers);
                    let next = rawOutcome;
                    if (rawOutcome && typeof rawOutcome === 'object' && 'live' in rawOutcome && Array.isArray(rawOutcome.proposals)) {
                        next = rawOutcome.live;
                        for (const p of rawOutcome.proposals) {
                            await helpers.propose(p);
                        }
                    }
                    const newEntries = activeBus
                        ? activeBus._testOnly_entries().filter(e => !beforeIds.has(e.id))
                        : [];
                    for (const e of newEntries) proposalIds.push(e.id);
                    const liveChanged = next !== current && JSON.stringify(next) !== JSON.stringify(current);
                    if (!liveChanged && !newEntries.length) {
                        content = { status: 'noop', message: 'No change: the draft already matches. Re-read before retrying.' };
                    } else {
                        if (liveChanged) current = next;
                        edits.push({ name: call.name, args: call.args });
                        content = {
                            status: 'pending_review',
                            message: 'Applied to the draft. The user will review the change list and decide.',
                            ...(newEntries.length ? { proposalIds: newEntries.map(e => e.id) } : {}),
                        };
                    }
                }
            } catch (err) {
                callError = String(err?.message || err);
                failed.push({ name: call.name, error: callError });
                content = (err?.envelope && typeof err.envelope === 'object')
                    ? err.envelope
                    : { error: callError };
            }
            toolCalls.push({
                id: call.id,
                name: call.name,
                args: cloneValue(call.args ?? {}),
                ...(callError != null ? { error: callError } : { result: cloneValue(content) }),
            });
            msgs.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof content === 'string' ? content : JSON.stringify(content),
            });
        }
        onRound?.({
            round,
            reads: reads.length,
            edits: edits.length,
            proposals: proposalIds.length,
            live: current,
        });
    }

    return {
        messages: msgs,
        live: current,
        text,
        reasoning: reasonings.join('\n\n'),
        reads,
        edits,
        failed,
        toolCalls,
        bus: activeBus,
        proposalIds,
    };
}

function formatTextValue(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val, null, 2);
}

function describeProposalTarget(entry) {
    const t = entry?.target;
    if (!t || typeof t !== 'object') return '';
    if (t.name) return String(t.name);
    if (t.newName && t.sourceName) return `${t.sourceName} → ${t.newName}`;
    if (t.bookName && t.uid != null) return `${t.bookName}#${t.uid}`;
    return String(t.type || '');
}

function deriveProposalChangeKind(entry, adapter) {
    if (typeof adapter?.changeKind === 'function') return adapter.changeKind(entry);
    const metaKind = String(entry?.meta?.kind || entry?.op?.name || '').toLowerCase();
    if (metaKind.includes('create') || metaKind.includes('add') || entry?.kind === 'preset-clone') return 'add';
    if (metaKind.includes('delete') || metaKind.includes('remove')) return 'remove';
    if (entry?.meta?.before == null && entry?.meta?.after != null) return 'add';
    if (entry?.meta?.before != null && entry?.meta?.after == null) return 'remove';
    return 'change';
}

function resolveBeforeText(entry, adapter) {
    if (typeof adapter?.beforeText === 'function') return String(adapter.beforeText(entry) ?? '');
    if (entry?.kind === 'preset-clone') {
        const src = String(entry?.op?.sourceName || entry?.target?.sourceName || '');
        return src;
    }
    if (entry?.meta && 'before' in entry.meta) return formatTextValue(entry.meta.before);
    if (entry?._pendingAfter !== undefined && Array.isArray(entry?.inverse)) {
        try {
            const prev = applyOps(entry._pendingAfter, entry.inverse, {
                targetType: entry?.target?.type || 'unknown',
                targetName: entry?.target?.name || null,
            });
            return formatTextValue(prev);
        } catch { /* fall through */ }
    }
    return '';
}

function resolveAfterText(entry, adapter) {
    if (typeof adapter?.afterText === 'function') return String(adapter.afterText(entry) ?? '');
    if (entry?.kind === 'preset-clone') {
        const src = String(entry?.op?.sourceName || entry?.target?.sourceName || '');
        const dst = String(entry?.op?.newName || entry?.target?.newName || '');
        const summary = src && dst
            ? i18nFormat('Fork "${0}" into "${1}"', src, dst)
            : i18n('Fork current preset into a new preset');
        return `${summary}\n${i18n('Cannot be auto-rolled back after applying')}`;
    }
    if (entry?.meta && 'after' in entry.meta) return formatTextValue(entry.meta.after);
    if (entry?._pendingAfter !== undefined) return formatTextValue(entry._pendingAfter);
    return '';
}

/** Converts one ProposalBus entry into a change-list item for preview/selection. */
export function proposalToChange(entry, adapter = null) {
    const before = resolveBeforeText(entry, adapter);
    const after = resolveAfterText(entry, adapter);
    const inverseAvailable = adapter?.inverseAvailable !== false && entry?.kind !== 'preset-clone';
    return {
        key: `proposal:${entry.id}`,
        proposalId: entry.id,
        proposalKind: entry.kind,
        kind: deriveProposalChangeKind(entry, adapter),
        label: String(adapter?.label?.(entry) || entry?.meta?.label || entry?.meta?.skillName || entry?.meta?.name || describeProposalTarget(entry) || entry.kind),
        group: String(adapter?.group?.(entry) || describeProposalTarget(entry) || entry.kind),
        before,
        after,
        inverseAvailable,
        note: inverseAvailable ? '' : i18n('Cannot be auto-rolled back after applying'),
        sig: hashString(`${entry.kind}\0${entry.id}\0${before}\0${after}`),
    };
}

/**
 * Builds the unified change list for a turn from both field-diff units and
 * ProposalBus entries.
 */
export function buildTurnChanges({ base, ai, units = null, bus = null, proposalIds = null, kindAdapters = null, targetRef = null }) {
    const fieldChanges = typeof units === 'function'
        ? diffUnits(units(base, targetRef), units(ai, targetRef)).map(c => ({ ...c, proposalKind: 'field-diff', inverseAvailable: true }))
        : [];
    if (!bus) return fieldChanges;
    const adapters = normalizeProposalAdapters(kindAdapters);
    const wanted = Array.isArray(proposalIds) ? new Set(proposalIds) : null;
    const entries = bus._testOnly_entries().filter(e =>
        (e.status === 'pending' || e.status === 'conflict') && (!wanted || wanted.has(e.id)));
    const busChanges = entries.map(e => proposalToChange(e, adapters.get(e.kind) || null));
    return [...fieldChanges, ...busChanges];
}

/**
 * Selectively commits accepted field-diff keys and ProposalBus proposals.
 * Rolls back field edits and any earlier committed bus entries if any
 * ProposalBus approval fails.
 */
export async function commitTurnBatch({
    target,
    targetRef,
    base,
    ai,
    keys = [],
    bus = null,
    proposalIds = [],
    kindAdapters = null,
}) {
    const adapters = normalizeProposalAdapters(kindAdapters || target?.proposalKinds);
    const fieldKeys = [];
    const selectedBusIds = [];
    for (const k of keys) {
        if (String(k).startsWith('proposal:')) selectedBusIds.push(String(k).slice('proposal:'.length));
        else fieldKeys.push(k);
    }

    let fieldHandle = null;
    if (fieldKeys.length) {
        const next = target.rebuild(base, ai, fieldKeys, targetRef);
        fieldHandle = await target.commit(targetRef, base, next, fieldKeys);
    }

    const entriesById = new Map((bus?._testOnly_entries?.() || []).map(e => [e.id, e]));
    // Execute rollbackable bus proposals before non-rollbackable ones (e.g. preset-clone)
    // so a failure never strands an un-rollbackable side effect on disk.
    const orderedBusIds = [...selectedBusIds].sort((a, b) => {
        const ea = entriesById.get(a);
        const eb = entriesById.get(b);
        const ra = ea && adapters.get(ea.kind)?.inverseAvailable !== false && ea.kind !== 'preset-clone' ? 0 : 1;
        const rb = eb && adapters.get(eb.kind)?.inverseAvailable !== false && eb.kind !== 'preset-clone' ? 0 : 1;
        return ra - rb;
    });

    const committedBus = [];
    try {
        for (const busId of orderedBusIds) {
            if (!bus) throw new SourceError('unsupported', 'ProposalBus is required to commit proposal entries');
            const entry = entriesById.get(busId);
            const res = await bus.approve(busId);
            if (!res?.ok) {
                throw new SourceError('commit-failed', res?.error || res?.hint || i18n('Proposal commit failed'));
            }
            const inverseAvailable = entry
                ? (adapters.get(entry.kind)?.inverseAvailable !== false && entry.kind !== 'preset-clone')
                : true;
            committedBus.push({ id: busId, key: `proposal:${busId}`, inverseAvailable });
        }
    } catch (err) {
        const rollbackErrors = [];
        for (const item of [...committedBus].reverse()) {
            if (!item.inverseAvailable) continue;
            try {
                const rb = await bus.rollback(item.id);
                if (!rb?.ok) rollbackErrors.push(rb?.error || rb?.hint || item.id);
            } catch (rbErr) {
                rollbackErrors.push(String(rbErr?.message || rbErr));
            }
        }
        if (fieldHandle?.applied?.length) {
            try {
                await fieldHandle.undo();
            } catch (undoErr) {
                rollbackErrors.push(String(undoErr?.message || undoErr));
            }
        }
        if (rollbackErrors.length) {
            throw new SourceError('rollback-failed', `${err?.message || err} (${rollbackErrors.join('; ')})`);
        }
        throw err;
    }

    // Reject unselected pending bus entries from this turn only after selected writes succeed.
    if (bus) {
        const selectedSet = new Set(selectedBusIds);
        const turnSet = new Set(proposalIds);
        for (const entry of bus._testOnly_entries()) {
            if (entry.status === 'pending' && (!proposalIds.length || turnSet.has(entry.id)) && !selectedSet.has(entry.id)) {
                bus.reject(entry.id);
            }
        }
    }

    const applied = [...(fieldHandle?.applied || []), ...committedBus.map(b => b.key)];
    const skipped = [...(fieldHandle?.skipped || [])];
    const failure = fieldHandle?.failure || '';
    const nonRollbackable = committedBus.some(b => !b.inverseAvailable);

    return {
        applied,
        skipped,
        failure,
        nonRollbackable,
        async undo() {
            const errors = [];
            for (const item of [...committedBus].reverse()) {
                if (!item.inverseAvailable) continue;
                const rb = await bus.rollback(item.id);
                if (!rb?.ok) errors.push(rb?.error || rb?.hint || item.id);
            }
            if (fieldHandle?.applied?.length) {
                await fieldHandle.undo();
            }
            if (errors.length) {
                throw new SourceError('rollback-failed', errors.join(', '));
            }
        },
    };
}

/**
 * After the user decides, tell the model what happened (so it does not redo
 * rejected changes): appended as a short user note on the next turn.
 */
export function decisionNote({ applied = [], discarded = [], unsaved = [], busOutcomes = [] }) {
    if (!applied.length && !discarded.length && !unsaved.length && !busOutcomes.length) return '';
    const parts = [];
    if (applied.length) parts.push(`用户应用了：${applied.join(listSeparator())}`);
    if (discarded.length) parts.push(`用户没要：${discarded.join(listSeparator())}（不要再提同样的改法，除非用户要求）`);
    if (unsaved.length) parts.push(`用户批准了但没保存成功：${unsaved.join(listSeparator())}（内容已被别处改动或写入失败，要改请先重新读取）`);
    const conflicts = (busOutcomes || []).filter(o => o?.status === 'conflict');
    if (conflicts.length) {
        parts.push(`冲突未写入：${conflicts.map(o => `${o.target || o.kind}（${o.hint || o.error || 'changed elsewhere'}）`).join(listSeparator())}`);
    }
    if (!parts.length) return '';
    return `（上一轮的改动：${parts.join('；')}。没要的部分已从草稿里撤回。）`;
}

/**
 * Keeps system messages and strips orphan leading tool results. When a finite
 * `maxChars` budget is explicitly provided, drops oldest non-system messages
 * beyond the budget; otherwise preserves the full history without truncation.
 */
export function trimMessages(messages, maxChars = Infinity) {
    const list = Array.isArray(messages) ? messages : [];
    const sys = list.filter(m => m.role === 'system');
    const rest = list.filter(m => m.role !== 'system');
    let kept;
    if (!Number.isFinite(maxChars)) {
        kept = [...rest];
    } else {
        let total = 0;
        kept = [];
        for (let i = rest.length - 1; i >= 0; i--) {
            total += String(rest[i].content || '').length + JSON.stringify(rest[i].tool_calls || '').length;
            if (total > maxChars && kept.length > 4) break;
            kept.unshift(rest[i]);
        }
    }
    // Never start on a tool result without its call.
    while (kept.length && kept[0].role === 'tool') kept.shift();
    return [...sys, ...kept];
}
