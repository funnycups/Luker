import { converter, getRequestHeaders } from '../script.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t, translate } from './i18n.js';

/**
 * @typedef {Object} Announcement
 * @property {string} id
 * @property {'info'|'warning'|'critical'} level
 * @property {string} title
 * @property {string} body
 * @property {number} createdAt
 * @property {string} createdBy
 * @property {number} [updatedAt]
 */

/**
 * In-memory module state. Single instance per page load — survives navigation
 * within the SPA but is reset on full reload.
 */
const state = {
    /** @type {Announcement[]} */
    items: [],
    /** @type {Set<string>} */
    readIds: new Set(),
    /** @type {Announcement[]} ordered desc by createdAt, recomputed on warning dismiss */
    warningQueue: [],
    /** @type {boolean} server reports whether enableUserAccounts is on; bell + routing are off otherwise */
    multiUser: false,
};

async function api(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${path} -> ${response.status}`);
    }
    if (response.status === 204) return null;
    return await response.json();
}

async function fetchAnnouncements() {
    const result = await api('/api/users/announcements/me/list');
    state.items = Array.isArray(result?.items) ? result.items : [];
    state.readIds = new Set(Array.isArray(result?.readIds) ? result.readIds : []);
    state.multiUser = Boolean(result?.multiUser);
    updateBellVisibility();
}

function updateBellVisibility() {
    const bell = document.getElementById('announcement-bell-button');
    if (!bell) return;
    bell.classList.toggle('is-active', state.multiUser);
}

async function markRead(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
        await api('/api/users/announcements/me/mark-read', { ids });
        for (const id of ids) state.readIds.add(id);
    } catch (error) {
        console.warn('Failed to persist announcement read state:', error);
    }
    updateBellBadge();
}

function isUnread(item) {
    return !state.readIds.has(item.id);
}

function unreadByLevel(level) {
    return state.items.filter((item) => item.level === level && isUnread(item));
}

function levelIconClass(level) {
    if (level === 'critical') return 'fa-circle-exclamation';
    if (level === 'warning') return 'fa-triangle-exclamation';
    return 'fa-circle-info';
}

function levelTextKey(level) {
    if (level === 'critical') return 'Critical';
    if (level === 'warning') return 'Warning';
    return 'Info';
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function formatAnnouncementBody(body) {
    const html = converter.makeHtml(String(body || ''));
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
}

function renderAnnouncementBlock(item) {
    const bodyHtml = formatAnnouncementBody(item.body);
    const levelLabel = translate(levelTextKey(item.level));
    return `
        <div class="announcement-item announcement-level-${escapeHtml(item.level)}" data-id="${escapeHtml(item.id)}">
            <div class="announcement-header flex-container alignItemsCenter flexGap10">
                <i class="fa-solid fa-fw ${levelIconClass(item.level)} announcement-level-icon"></i>
                <strong class="announcement-title">${escapeHtml(item.title)}</strong>
                <small class="announcement-level-tag">${escapeHtml(levelLabel)}</small>
            </div>
            <div class="announcement-body">${bodyHtml}</div>
        </div>
    `;
}

async function showCriticalModal(items) {
    const header = items.length === 1 ? t`Announcement` : t`Announcements`;
    const blocks = items.map(renderAnnouncementBlock).join('');
    const html = `
        <h3 class="margin0">${escapeHtml(header)}</h3>
        <div class="announcement-list">${blocks}</div>
    `;
    await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: t`Mark all as read`,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    await markRead(items.map((x) => x.id));
}

function clearWarningBanner() {
    document.getElementById('announcement-banner')?.remove();
}

function ensureBannerHost() {
    let host = document.getElementById('announcement-banner-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'announcement-banner-host';
    const topBar = document.getElementById('top-bar');
    if (topBar?.parentNode) {
        topBar.parentNode.insertBefore(host, topBar);
    } else {
        document.body.appendChild(host);
    }
    return host;
}

function renderWarningBanner() {
    clearWarningBanner();
    const next = state.warningQueue.find((item) => isUnread(item));
    if (!next) return;

    const host = ensureBannerHost();
    const banner = document.createElement('div');
    banner.id = 'announcement-banner';
    banner.className = 'announcement-banner';
    banner.innerHTML = `
        <i class="fa-solid fa-fw fa-triangle-exclamation announcement-level-icon"></i>
        <span class="announcement-banner-title">${escapeHtml(next.title)}</span>
        <button class="menu_button announcement-banner-open" type="button">${escapeHtml(t`Open`)}</button>
        <button class="menu_button announcement-banner-dismiss" type="button" title="${escapeHtml(t`Dismiss`)}">
            <i class="fa-solid fa-times"></i>
        </button>
    `;
    banner.querySelector('.announcement-banner-open').addEventListener('click', async () => {
        await callGenericPopup(renderAnnouncementBlock(next), POPUP_TYPE.TEXT, '', {
            wide: true, large: true, allowVerticalScrolling: true,
        });
        await markRead([next.id]);
        renderWarningBanner();
    });
    banner.querySelector('.announcement-banner-dismiss').addEventListener('click', async () => {
        await markRead([next.id]);
        renderWarningBanner();
    });
    host.appendChild(banner);
}

function updateBellBadge() {
    const badge = document.getElementById('announcement-bell-badge');
    if (!badge) return;
    const count = state.items.filter((item) => isUnread(item)).length;
    if (count <= 0) {
        badge.classList.add('hidden');
        badge.textContent = '';
        return;
    }
    badge.classList.remove('hidden');
    badge.textContent = count > 9 ? '9+' : String(count);
}

async function routeUnreadAfterFetch() {
    if (!state.multiUser) {
        console.info('[announcements] single-user mode, skipping routing');
        updateBellBadge();
        return;
    }
    const critical = unreadByLevel('critical');
    const warning = unreadByLevel('warning');
    const info = unreadByLevel('info');
    console.info(
        `[announcements] fetched ${state.items.length} total, unread: ${critical.length} critical / ${warning.length} warning / ${info.length} info`,
    );
    if (critical.length > 0) {
        await showCriticalModal(critical);
    }
    state.warningQueue = warning;
    renderWarningBanner();
    updateBellBadge();
}

let initialized = false;

export async function initAnnouncements() {
    if (initialized) return;
    initialized = true;
    // Run fetch + UI work as fire-and-forget so the critical modal does not
    // block the rest of the startup chain (extensions, tokenizers, APP_READY).
    (async () => {
        try {
            await fetchAnnouncements();
            await routeUnreadAfterFetch();
        } catch (error) {
            console.error('[announcements] init failed:', error);
            if (window.toastr) {
                window.toastr.error(String(error?.message || error), t`Announcements`);
            }
        }
    })();
}

export { markRead as markAnnouncementsRead, renderAnnouncementBlock, formatAnnouncementBody };

function formatRelativeTime(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return String(ts);
    }
}

function renderInboxRow(item) {
    const unread = isUnread(item);
    const levelLabel = translate(levelTextKey(item.level));
    return `
        <div class="announcement-inbox-row ${unread ? 'is-unread' : ''}" data-id="${escapeHtml(item.id)}">
            <div class="flex-container alignItemsCenter flexGap10">
                <i class="fa-solid fa-fw ${levelIconClass(item.level)} announcement-level-icon"></i>
                <strong class="flex1">${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(levelLabel)}</small>
                <small class="announcement-inbox-time">${escapeHtml(formatRelativeTime(item.createdAt))}</small>
            </div>
            <div class="announcement-inbox-body" style="display: none;"></div>
        </div>
    `;
}

async function openInbox() {
    await fetchAnnouncements();
    updateBellBadge();

    if (state.items.length === 0) {
        await callGenericPopup(
            `<div class="announcement-inbox-empty">${escapeHtml(t`No announcements`)}</div>`,
            POPUP_TYPE.TEXT,
            '',
            { wide: false, allowVerticalScrolling: true },
        );
        return;
    }

    const html = `
        <h3 class="margin0">${escapeHtml(t`Announcements`)}</h3>
        <div class="announcement-inbox-list">
            ${state.items.map(renderInboxRow).join('')}
        </div>
    `;

    const popup = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: t`Close`,
        cancelButton: false,
    });

    updateBellBadge();
    return popup;
}

document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const bell = target.closest('#announcement-bell-button');
    if (bell) {
        event.preventDefault();
        try {
            await openInbox();
        } catch (error) {
            console.error('Failed to open announcements inbox:', error);
            if (window.toastr) {
                window.toastr.error(String(error?.message || error), t`Announcements`);
            }
        }
        return;
    }

    const row = target.closest('.announcement-inbox-row');
    if (row) {
        try {
            const id = row.getAttribute('data-id');
            const item = state.items.find((x) => x.id === id);
            if (!item) return;
            const bodyEl = row.querySelector('.announcement-inbox-body');
            if (!bodyEl) return;
            const isOpen = bodyEl.style.display !== 'none';
            if (isOpen) {
                bodyEl.style.display = 'none';
            } else {
                bodyEl.innerHTML = formatAnnouncementBody(item.body);
                bodyEl.style.display = '';
                if (isUnread(item)) {
                    row.classList.remove('is-unread');
                    await markRead([item.id]);
                }
            }
        } catch (error) {
            console.error('Announcement row interaction failed:', error);
        }
    }
});

export { openInbox };
