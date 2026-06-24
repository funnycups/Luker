/**
 * LAN Sync panel: pairing, peer list, sync trigger, conflict resolution.
 *
 * Reachable from User Settings → Account → Backup & Restore → LAN Sync.
 * The panel itself is rendered into a `callGenericPopup` modal so it
 * lives alongside the existing User-Settings flows (Backup, Snapshots,
 * Admin) without competing for top-bar drawer space.
 *
 * Wire protocol details — none, that is the engine's concern. This
 * module only:
 *   - reads/writes the peer registry via the admin endpoints in
 *     `src/endpoints/sync.js` (`/peers`, `/pair/start`, `/pair/accept`),
 *   - drives sync action endpoints (`/pull`, `/undo`),
 *   - renders the conflict shape returned by `/pull` (`{ ok: false,
 *     conflicts: [{ filepath, kind, oursOid, theirsOid }, ...] }`) as
 *     a per-file pick-one-side card grid, and re-posts `/pull` with
 *     `{ resolutions: {...} }` when the user clicks Apply.
 *
 * SYNC_CATEGORIES is fetched lazily from `/api/sync/v1/categories` (NEW
 * — see `src/endpoints/sync.js`). The list isn't bundled into the
 * frontend so adding a category server-side automatically appears in the
 * UI on next panel open, with no rebuild.
 */
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { copyText } from './utils.js';
import { getRequestHeaders } from '../script.js';

const ENDPOINTS = {
    peers: '/api/sync/v1/peers',
    peer: (id) => `/api/sync/v1/peers/${encodeURIComponent(id)}`,
    peerLabel: (id) => `/api/sync/v1/peers/${encodeURIComponent(id)}/label`,
    peerSync: (id) => `/api/sync/v1/peers/${encodeURIComponent(id)}/sync`,
    peerAuth: (id) => `/api/sync/v1/peers/${encodeURIComponent(id)}/auth`,
    pairStart: '/api/sync/v1/pair/start',
    pairAccept: '/api/sync/v1/pair/accept',
    pull: '/api/sync/v1/pull',
    undo: '/api/sync/v1/undo',
    categories: '/api/sync/v1/categories',
    availability: '/api/sync/v1/availability',
};

/**
 * Pairing-link wire format. Carries the minimum needed for the consumer
 * to call `/pair/accept`. Versioned scheme so future fields can be
 * introduced without breaking existing clients.
 */
const PAIR_LINK_SCHEME = 'luker-sync';
const PAIR_LINK_VERSION = 'v1';

function buildPairLink({ peerBaseUrl, peerId, label, categories }) {
    const params = new URLSearchParams();
    params.set('base', peerBaseUrl);
    params.set('peer', peerId);
    params.set('label', label || '');
    params.set('cats', (categories || []).join(','));
    return `${PAIR_LINK_SCHEME}://pair/${PAIR_LINK_VERSION}?${params.toString()}`;
}

/**
 * Parse a pairing link previously built by `buildPairLink`. Returns null
 * on any malformed input; the caller falls back to manual-fields entry.
 * The function is intentionally lenient about scheme prefix so a user who
 * accidentally clipped the prefix can still paste the rest.
 */
function parsePairLink(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept both `luker-sync://pair/v1?...` and the bare query string.
    const queryIdx = trimmed.indexOf('?');
    if (queryIdx < 0) return null;
    const qs = trimmed.slice(queryIdx + 1);
    const params = new URLSearchParams(qs);
    const base = params.get('base');
    const peer = params.get('peer');
    if (!base || !peer) return null;
    return {
        peerBaseUrl: base,
        peerId: peer,
        label: params.get('label') || '',
        categories: (params.get('cats') || '').split(',').filter(Boolean),
    };
}

/**
 * Categories fetched once per panel open. Server-side `SYNC_CATEGORIES`
 * already speaks displayKey/descriptionKey i18n keys; we render directly
 * against them rather than maintaining a parallel UI registry.
 */
let cachedCategories = null;

async function loadCategories() {
    if (cachedCategories) return cachedCategories;
    const res = await fetch(ENDPOINTS.categories, { headers: getRequestHeaders() });
    if (!res.ok) {
        cachedCategories = [];
        return cachedCategories;
    }
    const body = await res.json();
    cachedCategories = Array.isArray(body?.categories) ? body.categories : [];
    return cachedCategories;
}

async function loadPeers() {
    const res = await fetch(ENDPOINTS.peers, { headers: getRequestHeaders() });
    if (!res.ok) return {};
    const body = await res.json();
    return body?.peers ?? {};
}

/**
 * Probe whether LAN Sync is available on this server. Returns the raw
 * `{available, reason?}` shape from `/availability`; today every storage
 * mode is supported and the route returns `{available: true}` — the
 * unreachable branch below covers the "server isn't responding" case so
 * the caller can render an honest error instead of crashing on a missing
 * field.
 */
async function loadAvailability() {
    try {
        const res = await fetch(ENDPOINTS.availability, { headers: getRequestHeaders() });
        if (!res.ok) return { available: false, reason: 'unreachable' };
        return await res.json();
    } catch {
        return { available: false, reason: 'unreachable' };
    }
}

/**
 * Fetch the logged-in user's handle for the pairing pre-flight check.
 * Returns the handle string, `''` if the call succeeded but the response
 * had no handle, or `null` if the request failed entirely — `null` lets
 * the caller fall through to the server-side gate rather than blocking
 * the user on a transient network error.
 *
 * @returns {Promise<string | null>}
 */
async function getCurrentHandleForSync() {
    try {
        const res = await fetch('/api/users/me', { headers: getRequestHeaders() });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        if (!body) return null;
        return String(body.handle || '');
    } catch {
        return null;
    }
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return t`Never`;
    const delta = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return t`just now`;
    if (minutes < 60) return t`${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t`${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return t`${days} day(s) ago`;
}

function renderCategoryGrid(container, categories, defaultSelected) {
    container.empty();
    for (const cat of categories) {
        const checked = defaultSelected
            ? defaultSelected.includes(cat.id)
            : cat.syncDefault === 'on';
        const label = $('<label class="checkbox_label lanSyncCategoryItem"></label>');
        const input = $('<input type="checkbox" name="lanSyncCategory">');
        input.val(cat.id);
        input.prop('checked', checked);
        // Show English-derived friendly text by default (id → Title Case);
        // data-i18n on the same node lets translate() swap it for the
        // localized string at attach time when zh-CN/zh-TW are active.
        // Without this, English users would see the raw i18n key
        // ("sync.category.characters") because there is no en.json file —
        // the fallback IS the data-i18n value.
        const span = $('<span></span>');
        span.attr('data-i18n', cat.displayKey);
        span.text(englishFallbackForCategory(cat.id));
        label.append(input).append(' ').append(span);
        container.append(label);
    }
}

function englishFallbackForCategory(id) {
    return String(id)
        .split('-')
        .map(w => w[0]?.toUpperCase() + w.slice(1))
        .join(' ');
}

function collectSelectedCategoryIds(container) {
    const ids = [];
    container.find('input[name="lanSyncCategory"]:checked').each(function () {
        ids.push(String($(this).val()));
    });
    return ids;
}

function showStatusBanner(template, kind, message) {
    const banner = template.find('.lanSyncStatusBanner');
    banner.removeClass('displayNone success warning error info');
    banner.addClass(kind);
    banner.text(message);
}

function clearStatusBanner(template) {
    const banner = template.find('.lanSyncStatusBanner');
    banner.addClass('displayNone');
    banner.text('');
}

function switchTab(template, tabName) {
    template.find('.lanSyncTabPanel').addClass('displayNone');
    template.find(`.lanSyncPanel${tabName}`).removeClass('displayNone');
    template.find('.lanSyncTab').removeClass('selected');
    template.find(`.lanSyncTab[data-tab="${kebabFromCamel(tabName)}"]`).addClass('selected');
}

function kebabFromCamel(s) {
    return s.replace(/[A-Z]/g, (m, i) => (i === 0 ? m.toLowerCase() : '-' + m.toLowerCase()));
}

function renderPeersList(template, peers, handlers) {
    const list = template.find('.lanSyncPeersList');
    const empty = template.find('.lanSyncPeersEmpty');
    list.empty();
    const entries = Object.entries(peers);
    if (!entries.length) {
        empty.removeClass('displayNone');
        return;
    }
    empty.addClass('displayNone');
    for (const [peerId, peer] of entries) {
        const row = $('<div class="lanSyncPeerRow flex-container flexFlowColumn flexGap10"></div>');
        const title = $('<div class="lanSyncPeerTitle flex-container flexGap10"></div>');
        const label = $('<div class="lanSyncPeerLabel"></div>').text(peer.label || peerId);
        const meta = $('<div class="lanSyncPeerMeta menu_button_note"></div>')
            .text(t`Last sync: ${formatRelativeTime(peer.lastSyncAt)}`);
        title.append(label).append(meta);

        const actions = $('<div class="backupActionRow flex-container flexGap10"></div>');
        const syncBtn = $(`<div class="menu_button menu_button_icon lanSyncPeerSyncButton"><i class="fa-fw fa-solid fa-rotate"></i><span data-i18n="Sync now">${t`Sync now`}</span></div>`);
        const undoBtn = $(`<div class="menu_button menu_button_icon lanSyncPeerUndoButton"><i class="fa-fw fa-solid fa-arrow-rotate-left"></i><span data-i18n="Undo last sync">${t`Undo last sync`}</span></div>`);
        const forgetBtn = $(`<div class="menu_button menu_button_icon lanSyncPeerForgetButton"><i class="fa-fw fa-solid fa-trash"></i><span data-i18n="Forget">${t`Forget`}</span></div>`);
        actions.append(syncBtn).append(undoBtn).append(forgetBtn);

        // "Clear credentials" only when the server reports stored ones —
        // showing it otherwise would be a dead button (the DELETE route
        // is idempotent but it'd still confuse the user). The flag is
        // derived server-side in /peers from peerAuth presence; the
        // password itself never leaves the disk via this route.
        if (peer.hasStoredCredentials) {
            const clearAuthBtn = $(`<div class="menu_button menu_button_icon lanSyncPeerClearAuthButton"><i class="fa-fw fa-solid fa-key"></i><span data-i18n="Clear credentials">${t`Clear credentials`}</span></div>`);
            clearAuthBtn.on('click', () => handlers.onClearAuth(peerId, peer));
            actions.append(clearAuthBtn);
        }

        syncBtn.on('click', () => handlers.onSync(peerId, peer));
        undoBtn.on('click', () => handlers.onUndo(peerId, peer));
        forgetBtn.on('click', () => handlers.onForget(peerId, peer));

        row.append(title).append(actions);
        list.append(row);
    }
}

function renderConflictList(template, conflicts) {
    const list = template.find('.lanSyncConflictList');
    list.empty();
    for (const conflict of conflicts) {
        const row = $('<div class="lanSyncConflictRow flex-container flexFlowColumn flexGap10"></div>');
        const title = $('<div class="lanSyncConflictTitle"></div>').text(conflict.filepath);
        const kindLabel = $('<div class="menu_button_note"></div>').text(t`Type: ${conflict.kind}`);
        const cards = $('<div class="flex-container flexGap10 lanSyncConflictCards"></div>');

        const oursLabel = conflict.kind === 'deleteByUs'
            ? t`Local: deleted`
            : t`Local version`;
        const theirsLabel = conflict.kind === 'deleteByTheirs'
            ? t`Remote: deleted`
            : t`Remote version`;

        const ourCard = $(`<label class="checkbox_label lanSyncConflictCard"><input type="radio" name="conflict-${conflict.filepath}" value="ours" checked><span>${oursLabel}</span></label>`);
        const theirCard = $(`<label class="checkbox_label lanSyncConflictCard"><input type="radio" name="conflict-${conflict.filepath}" value="theirs"><span>${theirsLabel}</span></label>`);
        cards.append(ourCard).append(theirCard);

        row.append(title).append(kindLabel).append(cards);
        row.data('filepath', conflict.filepath);
        list.append(row);
    }
}

function collectResolutions(template) {
    const resolutions = {};
    template.find('.lanSyncConflictRow').each(function () {
        const filepath = $(this).data('filepath');
        const picked = $(this).find('input:checked').val();
        if (filepath && picked) resolutions[filepath] = picked;
    });
    return resolutions;
}

/**
 * Drive a sync against an already-paired peer via the dedicated
 * `/peers/:peerId/sync` endpoint. The endpoint uses the `peerBaseUrl`
 * stored on the peer entry so the user never has to re-type the URL.
 *
 * Returns void; status / error is rendered into the panel's status
 * banner directly.
 */
async function runSyncNow(template, peerId, peer) {
    clearStatusBanner(template);
    showStatusBanner(template, 'info', t`Syncing with ${peer.label || peerId}…`);
    try {
        const res = await fetch(ENDPOINTS.peerSync(peerId), {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 412 && body.code === 'NO_BASE_URL') {
            showStatusBanner(template, 'warning', t`This peer was paired in an older version. Click Forget and pair again to record the base URL.`);
            return;
        }
        if (res.status === 401 && body.stage === 'offer') {
            showStatusBanner(template, 'error', t`Authentication to the other device failed. Forget and re-pair if its credentials changed.`);
            return;
        }
        if (res.status === 502 && body.stage === 'offer') {
            showStatusBanner(template, 'error', t`Could not reach the other device.`);
            return;
        }
        if (!res.ok && res.status !== 409) {
            showStatusBanner(template, 'error', body.error || `HTTP ${res.status}`);
            return;
        }
        // Conflict path: the server returns `{ ok: false, conflicts: [...] }`
        // in body. Render the picker; on Apply we re-post to the same
        // endpoint with `resolutions`.
        if (body.ok === false && Array.isArray(body.conflicts) && body.conflicts.length) {
            showStatusBanner(template, 'warning', t`${body.conflicts.length} file(s) conflict. Pick a version for each below.`);
            renderConflictList(template, body.conflicts);
            template.find('.lanSyncConflictPanel').removeClass('displayNone');
            template.find('.lanSyncApplyResolutionsButton').off('click').on('click', async () => {
                const resolutions = collectResolutions(template);
                showStatusBanner(template, 'info', t`Applying resolutions…`);
                const res2 = await fetch(ENDPOINTS.peerSync(peerId), {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ resolutions }),
                });
                const result = await res2.json().catch(() => ({}));
                if (res2.ok && result.ok !== false) {
                    template.find('.lanSyncConflictPanel').addClass('displayNone');
                    showStatusBanner(template, 'success', t`Sync complete.`);
                } else {
                    showStatusBanner(template, 'error', result.error || `HTTP ${res2.status}`);
                }
            });
            return;
        }
        if (body.ok) {
            showStatusBanner(template, 'success', t`Synced with ${peer.label || peerId}.`);
            template.find('.lanSyncConflictPanel').addClass('displayNone');
        }
    } catch (e) {
        showStatusBanner(template, 'error', String(e.message || e));
    }
}

/**
 * Public entry: open the LAN Sync panel.
 */
export async function openLanSyncPanel() {
    const template = $(await renderTemplateAsync('userLanSync'));

    // Availability check first — the route is kept as a stable forward-
    // compatible surface so the UI can branch on `available: false` if a
    // future blocker (read-only mount, missing git binary, etc.) needs to
    // be surfaced. There are no live blockers today.
    const availability = await loadAvailability();
    if (!availability.available) {
        const message = t`LAN Sync is unavailable. The server reported: ${availability.reason || 'unknown reason'}.`;
        template.find('.lanSyncUnavailableMessage').text(message);
        template.find('.lanSyncUnavailable').removeClass('displayNone');
        template.find('.lanSyncMain').addClass('displayNone');
        await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
        return;
    }

    const categories = await loadCategories();
    const peers = await loadPeers();

    // Wire tabs.
    template.find('.lanSyncTab').on('click', function () {
        const tab = $(this).data('tab');
        const camel = tab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const pascal = camel[0].toUpperCase() + camel.slice(1);
        switchTab(template, pascal);
    });

    // Default tab.
    switchTab(template, peers && Object.keys(peers).length ? 'Peers' : 'PairNew');

    renderCategoryGrid(template.find('.lanSyncCategoryGrid'), categories);
    renderCategoryGrid(template.find('.lanSyncAcceptCategoryGrid'), categories);

    const handlers = {
        async onSync(peerId, peer) {
            // Fast path: peer entry has peerBaseUrl recorded from
            // `/pair/accept` time. Call the dedicated sync-now endpoint
            // which re-runs the offer + pull dance using the stored URL.
            if (peer.peerBaseUrl) {
                await runSyncNow(template, peerId, peer);
                await refreshPeers(template, handlers);
                return;
            }
            // Legacy entry without recorded URL — prompt the user once
            // and let /pair/accept rebuild the registry entry with the
            // URL filled in for next time.
            const baseUrl = await callGenericPopup(
                t`Enter the other device's base URL (e.g. http://192.168.1.42:8000)`,
                POPUP_TYPE.INPUT, '',
                { okButton: t`Sync now`, cancelButton: t`Cancel` },
            );
            if (!baseUrl || typeof baseUrl !== 'string') return;
            const auth = await collectAuthIfNeeded(baseUrl);
            await runPairAccept(template, {
                peerBaseUrl: baseUrl.trim(),
                remotePeerId: peerId,
                label: peer.label || peerId,
                categories: peer.categories || [],
                peerAuth: auth,
            });
            await refreshPeers(template, handlers);
        },
        async onUndo(peerId, peer) {
            const confirm = await callGenericPopup(
                t`Undo the last sync with ${peer.label || peerId}? This rewinds THIS device only; the other device is unaffected.`,
                POPUP_TYPE.CONFIRM, '',
                { okButton: t`Undo`, cancelButton: t`Cancel` },
            );
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            try {
                const res = await fetch(ENDPOINTS.undo, {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ peerId }),
                });
                if (res.status === 404) {
                    toastr.info(t`Nothing to undo — no prior sync recorded.`, t`LAN Sync`);
                    return;
                }
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `HTTP ${res.status}`);
                }
                toastr.success(t`Undo complete.`, t`LAN Sync`);
                showStatusBanner(template, 'success', t`Reverted to the state before the last sync with ${peer.label || peerId}.`);
            } catch (e) {
                toastr.error(String(e.message || e), t`Undo failed`);
            }
        },
        async onForget(peerId, peer) {
            const confirm = await callGenericPopup(
                t`Forget ${peer.label || peerId}? Both the registry entry and the on-disk shadow repo will be deleted. The other device is unaffected.`,
                POPUP_TYPE.CONFIRM, '',
                { okButton: t`Forget`, cancelButton: t`Cancel` },
            );
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            try {
                const res = await fetch(ENDPOINTS.peer(peerId), {
                    method: 'DELETE',
                    headers: getRequestHeaders(),
                });
                if (!res.ok && res.status !== 204) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `HTTP ${res.status}`);
                }
                toastr.success(t`Forgotten.`, t`LAN Sync`);
                await refreshPeers(template, handlers);
            } catch (e) {
                toastr.error(String(e.message || e), t`Forget failed`);
            }
        },
        async onClearAuth(peerId, peer) {
            // No confirm popup — the action is non-destructive (re-pair
            // can reinstate credentials) and the button only appears
            // when credentials are actually stored, so a stray click
            // can't hit nothing. After success we refresh the peer
            // list, which makes the button vanish (server's
            // hasStoredCredentials flag flips to false).
            try {
                const res = await fetch(ENDPOINTS.peerAuth(peerId), {
                    method: 'DELETE',
                    headers: getRequestHeaders(),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `HTTP ${res.status}`);
                }
                toastr.success(t`Credentials cleared.`, t`LAN Sync`);
                await refreshPeers(template, handlers);
            } catch (e) {
                toastr.error(String(e.message || e), t`Failed to clear credentials for ${peer.label || peerId}.`);
            }
        },
    };

    renderPeersList(template, peers, handlers);

    // ====== Pair new device tab ======

    template.find('.lanSyncGenerateLinkButton').on('click', async function () {
        const label = String(template.find('.lanSyncPairLabel').val() || '').trim();
        const cats = collectSelectedCategoryIds(template.find('.lanSyncCategoryGrid'));
        if (!label) {
            toastr.warning(t`Enter a label for the other device first.`, t`LAN Sync`);
            return;
        }
        if (!cats.length) {
            toastr.warning(t`Select at least one category to sync.`, t`LAN Sync`);
            return;
        }

        try {
            const res = await fetch(ENDPOINTS.pairStart, {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ label, categories: cats }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            const body = await res.json();
            const link = buildPairLink({
                peerBaseUrl: body.peerBaseUrl,
                peerId: body.peerId,
                label: body.label,
                categories: body.categories,
            });
            template.find('.lanSyncGeneratedLink').val(link);
            template.find('.lanSyncPairNewResult').removeClass('displayNone');
            template.find('.lanSyncPairNewForm').addClass('displayNone');
            await refreshPeers(template, handlers);
        } catch (e) {
            toastr.error(String(e.message || e), t`Failed to generate pairing link`);
        }
    });

    template.find('.lanSyncCopyLinkButton').on('click', async function () {
        const link = String(template.find('.lanSyncGeneratedLink').val() || '').trim();
        if (!link) return;
        try {
            await copyText(link);
            toastr.success(t`Pairing link copied.`, t`LAN Sync`);
        } catch {
            toastr.info(t`Copy from the field above.`, t`LAN Sync`);
        }
    });

    template.find('.lanSyncNewLinkButton').on('click', function () {
        template.find('.lanSyncPairNewResult').addClass('displayNone');
        template.find('.lanSyncPairNewForm').removeClass('displayNone');
        template.find('.lanSyncGeneratedLink').val('');
    });

    // ====== Pair with existing device tab ======

    template.find('.lanSyncAcceptLink').on('input', function () {
        const raw = String($(this).val() || '').trim();
        const parsed = parsePairLink(raw);
        if (!parsed) return;
        template.find('.lanSyncAcceptBaseUrl').val(parsed.peerBaseUrl);
        template.find('.lanSyncAcceptPeerId').val(parsed.peerId);
        template.find('.lanSyncAcceptLabel').val(parsed.label || '');
        if (parsed.categories.length) {
            // Pre-check exactly the categories the other device wants.
            template.find('.lanSyncAcceptCategoryGrid input[name="lanSyncCategory"]').each(function () {
                const id = $(this).val();
                $(this).prop('checked', parsed.categories.includes(id));
            });
        }
    });

    template.find('.lanSyncAcceptButton').on('click', async function () {
        const peerBaseUrl = String(template.find('.lanSyncAcceptBaseUrl').val() || '').trim();
        const remotePeerId = String(template.find('.lanSyncAcceptPeerId').val() || '').trim();
        const label = String(template.find('.lanSyncAcceptLabel').val() || '').trim();
        const categories = collectSelectedCategoryIds(template.find('.lanSyncAcceptCategoryGrid'));
        const username = String(template.find('.lanSyncAcceptUsername').val() || '').trim();
        const password = String(template.find('.lanSyncAcceptPassword').val() || '');

        if (!peerBaseUrl || !remotePeerId) {
            toastr.warning(t`Paste the pairing link or fill in the base URL and peer ID.`, t`LAN Sync`);
            return;
        }
        if (!categories.length) {
            toastr.warning(t`Select at least one category to sync.`, t`LAN Sync`);
            return;
        }

        await runPairAccept(template, {
            peerBaseUrl,
            remotePeerId,
            label,
            categories,
            peerAuth: (username && password) ? { username, password } : null,
        });
        await refreshPeers(template, handlers);
    });

    // ====== Conflict resolution ======

    template.find('.lanSyncCancelResolutionsButton').on('click', function () {
        template.find('.lanSyncConflictPanel').addClass('displayNone');
        showStatusBanner(template, 'info', t`Conflict resolution canceled. Re-run sync when you're ready.`);
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

async function refreshPeers(template, handlers) {
    const peers = await loadPeers();
    renderPeersList(template, peers, handlers);
}

async function collectAuthIfNeeded(/* baseUrl */) {
    // The client can't probe the peer's auth state without a CORS-allowed
    // endpoint, so we always offer the auth form. Empty strings mean "no
    // auth needed"; the backend forwards them only if both fields are set.
    const username = await callGenericPopup(
        t`Peer's basic auth username (leave blank if disabled)`,
        POPUP_TYPE.INPUT, '',
        { okButton: t`Continue`, cancelButton: t`Cancel` },
    );
    if (username === null) return null;
    if (!username) return null;
    const password = await callGenericPopup(
        t`Peer's basic auth password`,
        POPUP_TYPE.INPUT, '',
        { okButton: t`Continue`, cancelButton: t`Cancel` },
    );
    if (password === null || !password) return null;
    return { username: String(username), password: String(password) };
}

async function runPairAccept(template, payload) {
    clearStatusBanner(template);

    // Pre-flight handle check (spec §3.4). The server enforces the same
    // gate on `/pair/accept`, but doing it here avoids even hitting the
    // network when the user is clearly logged in as the wrong account
    // (e.g. accepted a link minted for `alice` while logged in as `bob`).
    // The regex MUST stay in sync with `sanitizeHandleForPeerId` in
    // `src/endpoints/sync.js` — both sides need to agree on the
    // sanitized form to compare correctly.
    const peerIdPrefix = String(payload.remotePeerId || '').split('@')[0];
    const localHandle = await getCurrentHandleForSync();
    if (localHandle !== null) {
        const expected = String(localHandle || 'peer').replace(/[^A-Za-z0-9._-]/g, '_');
        if (expected !== peerIdPrefix) {
            showStatusBanner(template, 'error',
                t`This pairing link is for ${peerIdPrefix}, but you're logged in as ${expected}. Pair from the matching account, or use the same handle on both devices.`);
            return;
        }
    }

    showStatusBanner(template, 'info', t`Syncing with ${payload.label || payload.remotePeerId}…`);
    try {
        const res = await fetch(ENDPOINTS.pairAccept, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));

        if (res.status === 412 && body.code === 'HANDLE_MISMATCH') {
            const got = String(body.gotHandle || '');
            const expected = String(body.expectedHandle || '');
            showStatusBanner(template, 'error',
                t`This pairing link is for ${got}, but you're logged in as ${expected}. Pair from the matching account, or use the same handle on both devices.`);
            return;
        }
        if (res.status === 401 && body.stage === 'offer') {
            showStatusBanner(template, 'error', t`Authentication to the other device failed. Check your credentials.`);
            return;
        }
        if (res.status === 502 && body.stage === 'offer') {
            showStatusBanner(template, 'error', t`Could not reach the other device. Check the base URL and that the device is online.`);
            return;
        }
        if (!res.ok && res.status !== 409) {
            showStatusBanner(template, 'error', body.error || `HTTP ${res.status}`);
            return;
        }

        // 409 = PEER_REF_CHANGED, surfaced with retry: true. The simplest
        // recovery is to re-try the whole accept call, which mints a fresh
        // session token and re-walks the peer's HEAD. Auto-retry once.
        if (res.status === 409 && body.retry) {
            showStatusBanner(template, 'warning', t`Peer state changed during sync. Retrying once…`);
            const retry = await fetch(ENDPOINTS.pairAccept, {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const retryBody = await retry.json().catch(() => ({}));
            if (!retry.ok) {
                showStatusBanner(template, 'error', retryBody.error || `HTTP ${retry.status}`);
                return;
            }
            return handleSyncResult(template, payload, retryBody);
        }

        return handleSyncResult(template, payload, body);
    } catch (e) {
        showStatusBanner(template, 'error', String(e.message || e));
    }
}

function handleSyncResult(template, payload, body) {
    if (body.ok === false && Array.isArray(body.conflicts) && body.conflicts.length) {
        showStatusBanner(template, 'warning', t`${body.conflicts.length} file(s) conflict. Pick a version for each below.`);
        renderConflictList(template, body.conflicts);
        template.find('.lanSyncConflictPanel').removeClass('displayNone');
        // Wire Apply now, with closures over payload + body.
        template.find('.lanSyncApplyResolutionsButton').off('click').on('click', async () => {
            const resolutions = collectResolutions(template);
            showStatusBanner(template, 'info', t`Applying resolutions…`);
            const res = await fetch(ENDPOINTS.pairAccept, {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, resolutions }),
            });
            const result = await res.json().catch(() => ({}));
            if (res.ok && result.ok !== false) {
                template.find('.lanSyncConflictPanel').addClass('displayNone');
                showStatusBanner(template, 'success', t`Sync complete.`);
                notifyCredentialsStored(payload);
            } else {
                showStatusBanner(template, 'error', result.error || `HTTP ${res.status}`);
            }
        });
        return;
    }
    if (body.ok) {
        showStatusBanner(template, 'success', t`Synced with ${payload.label || payload.remotePeerId}.`);
        template.find('.lanSyncConflictPanel').addClass('displayNone');
        notifyCredentialsStored(payload);
    }
}

/**
 * Toast the "credentials saved" notice after a successful pair when the
 * user supplied basic-auth fields. The server persists them on the peer
 * entry (file mode 0600) so subsequent Sync now calls don't need them
 * supplied again; surfacing the "Clear credentials" affordance avoids
 * the trap where a user changes their other device's password and gets
 * silent 401s on every sync.
 *
 * No-op when the pair was credential-less, so the notice doesn't fire
 * for a pure-loopback / single-user setup.
 */
function notifyCredentialsStored(payload) {
    if (payload?.peerAuth?.username && payload?.peerAuth?.password) {
        toastr.info(
            t`Credentials saved for this peer. Use 'Clear credentials' on the peer card to remove them.`,
            t`LAN Sync`,
        );
    }
}
