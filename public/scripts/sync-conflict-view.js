/**
 * Structured diff panels of a sync conflict: a change tree of two recorded
 * versions, with each value fetched only when its field opens.
 *
 * The Data window owns the conflict cards and version choices; this module
 * mounts the diff panels inside a card.
 */

import { getRequestHeaders } from '../script.js';
import { t, translate } from './i18n.js';

const ENDPOINTS = {
    diff: '/api/sync/v1/conflicts/diff',
    value: '/api/sync/v1/conflicts/value',
};

const DIFF_AUTO_OPEN_CHANGES = 50; // cap-ok: the conflict panel opens by itself only when the file has at most 50 change leaves; a larger tree waits for one click
const SECTION_AUTO_OPEN = 8; // cap-ok: a section opens by itself only when it has at most 8 direct changes; more rows would push the rest of the card off a phone viewport

const KIND_LABELS = {
    preset: () => t`Preset`,
    worldbook: () => t`World book`,
    character: () => t`Character card`,
    chat: () => t`Chat`,
    secrets: () => t`Secrets`,
    settings: () => t`Settings`,
    json: () => t`JSON`,
    text: () => t`Text`,
    image: () => t`Image`,
    binary: () => t`File`,
};

const STATUS_LABELS = {
    added: () => t`Added`,
    removed: () => t`Removed`,
    changed: () => t`Changed`,
    moved: () => t`Moved`,
};

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function kindLabel(kind) {
    return (KIND_LABELS[kind] ?? KIND_LABELS.json)();
}

function nodeLabel(node) {
    const label = node.translateLabel ? translate(node.label) : node.label;
    return node.meta?.characterId ? `${label} ${node.meta.characterId}` : label;
}

function statusBadge(status) {
    const label = STATUS_LABELS[status];
    return label ? element('span', `syncDiffBadge syncDiffBadge-${status}`, label()) : null;
}

/** Decimal units match the size labels users see for files. */
function formatSize(bytes) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

function truncationNote(bytes) {
    return element('div', 'syncConflictDiffTruncated menu_button_note', t`Truncated, ${formatSize(bytes)} total.`);
}

function diffSummaryText(diff, label) {
    if (diff.identical) return t`No differences`;
    if (diff.deleted) return t`Deleted`;
    if (diff.unreadable) return t`Could not compare`;
    const prefix = label ?? kindLabel(diff.kind);
    const sections = (diff.sections ?? []).filter(section => section.meta.changed > 0);
    if (sections.length > 0) {
        return `${prefix} · ${sections.map(section => `${nodeLabel(section)} ${section.meta.changed}`).join(' · ')}`;
    }
    if (diff.imageDiffers) return `${prefix} · ${t`Image changed`}`;
    return prefix;
}

/**
 * Limits how many diffs the window asks for at once. A first join can list
 * many files, and the diff route parses both versions on the server.
 *
 * @param {number} limit
 */
function createTaskQueue(limit) {
    const pending = [];
    let running = 0;
    let closed = false;
    const start = () => {
        while (!closed && running < limit && pending.length > 0) {
            const task = pending.shift();
            running += 1;
            Promise.resolve()
                .then(task.run)
                .then(task.resolve, task.reject)
                .finally(() => {
                    running -= 1;
                    start();
                });
        }
    };
    return {
        add(run) {
            if (closed) return Promise.resolve(null);
            return new Promise((resolve, reject) => {
                pending.push({ run, resolve, reject });
                start();
            });
        },
        close() {
            closed = true;
            for (const task of pending.splice(0)) task.resolve(null);
        },
    };
}

/** A queue shared by the conflict cards of one window. */
export function createConflictDiffQueue(limit = 2) {
    return createTaskQueue(limit);
}

function diffUrl(entry) {
    const params = new URLSearchParams({
        backendId: entry.backendId,
        path: entry.path,
        ours: entry.ours ?? '',
        theirs: entry.theirs ?? '',
    });
    return `${ENDPOINTS.diff}?${params.toString()}`;
}

async function requestConflictDiff(entry) {
    const response = await fetch(diffUrl(entry), { headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function valueUrl(entry, nodeId, offset) {
    const params = new URLSearchParams({
        backendId: entry.backendId,
        path: entry.path,
        ours: entry.ours ?? '',
        theirs: entry.theirs ?? '',
        nodeId: String(nodeId),
        offset: String(offset),
    });
    return `${ENDPOINTS.value}?${params.toString()}`;
}

async function requestConflictValue(entry, nodeId, offset) {
    const response = await fetch(valueUrl(entry, nodeId, offset), { headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function loadMoreButton(className, label, onClick) {
    const button = element('button', `menu_button ${className}`, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
}

function lineRowNode(row) {
    const line = element('div', 'syncDiffLine');
    line.dataset.kind = row.kind;
    line.append(
        element('span', 'syncDiffLineNo', row.leftLine ?? ''),
        element('span', 'syncDiffLineNo', row.rightLine ?? ''),
        element('pre', 'syncDiffLineText', row.text),
    );
    if (row.truncated) line.append(truncationNote(row.bytes));
    return line;
}

function drawValuePage(state, body, ctx, load) {
    if (state.mode === 'cells') {
        const values = element('div', 'syncDiffValues');
        const sides = [
            { side: ctx.sides[0], title: ctx.leftTitle, cell: state.before },
            { side: ctx.sides[1], title: ctx.rightTitle, cell: state.after },
        ];
        for (const { side, title, cell } of sides) {
            if (!cell || cell.missing) continue;
            const block = element('div', 'syncDiffValue');
            block.dataset.side = side;
            block.append(element('div', 'syncDiffValueTitle', title));
            block.append(element('pre', 'syncDiffValueText', cell.text));
            values.append(block);
        }
        body.replaceChildren(values);
        if (state.nextOffset !== null) {
            const total = Math.max(state.before?.bytes ?? 0, state.after?.bytes ?? 0);
            body.append(truncationNote(total));
            body.append(loadMoreButton('syncDiffLoadMore', t`Load more`, () => load(state.nextOffset, true)));
        }
        return;
    }
    const lines = element('div', 'syncDiffLines');
    for (const row of state.rows) lines.append(lineRowNode(row));
    body.replaceChildren(lines);
    if (state.nextOffset !== null) {
        body.append(loadMoreButton('syncDiffLoadMoreLines', t`Load more lines`, () => load(state.nextOffset, true)));
    }
}

function renderField(node, ctx) {
    const details = element('details', 'syncDiffField');
    details.dataset.status = node.status;
    details.dataset.nodeId = String(node.id);
    const summary = element('summary', 'syncDiffNodeSummary syncDiffFieldSummary');
    const range = node.meta?.lines
        ? (node.meta.lines.from === node.meta.lines.to
            ? t`Line ${node.meta.lines.from}`
            : t`Lines ${node.meta.lines.from}–${node.meta.lines.to}`)
        : null;
    summary.append(element('span', 'syncDiffNodeLabel', range ?? nodeLabel(node)));
    const badge = statusBadge(node.status);
    if (badge) summary.append(badge);
    const body = element('div', 'syncDiffFieldBody');
    details.append(summary, body);

    const state = { mode: null, before: null, after: null, rows: [], nextOffset: null };
    let started = false;
    let loading = false;
    const load = async (offset, append) => {
        if (loading) return;
        loading = true;
        if (!append) body.replaceChildren(element('div', 'syncDiffLoading', t`Loading…`));
        try {
            const page = await ctx.queue.add(() => requestConflictValue(ctx.entry, node.id, offset));
            if (!page) return;
            if (page.mode === 'cells') {
                state.mode = 'cells';
                if (append) {
                    state.before.text += page.before.text;
                    state.after.text += page.after.text;
                    state.before.chars = page.before.chars;
                    state.before.bytes = page.before.bytes;
                    state.before.missing = page.before.missing;
                    state.after.chars = page.after.chars;
                    state.after.bytes = page.after.bytes;
                    state.after.missing = page.after.missing;
                } else {
                    state.before = { ...page.before };
                    state.after = { ...page.after };
                }
                state.nextOffset = page.nextOffset;
            } else {
                state.mode = 'lines';
                state.rows.push(...page.rows);
                state.nextOffset = page.nextOffset;
            }
            drawValuePage(state, body, ctx, load);
        } catch (error) {
            if (!append) body.replaceChildren();
            body.append(element('div', 'syncDiffError', String(error?.message || error)));
            body.append(loadMoreButton('syncDiffRetry', t`Retry`, () => load(offset, append)));
        } finally {
            loading = false;
        }
    };
    details.addEventListener('toggle', () => {
        if (!details.open || started) return;
        started = true;
        load(0, false);
    });
    return details;
}

function summaryNode(node, isSection) {
    const summary = element(isSection || (node.children ?? []).length > 0 ? 'summary' : 'div', 'syncDiffNodeSummary');
    summary.append(element('span', 'syncDiffNodeLabel', nodeLabel(node)));
    if (!isSection) {
        const badge = statusBadge(node.status);
        if (badge) summary.append(badge);
        if (node.meta?.move) {
            summary.append(element('span', 'syncDiffMove', t`Position ${node.meta.move.from} → ${node.meta.move.to}`));
        }
        if (node.meta?.changed > 1) {
            summary.append(element('span', 'syncDiffCount', t`${node.meta.changed} fields`));
        }
    } else if (node.meta?.changed > 0) {
        summary.append(element('span', 'syncDiffCount', String(node.meta.changed)));
    }
    return summary;
}

function renderBranch(node, ctx) {
    const isSection = node.type === 'section';
    const hasChildren = (node.children ?? []).length > 0;
    if (!isSection && !hasChildren) {
        const row = element('div', 'syncDiffItem syncDiffItemLeaf');
        row.dataset.status = node.status;
        row.append(summaryNode(node, false));
        return row;
    }

    const details = element('details', isSection ? 'syncDiffSection' : 'syncDiffItem');
    details.dataset.status = node.status;
    details.dataset.nodeId = String(node.id);
    const summary = summaryNode(node, isSection);
    const body = element('div', isSection ? 'syncDiffSectionBody' : 'syncDiffItemBody');
    details.append(summary, body);

    let rendered = false;
    const render = () => {
        if (rendered) return;
        rendered = true;
        for (const child of node.children ?? []) body.append(renderViewNode(child, ctx));
    };
    details.addEventListener('toggle', () => {
        if (details.open) render();
    });
    if (isSection && (node.meta?.changed ?? 0) <= SECTION_AUTO_OPEN) {
        details.open = true;
        render();
    }
    return details;
}

function renderViewNode(node, ctx) {
    return node.type === 'field' ? renderField(node, ctx) : renderBranch(node, ctx);
}

async function diffBodyNodes(diff, entry, ctx) {
    const nodes = [];
    if (diff.identical) nodes.push(element('div', 'syncConflictDiffNote', t`The versions are identical.`));
    if (diff.deleted) nodes.push(element('div', 'syncConflictDiffNote', t`This file exists only in the other version.`));
    if (diff.unreadable) nodes.push(element('div', 'syncConflictDiffNote', t`The secret file could not be compared.`));
    if (diff.kind === 'binary') {
        nodes.push(element('div', 'syncConflictDiffNote', t`Binary file, ${diff.leftSize} bytes → ${diff.rightSize} bytes.`));
    }
    if (diff.imageDiffers && ctx.previewUrl) {
        const images = element('div', 'syncConflictDiffImages flex-container flexGap10');
        for (const [oid, title] of [[entry.ours, ctx.leftTitle], [entry.theirs, ctx.rightTitle]]) {
            const url = oid === null || oid === undefined ? null : await ctx.previewUrl(oid);
            if (url === null) continue;
            const figure = element('figure', 'syncConflictDiffImage');
            const image = element('img');
            image.src = url;
            figure.append(image, element('figcaption', 'menu_button_note', title));
            images.append(figure);
        }
        if (images.childElementCount > 0) nodes.push(images);
    }
    if ((diff.sections ?? []).length > 0) {
        const tree = element('div', 'syncDiffTree');
        for (const section of diff.sections) tree.append(renderViewNode(section, ctx));
        nodes.push(tree);
    }
    if (nodes.length === 0) nodes.push(element('div', 'syncConflictDiffNote', t`No visible differences.`));
    return nodes;
}

function renderDiffPanel(entry, queue, previewUrl, {
    label = null,
    leftTitle = t`Version from ${entry.oursDevice}`,
    rightTitle = t`Version from ${entry.theirsDevice}`,
    sides = ['ours', 'theirs'],
} = {}) {
    const details = element('details', 'syncConflictDiff');
    const summary = element('summary', 'syncConflictDiffSummary', label ?? t`Differences`);
    const body = element('div', 'syncConflictDiffBody');
    details.append(summary, body);
    const ctx = { entry, leftTitle, rightTitle, sides, queue, previewUrl };
    let diff = null;
    let loading = false;
    let drawn = false;
    const draw = async () => {
        if (!diff || drawn) return;
        drawn = true;
        body.replaceChildren();
        try {
            const nodes = await diffBodyNodes(diff, entry, ctx);
            body.append(...nodes);
        } catch (error) {
            body.replaceChildren(element('div', 'syncConflictDiffError', String(error?.message || error)));
        }
    };
    const load = async () => {
        if (diff || loading) return;
        loading = true;
        summary.textContent = t`Comparing versions…`;
        try {
            diff = await queue.add(() => requestConflictDiff(entry));
            if (!diff) return;
            summary.textContent = diffSummaryText(diff, label);
            if (details.open || diff.totalChanges <= DIFF_AUTO_OPEN_CHANGES) {
                details.open = true;
                draw();
            }
        } catch (error) {
            summary.textContent = t`Could not compare versions`;
            body.replaceChildren(element('div', 'syncConflictDiffError', String(error?.message || error)));
            details.open = true;
            drawn = true;
        } finally {
            loading = false;
        }
    };
    details.addEventListener('toggle', () => {
        if (details.open) {
            if (diff) draw();
            else load();
        }
    });
    load();
    return details;
}

/**
 * Build the diff panels of one conflict, ready to mount in its card.
 *
 * @param {object} review Conflict review fields: backendId, path, ours, theirs, current, kept, oursDevice, theirsDevice, stale
 * @param {ReturnType<typeof createConflictDiffQueue>} queue
 * @param {(oid: string) => Promise<string | null>} [previewUrl] Object URL of one version's image
 * @returns {HTMLElement} Container holding the panels; re-appending keeps expansion and loaded values
 */
export function createConflictDiffPanels(review, queue, previewUrl = null) {
    const group = element('div', 'syncConflictDiffGroup');
    group.append(renderDiffPanel(review, queue, previewUrl));
    if (review.stale && review.current !== null && review.current !== review.ours && review.current !== review.theirs) {
        const keptTitle = review.kept === review.ours
            ? t`Version from ${review.oursDevice}`
            : review.kept === review.theirs
                ? t`Version from ${review.theirsDevice}`
                : t`Version when the conflict was found`;
        group.append(renderDiffPanel(
            { ...review, ours: review.current, theirs: review.kept },
            queue,
            previewUrl,
            {
                label: t`Current version changes`,
                leftTitle: t`Current version`,
                rightTitle: keptTitle,
                sides: ['current', 'kept'],
            },
        ));
    }
    return group;
}
