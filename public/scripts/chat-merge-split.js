import { getRequestHeaders } from '../script.js';
import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { getContext } from './st-context.js';
import { openGroupChat } from './group-chats.js';
import { openCharacterChat } from '../script.js';

async function postJson(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok || !body || body.ok === false) {
        const err = new Error(`http_${res.status}`);
        err.userMessage = (body && body.error) ? body.error : t`Request failed`;
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

export async function postMergeChats({ isGroup, avatarUrl, groupId, segments, targetName }) {
    const url = isGroup ? '/api/chats/group/merge' : '/api/chats/merge';
    const payload = isGroup
        ? { id: groupId, segments, target_name: targetName }
        : { avatar_url: avatarUrl, segments, target_name: targetName };
    const body = await postJson(url, payload);
    return body.new_chat;
}

export async function postSplitChat({ isGroup, avatarUrl, groupId, sourceFileName, splitPoints, targetNames }) {
    const url = isGroup ? '/api/chats/group/split' : '/api/chats/split';
    const payload = isGroup
        ? { id: groupId, source_file_name: sourceFileName, split_points: splitPoints, target_names: targetNames }
        : { avatar_url: avatarUrl, source_file_name: sourceFileName, split_points: splitPoints, target_names: targetNames };
    const body = await postJson(url, payload);
    return body.new_chats;
}

export function emitChatMerged({ isGroup, avatarUrl, groupId, sources, target }) {
    return eventSource.emit(event_types.CHAT_MERGED, { isGroup, avatarUrl, groupId, sources, target });
}

export function emitChatSplit({ isGroup, avatarUrl, groupId, source, targets }) {
    return eventSource.emit(event_types.CHAT_SPLIT, { isGroup, avatarUrl, groupId, source, targets });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function escapeAttr(s) {
    return escapeHtml(s);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function renderRangeTrack(row) {
    const track = row.querySelector('.cms-range-track');
    if (!track) return;
    const total = Number(track.dataset.total) || 0;
    const from = Number(row.dataset.from);
    const to = Number(row.dataset.to);
    const cellCount = Math.min(total, 40); // aggregate when long
    if (cellCount === 0) {
        track.innerHTML = '';
        return;
    }
    const cellsPerMessage = cellCount / Math.max(total, 1);
    const cells = [];
    for (let c = 0; c < cellCount; c++) {
        const msgIndex = Math.floor(c / cellsPerMessage);
        const included = msgIndex >= from && msgIndex < to;
        cells.push(`<span class="cms-track-cell ${included ? 'included' : 'excluded'}"></span>`);
    }
    track.innerHTML = cells.join('');
}

function buildMergeDialogMarkup({ defaultName, segments }) {
    const rows = segments.map((seg, i) => renderSegmentRowHtml(seg, i)).join('');
    return `
        <div class="cms-dialog">
            <h3>${escapeHtml(t`Merge chats`)}</h3>
            <div class="cms-field">
                <label>${escapeHtml(t`Target name`)}</label>
                <input type="text" class="cms-target-name text_pole" value="${escapeAttr(defaultName)}" />
            </div>
            <div class="cms-segments-list">${rows}</div>
            <div class="cms-footer-bar">
                <button class="cms-add-chat menu_button" type="button">${escapeHtml(t`+ Add chat`)}</button>
                <span class="cms-total"></span>
            </div>
            <div class="cms-notice">
                <span class="cms-notice-icon">ⓘ</span>
                <span>${escapeHtml(t`The new chat contains only messages. Plugin state (memory graph, orchestrator, search-tools, etc.) does not migrate and must be regenerated.`)}</span>
            </div>
        </div>
    `;
}

async function fetchChatListForContext({ isGroup, avatarUrl, groupId }) {
    const headers = getRequestHeaders();
    if (isGroup) {
        const ctx = getContext();
        const group = (ctx.groups || []).find(g => String(g.id) === String(groupId));
        const chatIds = Array.isArray(group?.chats) ? group.chats : [];
        const results = [];
        for (const chatId of chatIds) {
            try {
                const res = await fetch('/api/chats/group/info', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ id: chatId }),
                });
                if (!res.ok) continue;
                const info = await res.json();
                if (!info || !info.file_name) continue;
                results.push({
                    file_name: String(info.file_name).replace(/\.jsonl$/i, ''),
                    messageCount: Number(info.chat_items ?? 0),
                });
            } catch { /* skip unreadable chat */ }
        }
        return results;
    }
    const res = await fetch('/api/characters/chats', {
        method: 'POST',
        headers,
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || data.error === true) return [];
    return Object.values(data).map(c => ({
        file_name: String(c.file_name || '').replace(/\.jsonl$/i, ''),
        messageCount: Number(c.mes_count ?? c.message_count ?? c.chat_items ?? 0),
    }));
}

function renumberRows(root) {
    root.querySelectorAll('.cms-segment-row').forEach((row, idx) => {
        row.dataset.index = String(idx);
        const order = row.querySelector('.cms-segment-order');
        if (order) order.textContent = String(idx + 1);
    });
}

function recomputeTotal(root) {
    let total = 0;
    root.querySelectorAll('.cms-segment-row').forEach(row => {
        const from = Number(row.dataset.from);
        const to = Number(row.dataset.to);
        total += Math.max(0, to - from);
    });
    const totalEl = root.querySelector('.cms-total');
    if (totalEl) totalEl.textContent = t`Total: ${total} messages`;
    const targetName = root.querySelector('.cms-target-name')?.value.trim() || '';
    const shouldDisable = total === 0 || targetName.length === 0;
    const okBtn = root.closest('dialog')?.querySelector('.popup-button-ok');
    if (okBtn) {
        okBtn.toggleAttribute('disabled', shouldDisable);
        okBtn.classList.toggle('cms-disabled', shouldDisable);
    }
}

function renderSegmentRowHtml(seg, idx) {
    return `
        <div class="cms-segment-row" data-index="${idx}" data-source="${escapeAttr(seg.source)}" data-from="0" data-to="${seg.totalMessages}">
            <div class="cms-segment-row-main">
                <span class="cms-drag-handle" title="${escapeAttr(t`Drag to reorder`)}">⋮⋮</span>
                <span class="cms-segment-order">${idx + 1}</span>
                <span class="cms-segment-name" title="${escapeAttr(seg.source)}">${escapeHtml(seg.source)}</span>
                <span class="cms-range-track" data-total="${seg.totalMessages}"></span>
                <span class="cms-segment-count">${seg.totalMessages}/${seg.totalMessages}</span>
                <button class="cms-remove menu_button" type="button" title="${escapeAttr(t`Remove`)}">×</button>
            </div>
            <div class="cms-segment-row-trim">
                <span>${escapeHtml(t`from`)}</span>
                <input type="number" class="cms-range-from text_pole" min="0" max="${seg.totalMessages}" value="0" />
                <span>${escapeHtml(t`to`)}</span>
                <input type="number" class="cms-range-to text_pole" min="0" max="${seg.totalMessages}" value="${seg.totalMessages}" />
                <button class="cms-use-all menu_button" type="button">${escapeHtml(t`Use all`)}</button>
            </div>
        </div>
    `;
}

function appendSegmentRow(root, seg) {
    const list = root.querySelector('.cms-segments-list');
    if (!list) return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderSegmentRowHtml(seg, list.children.length).trim();
    const row = tmp.firstElementChild;
    if (!row) return null;
    list.appendChild(row);
    renderRangeTrack(row);
    return row;
}

async function openAddChatPicker(ctx) {
    const full = await fetchChatListForContext(ctx);
    if (!full.length) {
        globalThis.toastr?.info(t`No other chats available to add.`);
        return null;
    }
    const optionsHtml = full.map(c => `
        <label class="cms-pick-row">
            <input type="radio" name="cms-pick" value="${escapeAttr(c.file_name)}" />
            <span class="cms-pick-name">${escapeHtml(c.file_name)}</span>
            <span class="cms-pick-count">(${c.messageCount})</span>
        </label>
    `).join('');
    const markup = `<div class="cms-picker"><h4>${escapeHtml(t`Add chat to merge`)}</h4>${optionsHtml}</div>`;
    let capturedName = '';
    const result = await callGenericPopup(markup, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Add`,
        cancelButton: t`Cancel`,
        onClosing: (popup) => {
            const dlg = popup?.dlg || document;
            const picked = dlg.querySelector('.cms-picker input[name="cms-pick"]:checked');
            capturedName = picked?.value || '';
            return true;
        },
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    if (!capturedName) return null;
    const meta = full.find(c => c.file_name === capturedName);
    return { source: capturedName, totalMessages: meta?.messageCount ?? 0 };
}

function bindMergeDialogBehavior(rootOverride, ctx) {
    const root = rootOverride || document.querySelector('dialog[open] .cms-dialog');
    if (!root) return;
    const list = root.querySelector('.cms-segments-list');
    // jQuery UI sortable (already loaded by ST).
    if (typeof window !== 'undefined' && window.$ && typeof window.$(list).sortable === 'function') {
        window.$(list).sortable({
            handle: '.cms-drag-handle',
            update: () => { renumberRows(root); recomputeTotal(root); },
        });
    }
    root.addEventListener('click', async (e) => {
        const removeBtn = e.target.closest('.cms-remove');
        if (removeBtn) {
            removeBtn.closest('.cms-segment-row')?.remove();
            renumberRows(root);
            recomputeTotal(root);
            return;
        }
        const useAll = e.target.closest('.cms-use-all');
        if (useAll) {
            const row = useAll.closest('.cms-segment-row');
            if (!row) return;
            const track = row.querySelector('.cms-range-track');
            const total = Number(track?.dataset.total) || 0;
            row.dataset.from = '0';
            row.dataset.to = String(total);
            const fromInput = row.querySelector('.cms-range-from');
            const toInput = row.querySelector('.cms-range-to');
            if (fromInput) fromInput.value = '0';
            if (toInput) toInput.value = String(total);
            const countEl = row.querySelector('.cms-segment-count');
            if (countEl) countEl.textContent = `${total}/${total}`;
            renderRangeTrack(row);
            recomputeTotal(root);
            return;
        }
        const addBtn = e.target.closest('.cms-add-chat');
        if (addBtn) {
            if (!ctx) return;
            const picked = await openAddChatPicker(ctx);
            if (!picked) return;
            const row = appendSegmentRow(root, picked);
            if (!row) return;
            renumberRows(root);
            recomputeTotal(root);
            return;
        }
    });
    root.addEventListener('input', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        // Target-name edits only flip the OK button enablement; no row math.
        if (target.classList.contains('cms-target-name')) {
            recomputeTotal(root);
            return;
        }
        const isFrom = target.classList.contains('cms-range-from');
        const isTo = target.classList.contains('cms-range-to');
        if (!isFrom && !isTo) return;
        const row = target.closest('.cms-segment-row');
        if (!row) return;
        const track = row.querySelector('.cms-range-track');
        const total = Number(track?.dataset.total) || 0;
        const fromInput = row.querySelector('.cms-range-from');
        const toInput = row.querySelector('.cms-range-to');
        if (!fromInput || !toInput) return;
        let from = clamp(Number(fromInput.value), 0, total);
        let to = clamp(Number(toInput.value), 0, total);
        if (from >= to) {
            if (isFrom) to = Math.min(from + 1, total);
            else from = Math.max(to - 1, 0);
            fromInput.value = String(from);
            toInput.value = String(to);
        }
        row.dataset.from = String(from);
        row.dataset.to = String(to);
        const countEl = row.querySelector('.cms-segment-count');
        if (countEl) countEl.textContent = `${to - from}/${total}`;
        renderRangeTrack(row);
        recomputeTotal(root);
    });
    root.querySelectorAll('.cms-segment-row').forEach(renderRangeTrack);
    recomputeTotal(root);
}

function readSegmentsFromDom(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-segment-row')).map(row => {
        const source = row.dataset.source;
        const from = Number(row.dataset.from);
        const to = Number(row.dataset.to);
        const countText = row.querySelector('.cms-segment-count')?.textContent || '';
        const fullLength = Number(countText.split('/')[1] || '0');
        if (from === 0 && to === fullLength) return { source };
        return { source, range: [from, to] };
    });
}

/**
 * Open the merge dialog. Returns once the popup is dismissed.
 *
 * @param {object} options
 * @param {boolean} options.isGroup - True for a group chat context, false for a character context.
 * @param {string} [options.avatarUrl] - The character's avatar URL. Required when isGroup is false.
 * @param {string} [options.groupId] - The group's id. Required when isGroup is true.
 * @param {string} [options.characterName] - The character's display name (optional, used only for naming defaults).
 * @param {string[]} [options.initialSources] - Pre-populated source chat file names (without .jsonl).
 * @returns {Promise<{openedNewChat: boolean}>}
 */
export async function openMergeDialog({ isGroup, avatarUrl, groupId, characterName, initialSources } = {}) {
    void characterName;
    const fullList = await fetchChatListForContext({ isGroup, avatarUrl, groupId });
    const lookup = new Map(fullList.map(c => [c.file_name, c]));
    const segments = (initialSources || []).map(name => ({
        source: name,
        totalMessages: lookup.get(name)?.messageCount ?? 0,
        from: 0,
        to: lookup.get(name)?.messageCount ?? 0,
    }));
    const defaultName = `merged-${new Date().toISOString().slice(0, 10)}`;

    const markup = buildMergeDialogMarkup({ defaultName, segments });
    let capturedTargetName = '';
    let capturedSegments = [];
    const result = await callGenericPopup(markup, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Merge`,
        cancelButton: t`Cancel`,
        wide: true,
        onOpen: () => bindMergeDialogBehavior(undefined, { isGroup, avatarUrl, groupId }),
        onClosing: (popup) => {
            // Capture form state BEFORE the popup DOM is torn down so the
            // post-resolution path can still read what the user entered.
            const dialog = popup?.dlg?.querySelector('.cms-dialog') || document.querySelector('.cms-dialog');
            capturedTargetName = (dialog?.querySelector('.cms-target-name')?.value || '').trim();
            capturedSegments = readSegmentsFromDom(dialog);
            return true;
        },
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return { openedNewChat: false };
    if (!capturedTargetName || capturedSegments.length === 0) return { openedNewChat: false };

    try {
        const created = await postMergeChats({ isGroup, avatarUrl, groupId, segments: capturedSegments, targetName: capturedTargetName });
        await emitChatMerged({
            isGroup,
            avatarUrl,
            groupId,
            sources: capturedSegments.map(s => s.source),
            target: created.file_name,
        });
        if (isGroup) {
            await openGroupChat(groupId, created.file_name);
        } else {
            await openCharacterChat(created.file_name);
        }
        globalThis.toastr?.success(t`Created ${created.file_name}`);
        return { openedNewChat: true };
    } catch (e) {
        globalThis.toastr?.error(e.userMessage || String(e));
        return { openedNewChat: false };
    }
}

function buildSplitDialogMarkup({ sourceFileName, totalMessages, initialPoint }) {
    return `
        <div class="cms-dialog cms-dialog-split">
            <h3>${escapeHtml(t`Split chat`)}</h3>
            <div class="cms-field">
                <span>${escapeHtml(t`Source:`)}</span>
                <strong class="cms-source-name" title="${escapeAttr(sourceFileName)}">${escapeHtml(sourceFileName)}</strong>
                <span class="cms-segment-count">(${totalMessages})</span>
            </div>
            <div class="cms-split-track-wrap">
                <div class="cms-split-track" data-total="${totalMessages}"></div>
                <div class="cms-split-points-row" data-points="${initialPoint}"></div>
            </div>
            <div class="cms-footer-bar">
                <button class="cms-add-split-point menu_button" type="button">${escapeHtml(t`+ Add point`)}</button>
            </div>
            <div class="cms-split-segments-list"></div>
            <div class="cms-notice">
                <span class="cms-notice-icon">ⓘ</span>
                <span>${escapeHtml(t`The new chat contains only messages. Plugin state (memory graph, orchestrator, search-tools, etc.) does not migrate and must be regenerated.`)}</span>
            </div>
        </div>
    `;
}

function getPointsFromDom(root) {
    const raw = root.querySelector('.cms-split-points-row')?.dataset.points || '';
    return raw.split(',').filter(Boolean).map(Number);
}

function readPointsFromInputs(root, totalMessages) {
    const pts = Array.from(root.querySelectorAll('.cms-split-point-input'))
        .map(el => clamp(Number(el.value) || 0, 1, totalMessages - 1));
    pts.sort((a, b) => a - b);
    return pts.filter((p, i, arr) => i === 0 || p !== arr[i - 1]);
}

function renderSplitSegmentsList(root, sourceFileName, totalMessages, points) {
    const segList = root.querySelector('.cms-split-segments-list');
    if (!segList) return;
    // Capture any user-typed names BEFORE the innerHTML rewrite blows them away.
    // The structural rewrite is unavoidable (segment count/ranges may have changed),
    // but we want to preserve names the user typed into still-existing segments.
    const existingNames = Array.from(segList.querySelectorAll('.cms-split-segment-name')).map(el => el.value);
    const boundaries = [0, ...points, totalMessages];
    segList.innerHTML = boundaries.slice(0, -1).map((from, i) => {
        const to = boundaries[i + 1];
        // Reuse the previous name at this index if it existed, otherwise fall
        // back to the default. New segments added beyond the prior count get
        // the default; segments that were trimmed off are simply forgotten.
        const name = existingNames[i] ?? `${sourceFileName} part ${i + 1}`;
        return `
            <div class="cms-split-segment-row" data-idx="${i}">
                <span class="cms-segment-order">${i + 1}</span>
                <input type="text" class="cms-split-segment-name text_pole" value="${escapeAttr(name)}" />
                <span class="cms-segment-count">${escapeHtml(t`msgs ${from}–${to - 1}`)} (${to - from})</span>
            </div>
        `;
    }).join('');
}

function toggleSplitOkButton(root, points) {
    const okBtn = root.closest('dialog')?.querySelector('.popup-button-ok');
    if (!okBtn) return;
    okBtn.toggleAttribute('disabled', points.length === 0);
    okBtn.classList.toggle('cms-disabled', points.length === 0);
}

function rebuildSplitUi(root, sourceFileName, totalMessages, points) {
    const pointsRow = root.querySelector('.cms-split-points-row');
    if (pointsRow) pointsRow.dataset.points = points.join(',');

    const trackEl = root.querySelector('.cms-split-track');
    if (trackEl) {
        const cellCount = Math.min(totalMessages, 60);
        const cells = [];
        for (let c = 0; c < cellCount; c++) cells.push('<span class="cms-track-cell included"></span>');
        trackEl.innerHTML = cells.join('');
    }

    if (pointsRow) {
        pointsRow.innerHTML = points.map((p, idx) => `
            <span class="cms-split-point-cell" data-idx="${idx}" style="left:${(p / totalMessages * 100).toFixed(2)}%">
                <input type="number" class="cms-split-point-input text_pole" min="1" max="${totalMessages - 1}" value="${p}" />
                <button class="cms-remove-point menu_button" type="button" title="${escapeAttr(t`Remove`)}">×</button>
            </span>
        `).join('');
    }

    renderSplitSegmentsList(root, sourceFileName, totalMessages, points);
    toggleSplitOkButton(root, points);
}

/**
 * Value-only refresh after a digit is typed into a split-point input.
 * Reuses the existing point cells (so the focused input is never destroyed)
 * and only updates the data-points attribute, cell positions, and the
 * segment list / OK button. If the number of points changed, the caller
 * must fall back to {@link rebuildSplitUi} for a structural rebuild.
 */
function refreshSplitValues(root, sourceFileName, totalMessages, points) {
    const pointsRow = root.querySelector('.cms-split-points-row');
    if (!pointsRow) return;
    pointsRow.dataset.points = points.join(',');
    const cells = pointsRow.querySelectorAll('.cms-split-point-cell');
    cells.forEach((cell, i) => {
        const p = points[i];
        if (typeof p !== 'number') return;
        cell.style.left = `${(p / totalMessages * 100).toFixed(2)}%`;
    });
    renderSplitSegmentsList(root, sourceFileName, totalMessages, points);
    toggleSplitOkButton(root, points);
}

function bindSplitDialogBehavior(sourceFileName, totalMessages) {
    const root = document.querySelector('.cms-dialog-split');
    if (!root) return;
    rebuildSplitUi(root, sourceFileName, totalMessages, getPointsFromDom(root));

    root.addEventListener('input', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.classList.contains('cms-split-point-input')) {
            const next = readPointsFromInputs(root, totalMessages);
            const existingCells = root.querySelectorAll('.cms-split-point-cell').length;
            if (next.length === existingCells) {
                // Value-only path: keeps focus on the input the user is typing in.
                refreshSplitValues(root, sourceFileName, totalMessages, next);
            } else {
                // Dedup or clamp collapsed two points; the structural rebuild is unavoidable.
                rebuildSplitUi(root, sourceFileName, totalMessages, next);
            }
        }
        // .cms-split-segment-name values are read on confirm; no rebuild needed.
    });

    root.addEventListener('click', (e) => {
        const removeBtn = e.target.closest?.('.cms-remove-point');
        if (removeBtn) {
            const cell = removeBtn.closest('.cms-split-point-cell');
            const idx = Number(cell?.dataset.idx ?? -1);
            if (idx >= 0) {
                const pts = readPointsFromInputs(root, totalMessages).filter((_, i) => i !== idx);
                rebuildSplitUi(root, sourceFileName, totalMessages, pts);
            }
            return;
        }
        if (e.target.closest?.('.cms-add-split-point')) {
            const pts = readPointsFromInputs(root, totalMessages);
            const lastBoundary = pts.length > 0 ? pts[pts.length - 1] : 0;
            const gap = totalMessages - lastBoundary;
            const next = Math.min(lastBoundary + Math.max(1, Math.floor(gap / 2)), totalMessages - 1);
            if (next > lastBoundary && next < totalMessages) {
                pts.push(next);
                pts.sort((a, b) => a - b);
                rebuildSplitUi(root, sourceFileName, totalMessages, pts);
            }
            return;
        }
    });
}

function readSplitStateFromDom(root) {
    if (!root) return { points: [], names: [] };
    const totalMessages = Number(root.querySelector('.cms-split-track')?.dataset.total) || 0;
    const points = readPointsFromInputs(root, totalMessages);
    const names = Array.from(root.querySelectorAll('.cms-split-segment-name')).map(el => el.value.trim());
    return { points, names };
}

/**
 * Open the split dialog. Returns once the popup is dismissed.
 *
 * @param {object} options
 * @param {boolean} options.isGroup - True for a group chat context, false for a character context.
 * @param {string} [options.avatarUrl] - The character's avatar URL. Required when isGroup is false.
 * @param {string} [options.groupId] - The group's id. Required when isGroup is true.
 * @param {string} options.sourceFileName - Source chat file name (without .jsonl).
 * @param {number} options.totalMessages - Number of messages in the source chat.
 * @param {number} [options.initialPoint] - Optional initial split point (defaults to the middle).
 * @returns {Promise<{createdCount: number}>}
 */
export async function openSplitDialog({ isGroup, avatarUrl, groupId, sourceFileName, totalMessages, initialPoint } = {}) {
    if (!sourceFileName || !Number.isFinite(totalMessages) || totalMessages < 2) {
        globalThis.toastr?.info(t`Chat is too short to split.`);
        return { createdCount: 0 };
    }
    const initial = clamp(Number(initialPoint) || Math.floor(totalMessages / 2), 1, totalMessages - 1);
    const markup = buildSplitDialogMarkup({ sourceFileName, totalMessages, initialPoint: initial });
    let capturedPoints = [];
    let capturedNames = [];
    const result = await callGenericPopup(markup, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Split`,
        cancelButton: t`Cancel`,
        wide: true,
        onOpen: () => bindSplitDialogBehavior(sourceFileName, totalMessages),
        onClosing: (popup) => {
            const dialog = popup?.dlg?.querySelector('.cms-dialog-split') || document.querySelector('.cms-dialog-split');
            const state = readSplitStateFromDom(dialog);
            capturedPoints = state.points;
            capturedNames = state.names;
            return true;
        },
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return { createdCount: 0 };
    if (capturedPoints.length === 0) return { createdCount: 0 };

    try {
        const created = await postSplitChat({
            isGroup,
            avatarUrl,
            groupId,
            sourceFileName,
            splitPoints: capturedPoints,
            targetNames: capturedNames,
        });
        await emitChatSplit({
            isGroup,
            avatarUrl,
            groupId,
            source: sourceFileName,
            targets: created.map(c => c.file_name),
        });
        globalThis.toastr?.success(t`Created ${created.length} new chats`);
        return { createdCount: created.length };
    } catch (e) {
        globalThis.toastr?.error(e.userMessage || String(e));
        return { createdCount: 0 };
    }
}

let entryPointsWired = false;

/**
 * Wire global click handlers for the Past Chats "Merge chats" button and per-message split icon.
 * Idempotent: repeated invocations are a no-op so callers don't have to track binding state.
 */
export function wireEntryPoints() {
    if (entryPointsWired) return;
    entryPointsWired = true;

    $(document).on('click', '#merge_chats_button', async () => {
        const ctx = getContext();
        const isGroup = Boolean(ctx.groupId);
        if (isGroup) {
            await openMergeDialog({ isGroup: true, groupId: ctx.groupId, initialSources: [] });
        } else {
            const char = ctx.characters?.[ctx.characterId];
            if (!char) return;
            await openMergeDialog({
                isGroup: false,
                avatarUrl: char.avatar,
                characterName: char.name,
                initialSources: [],
            });
        }
    });

    $(document).on('click', '.mes_split_chat', async function () {
        const mesId = $(this).closest('.mes').attr('mesid');
        if (mesId === undefined) return;
        const ctx = getContext();
        const total = ctx.chat?.length ?? 0;
        if (total <= 1) {
            globalThis.toastr?.warning(t`Need at least 2 messages to split.`);
            return;
        }
        const isGroup = Boolean(ctx.groupId);
        const sourceFileName = ctx.getCurrentChatId();
        if (!sourceFileName) return;
        const initialPoint = Math.max(1, Math.min(total - 1, Number(mesId)));
        if (isGroup) {
            await openSplitDialog({ isGroup: true, groupId: ctx.groupId, sourceFileName, totalMessages: total, initialPoint });
        } else {
            const char = ctx.characters?.[ctx.characterId];
            if (!char) return;
            await openSplitDialog({ isGroup: false, avatarUrl: char.avatar, sourceFileName, totalMessages: total, initialPoint });
        }
    });
}
