/**
 * Popup for what sync left for the user to decide: pending file conflicts,
 * chat conflict branches and restored chats, and files sync cannot update.
 * Opens on page load while anything is pending, and again when a status
 * check finds something not shown yet.
 */
import { characters, getCharacters, getRequestHeaders, openCharacterChat, selectCharacterById } from '../script.js';
import { eventSource, event_types } from './events.js';
import { getGroups, groups, openGroupById, openGroupChat, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { initializeSyncActivity } from './sync-activity.js';

const ENDPOINTS = {
    status: '/api/sync/v1/status',
    blob: (backendId, oid) => `/api/sync/v1/blob/${encodeURIComponent(backendId)}/${encodeURIComponent(oid)}`,
    resolve: '/api/sync/v1/conflicts/resolve',
    dismiss: '/api/sync/v1/notices/dismiss',
};

// The status call is local; the interval only bounds how fast a popup
// appears for conflicts found by a background sync.
const STATUS_POLL_MS = 30_000;
const ACTIVE_STATUS_POLL_MS = 5000;
let pollTimer = null;
let activityRunning = false;

const TEXT_EXTENSIONS = ['.json', '.jsonl', '.txt', '.md', '.yaml', '.yml', '.css', '.js'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const shownKeys = new Set();
let popupOpen = false;
/** Updates the open popup with a newer status; null while no popup is open. */
let refreshOpenPopup = null;
let failOpenPopup = null;
let statusReadFailed = false;
let checks = 0;
let statusVersion = 0;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function stalledPathsOf(status) {
    const paths = new Set();
    for (const backend of Object.values(status.backends ?? {})) {
        for (const relPath of backend.lastSync?.stalled ?? []) paths.add(relPath);
    }
    return [...paths].sort();
}

/** Key of a pending conflict; a conflict recorded again gets a new key. */
export const conflictKey = entry => `c:${entry.path}:${entry.createdAt}`;
/** Key of a pending notice. */
export const noticeKey = notice => `n:${notice.path}`;

function pendingKeys(status) {
    return [
        ...status.conflicts.map(conflictKey),
        ...status.notices.map(noticeKey),
        ...Object.entries(status.backends ?? {}).flatMap(([id, b]) => (b.lastSync?.stalled ?? []).map(p => `s:${id}:${p}`)),
    ];
}

/**
 * Blobs and object URLs of one popup, by backend and oid, so cards that
 * show the same version share one download.
 */
export function createPreviewCache() {
    const blobs = new Map();
    const urls = new Map();
    let revoked = false;
    return {
        blob(backendId, oid) {
            const key = `${backendId}:${oid}`;
            if (!blobs.has(key)) {
                blobs.set(key, fetch(ENDPOINTS.blob(backendId, oid), { headers: getRequestHeaders() }).then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.blob();
                }));
            }
            return blobs.get(key);
        },
        async url(backendId, oid) {
            const key = `${backendId}:${oid}`;
            const blob = await this.blob(backendId, oid);
            // A download that finishes after the popup closed gets no URL, which nothing would revoke.
            if (revoked) return null;
            if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
            return urls.get(key);
        },
        revoke() {
            revoked = true;
            for (const url of urls.values()) URL.revokeObjectURL(url);
        },
    };
}

/**
 * Load one version of a conflicting file for preview. Text and image files
 * are told apart by the extension of the path.
 *
 * @param {ReturnType<typeof createPreviewCache>} previews
 * @param {{ backendId: string, oid: string | null, path: string }} version
 * @returns {Promise<{ kind: 'deleted' } | { kind: 'text', text: string } | { kind: 'image', url: string } | { kind: 'binary', bytes: number } | null>}
 * Null when the cache was revoked before an image finished downloading.
 */
export async function loadSyncPreview(previews, { backendId, oid, path }) {
    if (oid === null) return { kind: 'deleted' };
    const blob = await previews.blob(backendId, oid);
    const lower = path.toLowerCase();
    if (TEXT_EXTENSIONS.some(ext => lower.endsWith(ext))) return { kind: 'text', text: await blob.text() };
    if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        const url = await previews.url(backendId, oid);
        return url === null ? null : { kind: 'image', url };
    }
    return { kind: 'binary', bytes: blob.size };
}

async function fillPreview(preview, version, previews) {
    const shown = await loadSyncPreview(previews, version);
    if (shown === null) return;
    if (shown.kind === 'deleted') {
        preview.append(element('span', '', t`Deleted`));
    } else if (shown.kind === 'text') {
        const text = element('pre', 'syncConflictText', shown.text);
        Object.assign(text.style, { maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
        preview.append(text);
    } else if (shown.kind === 'image') {
        const image = element('img', 'syncConflictImage');
        image.style.maxWidth = '100%';
        image.src = shown.url;
        preview.append(image);
    } else {
        preview.append(element('span', '', t`Binary file, ${shown.bytes} bytes`));
    }
}

function renderCard({ entry, index, choice, title, oid, inUse, previews }) {
    const card = element('label', 'syncConflictCard flex-container flexFlowColumn flexNoGap');
    card.dataset.choice = choice;
    card.style.flex = '1 1 0';
    card.style.minWidth = '0';
    const radio = element('input');
    radio.type = 'radio';
    radio.name = `syncConflict-${index}`;
    radio.value = choice;
    const heading = element('div', 'syncConflictCardTitle', title);
    if (inUse) heading.append(element('span', 'syncConflictInUse', ` ${t`In use`}`));
    const pick = element('span', 'flex-container flexGap5');
    pick.append(radio, element('span', '', choice === 'current' ? t`Keep the current version` : t`Use this version`));
    const preview = element('div', 'syncConflictPreview');
    card.append(heading, pick, preview);
    fillPreview(preview, { backendId: entry.backendId, oid, path: entry.path }, previews)
        .catch(error => preview.append(element('span', '', String(error?.message || error))));
    return card;
}

/** Mark a conflict row another device resolved and disable its choices. */
function markResolvedElsewhere(row) {
    if (row.classList.contains('syncConflictResolved')) return;
    row.classList.add('syncConflictResolved');
    for (const radio of row.querySelectorAll('input[type=radio]')) {
        radio.checked = false;
        radio.disabled = true;
    }
    row.querySelector('.syncConflictPath')?.after(element('div', 'syncConflictResolvedNote menu_button_note', t`Resolved on another device.`));
}

export function reportingBackends(entry) {
    return [...new Set([...(entry?.backends ?? []), ...Object.keys(entry?.recordVersions ?? {}), entry?.backendId].filter(Boolean))];
}

/** True when a backend that reports the entry has pending records that could not be read. */
export function recordUnknown(entry, status) {
    return !status || reportingBackends(entry).some(id => status.errors?.[id] || status.backends?.[id]?.pendingError);
}

function markUnknown(row, preserveSelection = false) {
    row.classList.remove('syncConflictResolved');
    row.querySelector('.syncConflictResolvedNote')?.remove();
    row.classList.add('syncConflictUnknown');
    for (const radio of row.querySelectorAll('input[type=radio]')) {
        if (!preserveSelection) radio.checked = false;
        radio.disabled = true;
    }
    if (!row.querySelector('.syncConflictUnknownNote')) row.querySelector('.syncConflictPath')?.after(element('div', 'syncConflictUnknownNote menu_button_note', t`Pending records could not be read. This choice is unknown until the backend recovers.`));
}

function renderConflictRow(entry, index, previews) {
    const row = element('div', 'syncConflictRow flex-container flexFlowColumn flexGap5');
    row.dataset.path = entry.path;
    row.dataset.key = conflictKey(entry);
    row.append(element('div', 'syncConflictPath', entry.path));
    if (entry.stale) row.append(element('div', 'syncConflictStale menu_button_note', t`This file changed after the conflict was found. Choosing another version overwrites the current version.`));
    const cards = element('div', 'syncConflictCards flex-container flexGap10');
    cards.append(
        renderCard({ entry, index, choice: 'ours', title: t`Version from ${entry.oursDevice}`, oid: entry.ours, inUse: entry.ours === entry.kept, previews }),
        renderCard({ entry, index, choice: 'theirs', title: t`Version from ${entry.theirsDevice}`, oid: entry.theirs, inUse: entry.theirs === entry.kept, previews }),
        renderCard({ entry, index, choice: 'current', title: t`Current version`, oid: entry.current, inUse: false, previews }),
    );
    row.append(cards);
    return row;
}

async function findCharacterIndex(avatar) {
    const index = characters.findIndex(c => c.avatar === avatar);
    if (index >= 0) return index;
    // A character a sync brought in is not in the list loaded at page start.
    await getCharacters();
    return characters.findIndex(c => c.avatar === avatar);
}

/**
 * Open the chat a notice points at.
 *
 * @param {object} notice Pending notice of the status
 * @throws {Error & { code: string }} With a user-facing message when the chat or its group could not be found or opened
 */
export async function openSyncNoticeTarget(notice) {
    const { target } = notice;
    const restored = notice.kind === 'restored';
    const failure = (message, code) => Object.assign(new Error(message), { code });
    const missing = () => failure(restored ? t`The chat could not be found.` : t`The branch chat could not be found.`, 'CHAT_MISSING');
    if (target.kind === 'group') {
        if (target.groupId === null) throw failure(restored ? t`The group of this chat could not be found.` : t`The group of this branch chat could not be found.`, 'GROUP_MISSING');
        // The group list loaded at page start does not hold chats a sync added.
        await getGroups();
        const group = groups.find(g => g.id === target.groupId);
        if (!group || !group.chats.includes(target.name)) throw missing();
        // `openGroupChat` switches chats within the selected group only.
        if (selected_group !== target.groupId && !await openGroupById(target.groupId)) {
            throw failure(t`The group of this chat could not be opened.`, 'GROUP_OPEN_FAILED');
        }
        await openGroupChat(target.groupId, target.name);
        return;
    }
    const index = await findCharacterIndex(target.avatar);
    if (index < 0) throw missing();
    await selectCharacterById(index);
    await openCharacterChat(target.name);
}

/** @returns {Promise<boolean>} true when the chat was opened */
async function openNoticeTarget(notice) {
    try {
        await openSyncNoticeTarget(notice);
        return true;
    } catch (error) {
        if (!error?.code) throw error;
        toastr.warning(error.message);
        return false;
    }
}

/**
 * Dismiss a notice, then read the status again to learn whether it is gone.
 * Status reads that started before are discarded.
 *
 * @param {object} notice Pending notice of the status
 * @returns {Promise<{ removed: boolean }>} `removed` is false when another backend still reports the notice
 * @throws {Error & { code?: string }} `NOTICE_UNKNOWN` when the records of a reporting backend could not be read
 */
export async function dismissSyncNotice(notice) {
    statusVersion += 1;
    try {
        const response = await fetch(ENDPOINTS.dismiss, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [notice.path] }),
        });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code });
        const result = body.results?.find(result => result.path === notice.path);
        const latest = await readStatus();
        const failed = code => Object.assign(new Error(t`Some notices could not be dismissed. Recover the affected backends and retry.`), { code });
        if (!latest || recordUnknown(notice, latest)) throw failed('NOTICE_UNKNOWN');
        if (latest.notices.some(entry => entry.path === notice.path)) {
            if (body.ok === false || !result?.applied) throw failed('NOTICE_NOT_DISMISSED');
            return { removed: false };
        }
        return { removed: true };
    } finally {
        statusVersion += 1;
    }
}

async function dismissNotice(notice, row) {
    if (row.dataset.dismissing === 'true' || row.classList.contains('syncNoticeUnknown')) return;
    row.dataset.dismissing = 'true';
    const dismiss = row.querySelector('.syncNoticeDismissButton');
    dismiss.classList.add('disabled');
    try {
        const { removed } = await dismissSyncNotice(notice);
        if (removed) {
            const section = row.closest('.syncNoticesSection');
            row.remove();
            if (section && !section.querySelector('.syncNoticeRow')) section.classList.add('displayNone');
        }
    } catch (error) {
        if (error?.code === 'NOTICE_UNKNOWN') markNoticeUnknown(row);
        console.error('[sync] could not dismiss the notice', error);
        toastr.error(String(error?.message || error));
    } finally {
        row.dataset.dismissing = 'false';
        if (!row.classList.contains('syncNoticeUnknown')) dismiss.classList.remove('disabled');
    }
}

function markNoticeUnknown(row) {
    row.classList.add('syncNoticeUnknown');
    row.querySelector('.syncNoticeDismissButton')?.classList.add('disabled');
    if (!row.querySelector('.syncNoticeUnknownNote')) row.append(element('div', 'syncNoticeUnknownNote menu_button_note', t`Pending records could not be read. This notice is unknown until the backend recovers.`));
}

function renderNoticeRow(notice, onOpened) {
    const row = element('div', 'syncNoticeRow flex-container flexFlowColumn flexGap5');
    row.dataset.path = notice.path;
    const restored = notice.kind === 'restored';
    const restoredText = () => (typeof notice.deletedBy === 'string'
        ? t`${notice.target.name} was deleted on ${notice.deletedBy} but kept on ${notice.device}, so it was restored.`
        : t`${notice.target.name} was deleted on one device but kept on ${notice.device}, so it was restored.`);
    const text = restored
        ? restoredText()
        : t`${notice.chat} was edited on two devices. The version from ${notice.device} was saved as the branch chat ${notice.target.name}.`;
    row.append(element('div', 'syncNoticeText', text));
    const open = element('div', 'menu_button syncNoticeOpenButton', restored ? t`Open chat` : t`Open branch`);
    const dismiss = element('div', 'menu_button syncNoticeDismissButton', t`Dismiss`);
    const missingGroup = notice.target.kind === 'group' && notice.target.groupId === null;
    if (missingGroup) {
        open.classList.add('disabled');
        row.append(element('div', 'syncNoticeMissingGroup menu_button_note', restored ? t`The group of this chat could not be found.` : t`The group of this branch chat could not be found.`));
    } else {
        open.addEventListener('click', () => openNoticeTarget(notice).then(opened => opened && onOpened()).catch(error => {
            console.error('[sync] could not open the chat of a notice', error);
            toastr.error(String(error?.message || error));
        }));
    }
    dismiss.addEventListener('click', () => dismissNotice(notice, row));
    const actions = element('div', 'flex-container flexGap10');
    actions.append(open, dismiss);
    row.append(actions);
    return row;
}

/**
 * The selected choice of each conflict row, after the user confirmed
 * overwriting the current version of every stale row. Null when the user
 * declined an overwrite.
 */
async function collectChoices(template, conflictByPath) {
    const choices = [];
    for (const row of template.find('.syncConflictRow:not(.syncConflictResolved):not(.syncConflictUnknown)').toArray()) {
        const choice = row.querySelector('input[type=radio]:checked')?.value;
        if (!choice) continue;
        const relPath = row.dataset.path;
        const entry = conflictByPath.get(relPath);
        if (row.querySelector('.syncConflictStale') && choice !== 'current') {
            const confirmed = await callGenericPopup(
                element('div', '', t`Overwrite the current version of ${relPath}? The current version stays in the sync history.`),
                POPUP_TYPE.CONFIRM, '',
                { okButton: t`Overwrite`, cancelButton: t`Cancel` },
            );
            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return null;
        }
        choices.push({ path: relPath, choice, review: {
            backendId: entry.backendId,
            selectedOid: choice === 'current' ? entry.current : entry[choice],
            recordVersions: { ...entry.recordVersions },
            currentVersions: { ...entry.currentVersions },
        } });
    }
    return choices;
}

// The Data window replaced this popup; it stays until the old sync UI is removed.
// eslint-disable-next-line no-unused-vars
async function openSyncPopup(status) {
    const template = $(await renderTemplateAsync('syncConflicts'));
    const previews = createPreviewCache();
    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    const conflictByPath = new Map(status.conflicts.map(entry => [entry.path, entry]));
    const noticeByPath = new Map(status.notices.map(entry => [entry.path, entry]));
    let nextIndex = 0;
    const addConflictRow = entry => {
        template.find('.syncConflictsSection').removeClass('displayNone');
        template.find('.syncConflictList').append(renderConflictRow(entry, nextIndex++, previews));
    };
    status.conflicts.forEach(addConflictRow);
    const rowsOf = () => template.find('.syncConflictRow').toArray();
    const noticeRows = () => template.find('.syncNoticeRow').toArray();
    for (const row of rowsOf()) if (recordUnknown(conflictByPath.get(row.dataset.path), status)) markUnknown(row);
    if (status.notices.length > 0) {
        template.find('.syncNoticesSection').removeClass('displayNone');
        const list = template.find('.syncNoticeList');
        for (const notice of status.notices) list.append(renderNoticeRow(notice, () => popup.completeAffirmative()));
    }
    const stalled = stalledPathsOf(status);
    if (stalled.length > 0) {
        template.find('.syncStalledSection').removeClass('displayNone');
        const list = template.find('.syncStalledList');
        for (const relPath of stalled) list.append(element('div', 'syncStalledPath', relPath));
    }

    const error = template.find('.syncConflictsError');
    if (Object.keys(status.errors ?? {}).length) error.text(t`Some pending sync records could not be read.`).removeClass('displayNone');
    const applyButton = template.find('.syncConflictsApplyButton');
    let applying = false;
    let checkDeferred = false;
    applyButton.on('click', async () => {
        if (applying) return;
        error.addClass('displayNone').text('');
        const selectionVersion = statusVersion;
        const choices = await collectChoices(template, conflictByPath);
        if (selectionVersion !== statusVersion) return;
        if (choices === null) return;
        if (choices.length === 0) {
            error.text(t`Choose a version for at least one file.`).removeClass('displayNone');
            return;
        }
        applying = true;
        statusVersion += 1;
        applyButton.addClass('disabled');
        try {
            const { results, partialFailure, unapplied } = await submitConflictChoices(choices);
            // A choice another device resolved first is no longer pending.
            const latest = unapplied.length > 0 || partialFailure ? await readStatus() : null;
            if (latest) refresh(latest, true);
            const pendingPaths = latest ? new Set(latest.conflicts.map(entry => entry.path)) : null;
            const isPending = relPath => !pendingPaths || recordUnknown(conflictByPath.get(relPath), latest) || pendingPaths.has(relPath);
            const failed = unapplied.filter(isPending);
            const resolvedElsewhere = unapplied.filter(relPath => !isPending(relPath));
            if (resolvedElsewhere.length > 0) toastr.info(t`Some choices were already resolved on another device.`);
            const readFailed = latest && (latest.ok === false || Object.keys(latest.errors ?? {}).length > 0);
            if (failed.length === 0 && !partialFailure && !readFailed) {
                if (results.some(result => result.applied)) toastr.success(t`Choices applied.`);
                await popup.completeAffirmative();
                return;
            }
            for (const row of rowsOf()) {
                const relPath = row.dataset.path;
                if ((partialFailure || readFailed) && recordUnknown(conflictByPath.get(relPath), latest)) {
                    markUnknown(row);
                    shownKeys.delete(row.dataset.key);
                } else if (failed.includes(relPath)) {
                    // Lets a later check show the conflict again after this popup closes.
                    shownKeys.delete(conflictKey(conflictByPath.get(relPath)));
                    if (recordUnknown(conflictByPath.get(relPath), latest)) markUnknown(row);
                } else if (resolvedElsewhere.includes(relPath)) {
                    markResolvedElsewhere(row);
                } else if (choices.some(choice => choice.path === relPath)) {
                    row.remove();
                }
            }
            error.text(partialFailure || readFailed || !latest
                ? t`Some pending sync records could not be read.`
                : t`These choices could not be applied yet: ${failed.join(', ')}`).removeClass('displayNone');
        } catch (failure) {
            console.error('[sync] could not apply the conflict choices', failure);
            error.text(t`Could not apply the choices: ${String(failure?.message || failure)}`).removeClass('displayNone');
        } finally {
            applying = false;
            statusVersion += 1;
            applyButton.removeClass('disabled');
            // A status read during the apply is outdated by it; read again.
            if (checkDeferred) {
                checkDeferred = false;
                check();
            }
        }
    });

    // Conflicts another device resolved are marked and new ones are added
    // while the popup stays open. A check while a choice applies runs again
    // once the apply ends; only listed conflicts count as shown, so one the
    // popup never listed opens it again after it closes.
    const refresh = (latest, afterApply = false) => {
        if (applying && !afterApply) {
            checkDeferred = true;
            return;
        }
        const pending = new Set(latest.conflicts.map(conflictKey));
        const listed = new Set(rowsOf().map(row => row.dataset.key));
        for (const row of rowsOf()) {
            if (!pending.has(row.dataset.key)) {
                if (recordUnknown(conflictByPath.get(row.dataset.path), latest)) {
                    markUnknown(row);
                    shownKeys.delete(row.dataset.key);
                } else markResolvedElsewhere(row);
            }
        }
        if (Object.keys(latest.errors ?? {}).length) error.text(t`Some pending sync records could not be read.`).removeClass('displayNone');
        for (const reported of latest.conflicts) {
            // A readable backend may still report this path while another
            // original reporter is unreadable. Retain that unknown evidence.
            const prior = conflictByPath.get(reported.path);
            const unknownReporters = reportingBackends(prior).filter(id => latest.errors?.[id] || latest.backends?.[id]?.pendingError);
            const entry = unknownReporters.length ? {
                ...reported,
                backends: [...new Set([...reportingBackends(reported), ...unknownReporters])],
            } : reported;
            const previous = conflictByPath.get(entry.path);
            const row = rowsOf().find(row => row.dataset.path === entry.path);
            const changed = previous && JSON.stringify(previous) !== JSON.stringify(entry);
            if (changed || row?.classList.contains('syncConflictUnknown') || row?.classList.contains('syncConflictResolved')) {
                if (row) {
                    const selected = row.querySelector('input[type="radio"]:checked')?.value;
                    const replacement = renderConflictRow(entry, nextIndex++, previews);
                    if (selected && previous.backendId === entry.backendId && previous.current === entry.current && previous.stale === entry.stale
                        && JSON.stringify(previous.recordVersions) === JSON.stringify(entry.recordVersions)
                        && JSON.stringify(previous.currentVersions) === JSON.stringify(entry.currentVersions)) {
                        const radio = replacement.querySelector(`input[value="${selected}"]`);
                        if (radio) radio.checked = true;
                    }
                    row.replaceWith(replacement);
                } else addConflictRow(entry);
                conflictByPath.set(entry.path, entry);
            } else if (!listed.has(conflictKey(entry))) {
                conflictByPath.set(entry.path, entry);
                addConflictRow(entry);
            }
            if (recordUnknown(entry, latest)) {
                const currentRow = rowsOf().find(row => row.dataset.path === entry.path);
                if (currentRow) markUnknown(currentRow);
                shownKeys.delete(conflictKey(entry));
            } else shownKeys.add(conflictKey(entry));
        }
        for (const row of noticeRows()) {
            if (row.dataset.dismissing === 'true') continue;
            const prior = noticeByPath.get(row.dataset.path);
            const reported = latest.notices.find(entry => entry.path === row.dataset.path);
            if (recordUnknown(prior, latest)) markNoticeUnknown(row);
            else if (!reported) row.remove();
        }
        for (const reported of latest.notices) {
            const prior = noticeByPath.get(reported.path);
            const unknownReporters = reportingBackends(prior).filter(id => latest.errors?.[id] || latest.backends?.[id]?.pendingError);
            const entry = unknownReporters.length ? { ...reported, backends: [...new Set([...reportingBackends(reported), ...unknownReporters])] } : reported;
            const row = noticeRows().find(row => row.dataset.path === entry.path);
            if (row?.dataset.dismissing === 'true') continue;
            if (!row || row.classList.contains('syncNoticeUnknown') || JSON.stringify(prior) !== JSON.stringify(entry)) {
                const replacement = renderNoticeRow(entry, () => popup.completeAffirmative());
                if (recordUnknown(entry, latest)) markNoticeUnknown(replacement);
                if (row) row.replaceWith(replacement);
                else template.find('.syncNoticeList').append(replacement);
            }
            noticeByPath.set(entry.path, entry);
        }
        template.find('.syncNoticesSection').toggleClass('displayNone', noticeRows().length === 0);
        if (!Object.keys(latest.errors ?? {}).length && error.text() === t`Some pending sync records could not be read.`) error.addClass('displayNone').text('');
        if (error.text() === t`Could not read sync status. Check the connection and retry.`) error.addClass('displayNone').text('');
    };
    refreshOpenPopup = refresh;
    const fail = () => {
        for (const row of rowsOf()) markUnknown(row, true);
        for (const row of noticeRows()) markNoticeUnknown(row);
        error.text(t`Could not read sync status. Check the connection and retry.`).removeClass('displayNone');
    };
    failOpenPopup = fail;

    // `show` attaches the dialog before it returns; the promise settles
    // when the user closes it.
    const closed = popup.show();
    closed.finally(() => {
        popupOpen = false;
        if (refreshOpenPopup === refresh) refreshOpenPopup = null;
        if (failOpenPopup === fail) failOpenPopup = null;
        previews.revoke();
    });
}

/**
 * Send conflict choices to the server.
 *
 * @param {{ path: string, choice: string, review: object }[]} choices
 * @returns {Promise<{ results: any[], partialFailure: boolean, unapplied: string[] }>} `unapplied` lists the paths whose choice was not applied
 */
export async function submitConflictChoices(choices) {
    const response = await fetch(ENDPOINTS.resolve, {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(choices),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code });
    const results = Array.isArray(body.results) ? body.results : [];
    const resultErrors = Object.assign({}, body.errors, ...results.map(result => result.errors));
    return {
        results,
        partialFailure: body.ok === false || Object.keys(resultErrors).length > 0,
        unapplied: results.filter(result => !result.applied).map(result => result.path),
    };
}

/** Discard status reads in flight, such as before and after a choice changes the pending records. */
export function invalidateSyncStatusReads() {
    statusVersion += 1;
}

function statusFailure() {
    console.error('[sync] status read failed');
    failOpenPopup?.();
    document.dispatchEvent(new CustomEvent('sync-status-read-failed'));
    if (!statusReadFailed) toastr.error(t`Could not read sync status. Check the connection and retry.`, t`Sync`);
    statusReadFailed = true;
}

async function requestStatus() {
    const response = await fetch(ENDPOINTS.status, { headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    if (!Array.isArray(status?.conflicts) || !Array.isArray(status?.notices) || ![status.backends, status.errors].every(value => value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error('Invalid sync status response');
    return status;
}

/**
 * Read the status and announce it with `sync-status-updated`.
 * Null denotes an invalidated response, never a failed read.
 * @returns {Promise<object | null>}
 */
export async function readStatus() {
    const version = ++statusVersion;
    try {
        const status = await requestStatus();
        if (version !== statusVersion) return null;
        statusReadFailed = false;
        document.dispatchEvent(new CustomEvent('sync-status-updated', { detail: status }));
        return status;
    } catch (error) {
        if (version === statusVersion) statusFailure();
        throw error;
    }
}

/**
 * Read the pending sync state and open the popup when it holds something
 * not shown yet, or anything at all with `showSeen`. A check finishes once
 * the popup is on screen, without waiting for the user to close it.
 */
async function check({ showSeen = false } = {}) {
    const version = ++statusVersion;
    try {
        const status = await requestStatus();
        if (version !== statusVersion) return;
        statusReadFailed = false;
        document.dispatchEvent(new CustomEvent('sync-status-updated', { detail: status }));
        for (const backendId of Object.keys(status.errors ?? {})) {
            toastr.error(t`Could not read pending sync records for ${backendId}.`, t`Sync`);
        }
        const keys = pendingKeys(status);
        const unseen = keys.some(key => !shownKeys.has(key));
        // An open Data window lists new items live, so they count as shown
        // without moving the user away from the page they are on.
        const windowOpen = popupOpen || isDataWindowOpen();
        if (keys.length > 0 && (showSeen || (unseen && !windowOpen))) {
            await showSyncIssues();
            for (const key of keys) shownKeys.add(key);
        } else if (windowOpen) {
            for (const key of keys) shownKeys.add(key);
        }
    } catch (error) {
        if (version === statusVersion) statusFailure();
    } finally {
        checks += 1;
        document.body.dataset.syncStatusChecks = String(checks);
    }
}

/** True while the Data window is on screen. */
function isDataWindowOpen() {
    return document.querySelector('dialog.dw-layer[open]') !== null;
}

/** Open the Data window on the page listing what sync left to decide. */
async function showSyncIssues() {
    try {
        const { openDataWindow } = await import('./data-window.js');
        openDataWindow({ tab: 'sync', view: 'conflicts' });
    } catch (error) {
        console.error('[sync] could not open the Data window', error);
    }
}

function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (document.visibilityState === 'visible') await check();
        schedulePoll();
    }, activityRunning ? ACTIVE_STATUS_POLL_MS : STATUS_POLL_MS);
}

document.addEventListener('sync-activity-updated', event => {
    if (activityRunning === event.detail.running) return;
    activityRunning = event.detail.running;
    if (pollTimer !== null) schedulePoll();
});

/**
 * @param {{ showSeen?: boolean }} [options] `showSeen` opens the popup for
 * pending items the user already saw and closed.
 */
export function checkSyncStatusNow({ showSeen = false } = {}) {
    return check({ showSeen });
}

eventSource.on(event_types.APP_READY, async () => {
    initializeSyncActivity();
    await check({ showSeen: true });
    schedulePoll();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
});
