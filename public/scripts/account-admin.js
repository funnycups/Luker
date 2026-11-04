// User management pages of the Account window (admins only): users, new user, overview,
// security, auth & limits, announcements, server plugins, config, storage backend and storage.
import { t, translate } from './i18n.js';
import { ic, esc } from './luker-window.js';
import { POPUP_TYPE, callGenericPopup } from './popup.js';
import { ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';
import { mountStorageInspector } from './storage-inspector.js';
import { formatAnnouncementBody } from './announcements.js';
import { buildStorageBackendCreds } from './admin-storage-backend.js';
import { openDataWindow } from './data-window.js';
import {
    currentUser,
    fetchAdminOverview,
    fetchAdminSettings,
    fetchAnnouncementsAdmin,
    fetchRuntimeConfig,
    fetchServerPlugins,
    fetchStorageBackendStatus,
    fetchUsers,
    getCurrentUser,
    requestAnnouncement,
    requestChangeAvatar,
    requestChangeName,
    requestChangePassword,
    requestCreateUser,
    requestDeleteUser,
    requestInstallPluginDependencies,
    requestInstallServerPlugin,
    requestRemoveServerPlugin,
    requestSaveAdminSettings,
    requestSaveRuntimeConfig,
    requestSetUserAdmin,
    requestSetUserEnabled,
    requestSetUserQuota,
    requestSlugify,
    requestUpdateServerPlugin,
    triggerStorageBackendMigration,
} from './user.js';

const MB = 1024 * 1024;
const BACKEND_MODES = ['fs', 'sqlite', 'mysql', 'postgres'];

const adminTitles = () => ({
    users: t`User management`,
    adminNew: t`New User`,
    adminUserName: t`Change display name`,
    adminUserPassword: t`Change Password`,
    adminUserQuota: t`Storage Quota`,
    adminUserDelete: t`Delete user`,
    adminOverview: t`System Overview`,
    adminSecurity: t`Security Status`,
    adminAuth: t`Auth & Limits`,
    adminNotices: t`Announcements`,
    adminPlugins: t`Server Plugins`,
    adminConfig: t`Runtime Config (config.yaml)`,
    adminBackend: t`Storage Backend`,
    adminStorage: t`Storage Management`,
});

const adminHelp = () => ({
    users: [t`Open a user to change their name, password, quota or role, or to back up their data.`, t`Disabled users can't sign in.`],
    adminUser: [t`If a custom avatar is not set, the user's default persona image will be displayed.`, t`Disabled users can't sign in. Admins can manage all users and the server.`],
    adminUserPassword: [t`Leave the new password blank to remove the password.`],
    adminUserQuota: [t`Default uses the quota for new users set in Auth & Limits.`],
    adminUserDelete: [t`This action is irreversible.`, t`Also wipe user data deletes the user's data folder on the server. Otherwise the folder stays on disk.`],
    adminNew: [t`This will create a new subfolder in the /data/ directory with the user's handle as the folder name.`, t`The handle is used to sign in and can only contain lowercase letters, numbers and dashes.`],
    adminOverview: [t`Storage shows how much space each user's data takes on the server.`],
    adminSecurity: [t`An admin without a password can be signed in to by anyone who can reach the server.`],
    adminAuth: [
        t`When enabled, the login page shows a "Create account" form. New accounts default to non-admin and respect the storage quota above.`,
        t`Separate IDs with commas or new lines. Separate scopes with commas, spaces or new lines; identify is always included.`,
        t`When "Require membership in target server" is enabled, required Discord scopes for server checks are added automatically.`,
    ],
    adminNotices: [t`Announcements are shown to every user. The body supports Markdown.`],
    adminNotice: [t`The body supports Markdown.`],
    adminPlugins: [t`Installing a server plugin grants backend code execution. Install only repositories you trust.`, t`New installs are picked up after backend restart.`],
    adminConfig: [t`Changes are validated as YAML before save. Some settings may require backend restart.`],
    adminBackend: [
        translate('This will copy ALL user data to the target backend and switch the live server to it. A backup is preserved at <dataRoot>/_storage-migrations/ and is NEVER auto-deleted.', 'storageBackendMigrationWarning'),
        translate('MySQL and PostgreSQL share a single schema across users (rows are keyed by handle). When switching to or from a shared backend, the other backend\'s data is left on disk untouched but becomes invisible until you switch back.', 'storageBackendSharedDbWarning'),
        translate('Leave the URL blank to use the value already set in config.yaml (storage.mysql.url / storage.postgres.url).', 'storageBackendDbConfigHint'),
    ],
    adminStorage: [t`Choose a user to see what takes up their storage on the server.`],
});

const ADMIN_VIEWS = new Set([...Object.keys(adminTitles()), 'adminUser', 'adminNotice', 'adminStorageUser']);

const levelLabel = level => ({ critical: t`Critical`, warning: t`Warning` })[level] || t`Info`;
const levelTone = level => ({ critical: 'is-bad', warning: 'is-warn' })[level] || '';
const modeLabel = mode => ({ fs: t`Filesystem`, sqlite: 'SQLite', mysql: 'MySQL', postgres: 'PostgreSQL' })[mode] || mode || '-';
const parseIdList = text => String(text || '').split(/[\n,]/g).map(x => x.trim()).filter(Boolean);
const parseScopeList = text => String(text || '').split(/[\s,]/g).map(x => x.trim().toLowerCase()).filter(Boolean);
const errText = err => err?.message || String(err);

/**
 * Converts the server's admin settings into the Auth & Limits form.
 * @param {any} s Settings from the server
 * @returns {object} Form state
 */
function settingsToForm(s) {
    const quota = Number(s?.storage?.defaultUserQuotaBytes);
    const gh = s?.oauth?.github || {};
    const dc = s?.oauth?.discord || {};
    return {
        unlimited: !(Number.isFinite(quota) && quota >= 0),
        quotaMb: Number.isFinite(quota) && quota >= 0 ? String(Math.floor(quota / MB)) : '',
        registration: Boolean(s?.accountRegistration?.enabled),
        github: { enabled: Boolean(gh.enabled), autoCreate: Boolean(gh.allowAutoCreate), clientId: gh.clientId || '', clientSecret: gh.clientSecret || '' },
        discord: {
            enabled: Boolean(dc.enabled),
            autoCreate: Boolean(dc.allowAutoCreate),
            requireGuild: Boolean(dc.requireGuildMembership),
            clientId: dc.clientId || '',
            clientSecret: dc.clientSecret || '',
            scopes: (dc.scopes || []).join('\n'),
            guilds: (dc.allowedGuildIds || []).join('\n'),
            roles: (dc.requiredRoleIds || []).join('\n'),
        },
    };
}

/**
 * Converts the Auth & Limits form into the payload /settings/save expects.
 * @param {object} f Form state
 * @returns {object} Settings payload
 */
export function formToSettings(f) {
    const mb = Number(f.quotaMb);
    return {
        storage: { defaultUserQuotaBytes: !f.unlimited && String(f.quotaMb).trim() !== '' && Number.isFinite(mb) && mb >= 0 ? Math.floor(mb * MB) : -1 },
        accountRegistration: { enabled: f.registration },
        oauth: {
            github: {
                enabled: f.github.enabled,
                allowAutoCreate: f.github.autoCreate,
                clientId: String(f.github.clientId || '').trim(),
                clientSecret: String(f.github.clientSecret || '').trim(),
            },
            discord: {
                enabled: f.discord.enabled,
                allowAutoCreate: f.discord.autoCreate,
                requireGuildMembership: f.discord.requireGuild,
                clientId: String(f.discord.clientId || '').trim(),
                clientSecret: String(f.discord.clientSecret || '').trim(),
                allowedGuildIds: parseIdList(f.discord.guilds),
                requiredRoleIds: parseIdList(f.discord.roles),
                scopes: parseScopeList(f.discord.scopes),
            },
        },
    };
}

/**
 * Reads a dotted path from an object.
 * @param {object} obj Root
 * @param {string[]} parts Path segments
 * @returns {*} Value
 */
function getPath(obj, parts) {
    return parts.reduce((o, p) => o?.[p], obj);
}

/**
 * Text lines describing a storage migration's counts.
 * @param {object} counts Per-table counts
 * @returns {string} Line
 */
function countsLine(counts) {
    if (!counts) return '';
    return Object.entries(counts).map(([k, v]) => `${k}=${v ?? 0}`).join(' ');
}

/**
 * The User management pages; the Account window delegates its `users` tab to this.
 */
export class AdminPages {
    /**
     * @param {object} w Account window (see account-window.js)
     * @param {object} options
     * @param {(stack: object[]) => void} options.reopen Reopens the Account window on the given user-management page stack
     */
    constructor(w, { reopen }) {
        this.w = w;
        this.reopen = reopen;
        /** @type {Record<string, {data?: any, loading?: boolean, error?: string|null}>} */
        this.res = {};
        this.seg = 'users';
        this.filter = 'all';
        this.busy = new Set();
        this.migrating = false;
        this.migrateResult = null;
        this.pollTimer = null;
        this.slugTimer = null;
    }

    /** Whether a page belongs to user management. */
    owns(view) {
        return ADMIN_VIEWS.has(view);
    }

    get top() {
        return this.w.top;
    }

    /** Name of a long job in progress, if any. */
    get busyJob() {
        return this.migrating ? t`Migrating` : null;
    }

    destroy() {
        clearTimeout(this.pollTimer);
        clearTimeout(this.slugTimer);
        this.pollTimer = null;
    }

    // ---------- data ----------

    loaders() {
        return {
            users: fetchUsers,
            overview: fetchAdminOverview,
            settings: fetchAdminSettings,
            plugins: fetchServerPlugins,
            config: fetchRuntimeConfig,
            backend: fetchStorageBackendStatus,
            notices: fetchAnnouncementsAdmin,
        };
    }

    /**
     * Returns a resource, starting its first load.
     * @param {string} key Resource name
     * @returns {{data?: any, loading?: boolean, error?: string|null}} Resource state
     */
    need(key) {
        const r = this.res[key] ??= {};
        if (r.data === undefined && !r.loading && !r.error) this.load(key);
        return r;
    }

    /**
     * (Re)loads a resource and redraws the page once it arrives.
     * @param {string} key Resource name
     * @returns {Promise<void>}
     */
    async load(key) {
        const r = this.res[key] ??= {};
        r.loading = true;
        r.error = null;
        try {
            r.data = await this.loaders()[key]();
        } catch (err) {
            r.error = errText(err);
        } finally {
            r.loading = false;
            if (key === 'backend') this.watchMigration();
            this.redraw();
        }
    }

    /** Forgets loaded data so the next visit reloads it. */
    stale(...keys) {
        for (const key of keys) delete this.res[key];
    }

    /** Redraws the page if user management is on screen. */
    redraw() {
        if (this.w.root.isConnected && this.w.tab === 'users' && this.owns(this.top.view)) this.w.rerender();
    }

    /**
     * Placeholder while a resource loads or after it failed.
     * @param {string} key Resource name
     * @returns {string} Markup, or '' when the data is ready
     */
    state(key) {
        const r = this.need(key);
        if (r.error) {
            return `<div class="dw-banner error">${ic('x')}<span>${esc(r.error)}</span><button class="dw-btn sm" data-act="adm-reload" data-key="${key}">${t`Retry`}</button></div>`;
        }
        if (r.data === undefined) return `<div class="dw-empty"><span class="dw-card-icon">${ic('sync', 'dw-spin')}</span></div>`;
        return '';
    }

    user(handle) {
        return (this.res.users?.data || []).find(u => u.handle === handle);
    }

    get isSelf() {
        return this.top.handle === currentUser?.handle;
    }

    // ---------- page hooks ----------

    title() {
        const tp = this.top;
        if (tp.view === 'adminUser') return this.user(tp.handle)?.name || tp.handle;
        if (tp.view === 'adminNotice') return tp.id ? t`Edit announcement` : t`New announcement`;
        if (tp.view === 'adminStorageUser') return tp.target === '__all__' ? t`All Users` : tp.target;
        return adminTitles()[tp.view] || '';
    }

    help() {
        return adminHelp()[this.top.view === 'adminStorageUser' ? 'adminStorage' : this.top.view] || [];
    }

    headExtra() {
        const reload = key => `<button class="dw-ibtn" data-act="adm-reload" data-key="${key}" title="${t`Refresh`}">${ic('sync', this.res[key]?.loading ? 'dw-spin' : '')}</button>`;
        switch (this.top.view) {
            case 'users':
                return this.seg === 'users'
                    ? `${reload('users')}<button class="dw-btn primary sm" data-act="adm-push" data-view="adminNew">${ic('plus')}${t`New User`}</button>`
                    : '';
            case 'adminOverview':
            case 'adminSecurity':
            case 'adminStorage':
                return reload('overview');
            case 'adminPlugins': return reload('plugins');
            case 'adminBackend': return this.migrating ? '' : reload('backend');
            case 'adminConfig': return `<button class="dw-btn sm" data-act="adm-config-reload">${ic('sync')}${t`Reload`}</button>`;
            case 'adminNotices': return `<button class="dw-btn primary sm" data-act="adm-push" data-view="adminNotice">${ic('plus')}${t`New announcement`}</button>`;
        }
        return '';
    }

    render() {
        switch (this.top.view) {
            case 'users': return this.viewRoot();
            case 'adminUser': return this.viewUser();
            case 'adminUserName': return this.viewUserName();
            case 'adminUserPassword': return this.viewUserPassword();
            case 'adminUserQuota': return this.viewUserQuota();
            case 'adminUserDelete': return this.viewUserDelete();
            case 'adminNew': return this.viewNew();
            case 'adminOverview': return this.viewOverview();
            case 'adminSecurity': return this.viewSecurity();
            case 'adminAuth': return this.viewAuth();
            case 'adminNotices': return this.viewNotices();
            case 'adminNotice': return this.viewNotice();
            case 'adminPlugins': return this.viewPlugins();
            case 'adminConfig': return this.viewConfig();
            case 'adminBackend': return this.viewBackend();
            case 'adminStorage': return this.viewStorage();
            case 'adminStorageUser': return this.viewStorageUser();
        }
        return '';
    }

    afterRender() {
        const slot = this.w.root.querySelector('[data-region="adm-inspector"]');
        if (slot) this.mountInspector(slot);
        const preview = this.w.root.querySelector('[data-region="adm-preview"]');
        if (preview) preview.innerHTML = formatAnnouncementBody(this.top.form?.body || '');
    }

    // ---------- shared bits ----------

    /**
     * Option row that opens a user-management sub-page, keeping the current page's handle.
     * @param {string} view Page to open
     * @param {string} icon Icon key
     * @param {string} title Label
     * @param {string} [tone] Colour: blue, amber or red
     * @returns {string} Markup
     */
    option(view, icon, title, tone = '') {
        return `<button class="dw-option ${tone}" data-act="adm-push" data-view="${view}">
            <span class="dw-card-icon">${ic(icon)}</span><b>${esc(title)}</b>${ic('chev')}</button>`;
    }

    toggle(path, on, label) {
        return `<button class="dw-toggle${on ? ' on' : ''}" data-act="adm-toggle" data-path="${path}" type="button"><span class="dw-sw"></span>${esc(label)}</button>`;
    }

    field(label, model, value, attrs = '') {
        return `<label class="dw-field"><span>${esc(label)}</span><input class="dw-inp" data-model="${model}" value="${esc(value)}" autocomplete="off" ${attrs}></label>`;
    }

    area(label, model, value, attrs = '') {
        return `<label class="dw-field"><span>${esc(label)}</span><textarea class="dw-inp" data-model="${model}" spellcheck="false" ${attrs}>${esc(value)}</textarea></label>`;
    }

    /** Pushes a page for the user shown on the current page. */
    pushFor(view, params = {}) {
        this.w.push(view, { handle: this.top.handle, ...params });
    }

    /** Leaves every sub-page and shows the user list. */
    toRoot() {
        this.w.stack.users.length = 1;
        this.w.shownPw.clear();
        this.w.render();
    }

    /**
     * Runs a request with a busy flag, toasting the outcome.
     * @param {string} key Busy key (disables the matching button)
     * @param {() => Promise<string|void>} fn Request; resolves to the success text
     */
    async act(key, fn) {
        if (this.busy.has(key)) return;
        this.busy.add(key);
        this.redraw();
        try {
            const text = await fn();
            if (text) this.w.toast(text);
        } catch (err) {
            this.w.toast(errText(err), true);
        } finally {
            this.busy.delete(key);
            this.redraw();
        }
    }

    busyCls(key) {
        return this.busy.has(key) ? ' busy' : '';
    }

    busyIc(key, icon) {
        return this.busy.has(key) ? ic('sync', 'dw-spin') : ic(icon);
    }

    // ---------- root: users / server ----------

    viewRoot() {
        const seg = (key, icon, label) => `<button class="${this.seg === key ? 'on' : ''}" data-act="adm-seg" data-seg="${key}" role="tab" aria-selected="${this.seg === key}">${ic(icon)}${label}</button>`;
        const head = `<div class="dw-seg" role="tablist">${seg('users', 'users', t`Users`)}${seg('server', 'server', t`Server`)}</div>`;
        if (this.seg === 'server') {
            return `${head}
                <div class="dw-options">
                    ${this.option('adminOverview', 'pie', t`System Overview`)}
                    ${this.option('adminSecurity', 'shield', t`Security Status`)}
                    ${this.option('adminAuth', 'key', t`Auth & Limits`)}
                    ${this.option('adminNotices', 'chat', t`Announcements`)}
                    ${this.option('adminStorage', 'db', t`Storage Management`)}
                </div>
                <div class="dw-options">
                    ${this.option('adminPlugins', 'branch', t`Server Plugins`, 'blue')}
                    ${this.option('adminConfig', 'edit', t`Config`, 'blue')}
                    ${this.option('adminBackend', 'server', t`Storage Backend`, 'amber')}
                </div>`;
        }
        const tp = this.top;
        tp.query ??= '';
        const users = this.res.users?.data || [];
        const counts = {
            all: users.length,
            enabled: users.filter(u => u.enabled).length,
            disabled: users.filter(u => !u.enabled).length,
            admin: users.filter(u => u.admin).length,
        };
        const chip = (key, label) => `<button class="dw-chip${this.filter === key ? ' on' : ''}" data-act="adm-filter" data-filter="${key}">${label}<span class="dw-count">${counts[key]}</span></button>`;
        return `${head}
            <div class="dw-adm-bar">
                <input class="dw-inp" type="search" data-model="top.query" data-adm-input="users" value="${esc(tp.query)}" placeholder="${t`Search users...`}" autocomplete="off">
                <div class="dw-chips">${chip('all', t`All`)}${chip('enabled', t`Enabled`)}${chip('disabled', t`Disabled`)}${chip('admin', t`Admins`)}</div>
            </div>
            ${this.state('users') || `<div class="dw-cards" data-region="adm-users">${this.userCards()}</div>`}`;
    }

    userCards() {
        const q = String(this.top.query || '').trim().toLowerCase();
        const list = (this.res.users?.data || []).filter(u => {
            if (this.filter === 'enabled' && !u.enabled) return false;
            if (this.filter === 'disabled' && u.enabled) return false;
            if (this.filter === 'admin' && !u.admin) return false;
            return !q || u.handle.toLowerCase().includes(q) || String(u.name || '').toLowerCase().includes(q);
        });
        if (!list.length) return `<div class="dw-empty"><span class="dw-card-icon">${ic('users')}</span><b>${t`No matching users`}</b></div>`;
        return list.map(u => `
            <button class="dw-card dw-adm-user" data-state="${u.enabled ? 'ok' : 'off'}" data-act="adm-user" data-handle="${esc(u.handle)}">
                <span class="dw-avatar sm"><img src="${esc(u.avatar)}" alt=""></span>
                <div class="dw-card-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(u.name)}</span><span class="dw-kind">${esc(u.handle)}</span></div>
                    <div class="dw-card-meta">${this.userTags(u)}</div>
                </div>
                ${ic('chev', 'dw-adm-chev')}
            </button>`).join('');
    }

    userTags(u) {
        const tags = [];
        if (u.admin) tags.push(`<span class="dw-pilltag is-ok">${ic('shield')}${t`Admin`}</span>`);
        if (!u.enabled) tags.push(`<span class="dw-pilltag is-bad">${t`Disabled`}</span>`);
        if (!u.password) tags.push(`<span class="dw-pilltag${u.admin ? ' is-warn' : ''}">${ic('unlock')}${t`No password`}</span>`);
        for (const p of u.oauthProviders || []) tags.push(`<span class="dw-pilltag">${esc(p)}</span>`);
        if (u.handle === currentUser?.handle) tags.push(`<span class="dw-pilltag">${t`You`}</span>`);
        return tags.join('');
    }

    // ---------- user detail ----------

    viewUser() {
        const wait = this.state('users');
        if (wait) return wait;
        const u = this.user(this.top.handle);
        if (!u) return `<div class="dw-empty"><span class="dw-card-icon">${ic('user')}</span><b>${t`This user no longer exists`}</b></div>`;
        const quota = u.storageQuotaBytes == null ? t`Default` : humanFileSize(Number(u.storageQuotaBytes));
        const oauth = u.oauthProviders?.length ? u.oauthProviders.map(esc).join(', ') : t`None`;
        const password = u.password
            ? `<span class="dw-pilltag is-ok">${ic('lock')}${t`Set`}</span>`
            : `<span class="dw-pilltag is-warn">${ic('unlock')}${t`Not set`}</span>`;
        const self = this.isSelf;
        return `
            <div class="dw-profile">
                <span class="dw-avatar"><img src="${esc(u.avatar)}" alt=""></span>
                <div class="dw-profile-main">
                    <div class="dw-profile-name">${esc(u.name)}</div>
                    <div class="dw-card-meta">${this.userTags(u)}</div>
                </div>
                <div class="dw-profile-act">
                    <button class="dw-btn sm${this.busyCls('avatar')}" data-act="adm-avatar-pick">${this.busyIc('avatar', 'image')}${t`Change avatar`}</button>
                    <button class="dw-btn sm icon" data-act="adm-avatar-remove" title="${t`Remove a custom avatar.`}">${ic('trash')}</button>
                </div>
                <input type="file" accept="image/*" data-role="adm-avatar" hidden>
            </div>
            <div class="dw-list">
                <div class="dw-setrow"><span>${t`Handle`}</span><span class="dw-setrow-val">${esc(u.handle)}</span></div>
                <div class="dw-setrow"><span>${t`Created`}</span><span class="dw-setrow-val">${esc(new Date(u.created).toLocaleString())}</span></div>
                <div class="dw-setrow"><span>${t`Password`}</span><span class="dw-setrow-val">${password}</span></div>
                <div class="dw-setrow"><span>${t`Storage Quota`}</span><span class="dw-setrow-val">${esc(quota)}</span></div>
                <div class="dw-setrow"><span>OAuth</span><span class="dw-setrow-val">${oauth}</span></div>
            </div>
            <div class="dw-group">
                ${this.userSwitch('enabled', u.enabled, t`Enabled`)}
                ${this.userSwitch('admin', u.admin, t`Admin`)}
            </div>
            <div class="dw-options">
                ${this.option('adminUserName', 'edit', t`Change display name`)}
                ${this.option('adminUserPassword', 'key', t`Change Password`)}
                ${this.option('adminUserQuota', 'pie', t`Storage Quota`)}
                <button class="dw-option blue" data-act="adm-data"><span class="dw-card-icon">${ic('download')}</span><b>${t`Backup, restore and migration`}</b>${ic('chev')}</button>
            </div>
            ${self ? '' : `<div class="dw-options">${this.option('adminUserDelete', 'trash', t`Delete user`, 'red')}</div>`}`;
    }

    userSwitch(kind, on, label) {
        const key = `${kind}:${this.top.handle}`;
        return `<button class="dw-toggle${on ? ' on' : ''}${this.busyCls(key)}" data-act="adm-switch" data-kind="${kind}" type="button"><span class="dw-sw"></span>${esc(label)}</button>`;
    }

    /**
     * Flips a user's enabled or admin flag; turning one off asks first.
     * @param {'enabled'|'admin'} kind Flag
     */
    async userSwitchGo(kind) {
        const handle = this.top.handle;
        const u = this.user(handle);
        if (!u) return;
        const next = !u[kind];
        const self = handle === currentUser?.handle;
        if (!next) {
            const ok = await this.w.confirm(kind === 'enabled'
                ? { title: t`Disable ${u.name}?`, text: self ? t`You will be signed out and can't sign in again until another admin enables your account.` : t`${u.name} won't be able to sign in until the account is enabled again.`, ok: t`Disable`, danger: true }
                : { title: t`Demote ${u.name} to a regular user?`, text: self ? t`You will lose access to user management.` : t`${u.name} will no longer be able to manage users or the server.`, ok: t`Demote`, danger: true });
            if (!ok) return;
        }
        await this.act(`${kind}:${handle}`, async () => {
            if (kind === 'enabled') await requestSetUserEnabled(handle, next);
            else await requestSetUserAdmin(handle, next);
            u[kind] = next;
            this.load('users');
            this.stale('overview');
            if (self) getCurrentUser();
            if (kind === 'enabled') return next ? t`User enabled` : t`User disabled`;
            return next ? t`Promoted to admin` : t`Demoted to regular user`;
        });
    }

    async uploadAvatar(file) {
        const handle = this.top.handle;
        await this.act('avatar', async () => {
            const cropImage = await getBase64Async(await ensureImageFormatSupported(file));
            // The crop popup opens above this window.
            const cropped = await callGenericPopup(t`Set the crop position of the avatar image`, POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage });
            if (!cropped) return;
            await requestChangeAvatar(handle, String(cropped));
            await this.load('users');
            if (handle === currentUser?.handle) await getCurrentUser();
            return t`Avatar updated`;
        });
    }

    async removeAvatar() {
        const handle = this.top.handle;
        await this.act('avatar', async () => {
            await requestChangeAvatar(handle, '');
            await this.load('users');
            if (handle === currentUser?.handle) await getCurrentUser();
            return t`Avatar removed`;
        });
    }

    /** Backup, restore and migration for the user shown, in the Account window. */
    async openUserData() {
        const handle = this.top.handle;
        if (handle === currentUser?.handle) return this.w.navigate({ tab: 'backup' });
        const stack = this.w.stack.users;
        // Opening another user's data replaces this window; come back here once it closes.
        await openDataWindow({ tab: 'backup', handle });
        this.reopen(stack);
    }

    // ---------- user sub-pages ----------

    viewUserName() {
        const tp = this.top;
        tp.name ??= this.user(tp.handle)?.name || '';
        return `
            ${this.field(t`Display name`, 'top.name', tp.name)}
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-name-save">${this.w.busyIcon('check')}${t`Save`}</button>`)}`;
    }

    async nameSave() {
        const tp = this.top;
        const name = String(tp.name || '').trim();
        if (!name) return this.w.formError(t`Enter a display name`);
        await this.w.runForm(async () => {
            await requestChangeName(tp.handle, name);
            await this.load('users');
            if (tp.handle === currentUser?.handle) await getCurrentUser();
            this.w.pop();
            this.w.toast(t`Name changed`);
        });
    }

    viewUserPassword() {
        const tp = this.top;
        tp.form ??= { next: '', confirm: '' };
        return `
            <div class="dw-grid2">
                <label class="dw-field"><span>${t`New password`}</span>${this.w.pw('top.form.next', tp.form.next, t`[ No password ]`)}</label>
                <label class="dw-field"><span>${t`Confirm new password`}</span>${this.w.pw('top.form.confirm', tp.form.confirm, t`[ No password ]`)}</label>
            </div>
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-password-save">${this.w.busyIcon('key')}${t`Change Password`}</button>`)}`;
    }

    async passwordSave() {
        const tp = this.top;
        const f = tp.form;
        if (f.next !== f.confirm) return this.w.formError(t`Passwords do not match`);
        if (!f.next && this.user(tp.handle)?.password && !await this.w.confirm({
            title: t`Remove the password?`,
            text: t`Anyone who can open this server will be able to sign in to this account.`,
            ok: t`Remove password`,
            danger: true,
        })) return;
        await this.w.runForm(async () => {
            await requestChangePassword(tp.handle, '', f.next);
            await this.load('users');
            this.stale('overview');
            this.w.pop();
            this.w.toast(f.next ? t`Password changed` : t`Password removed`);
        });
    }

    viewUserQuota() {
        const tp = this.top;
        const u = this.user(tp.handle);
        tp.mode ??= u?.storageQuotaBytes == null ? 'default' : 'custom';
        tp.mb ??= u?.storageQuotaBytes == null ? '' : String(Math.floor(Number(u.storageQuotaBytes) / MB));
        const used = (this.need('overview').data?.users || []).find(x => x.handle === tp.handle);
        const radio = (mode, label) => `<button class="dw-radio${tp.mode === mode ? ' on' : ''}" data-act="adm-quota-mode" data-mode="${mode}"><span class="dw-ring"></span><span>${label}</span></button>`;
        return `
            ${used ? `<div class="dw-list"><div class="dw-setrow"><span>${t`Used`}</span><span class="dw-setrow-val">${esc(humanFileSize(used.storageBytes || 0))} / ${esc(used.storageQuotaBytes >= 0 ? humanFileSize(used.storageQuotaBytes) : t`Unlimited`)}</span></div></div>` : ''}
            <div class="dw-radios">${radio('default', t`Default`)}${radio('custom', t`Custom`)}</div>
            ${tp.mode === 'custom' ? `<div class="dw-list"><div class="dw-setrow"><span>${t`Quota`}</span>
                <span class="dw-num"><input class="dw-inp num" type="number" min="0" step="1" data-model="top.mb" value="${esc(tp.mb)}"><span class="dw-unit">MB</span></span></div></div>` : ''}
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-quota-save">${this.w.busyIcon('check')}${t`Save`}</button>`)}`;
    }

    async quotaSave() {
        const tp = this.top;
        let bytes = null;
        if (tp.mode === 'custom') {
            const mb = Number(tp.mb);
            if (String(tp.mb).trim() === '' || !Number.isFinite(mb) || mb < 0) return this.w.formError(t`Please enter a valid number.`);
            bytes = Math.floor(mb * MB);
        }
        await this.w.runForm(async () => {
            await requestSetUserQuota(tp.handle, bytes);
            await this.load('users');
            this.stale('overview');
            this.w.pop();
            this.w.toast(t`Quota saved`);
        });
    }

    viewUserDelete() {
        const tp = this.top;
        tp.confirmHandle ??= '';
        tp.purge ??= false;
        return `
            <div class="dw-banner error">${ic('warn')}<span>${t`Deleting ${esc(tp.handle)}. This action is irreversible.`}</span></div>
            <div class="dw-group">${this.toggle('top.purge', tp.purge, t`Also wipe user data.`)}</div>
            ${this.field(t`Type the user's handle to confirm`, 'top.confirmHandle', tp.confirmHandle, `placeholder="${esc(tp.handle)}"`)}
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn danger solid big${tp.busy ? ' busy' : ''}" data-act="adm-delete-go">${this.w.busyIcon('trash')}${t`Delete user`}</button>`)}`;
    }

    async deleteGo() {
        const tp = this.top;
        if (tp.handle === currentUser?.handle) return this.w.formError(t`Cannot delete yourself`);
        if (String(tp.confirmHandle).trim() !== tp.handle) return this.w.formError(t`Handles do not match`);
        await this.w.runForm(async () => {
            await requestDeleteUser(tp.handle, !!tp.purge);
            this.stale('overview');
            await this.load('users');
            this.toRoot();
            this.w.toast(t`User deleted`);
        });
    }

    // ---------- new user ----------

    viewNew() {
        const tp = this.top;
        tp.form ??= { name: '', handle: '', password: '', confirm: '' };
        const f = tp.form;
        return `
            <div class="dw-grid2">
                ${this.field(t`Display name`, 'top.form.name', f.name, `data-adm-input="new-name" placeholder="${t`e.g. John Snow`}"`)}
                <label class="dw-field"><span>${t`Handle`}</span><input class="dw-inp mono" data-model="top.form.handle" data-adm-input="new-handle" value="${esc(f.handle)}" placeholder="john-snow" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
            </div>
            <div class="dw-grid2">
                <label class="dw-field"><span>${t`Password`}</span>${this.w.pw('top.form.password', f.password, t`[ No password ]`)}</label>
                <label class="dw-field"><span>${t`Confirm Password`}</span>${this.w.pw('top.form.confirm', f.confirm, t`[ No password ]`)}</label>
            </div>
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-create">${this.w.busyIcon('plus')}${t`Create`}</button>`)}`;
    }

    /** Fills the handle from the display name until the admin edits the handle. */
    suggestHandle() {
        const tp = this.top;
        if (tp.handleTouched) return;
        clearTimeout(this.slugTimer);
        const name = tp.form.name;
        this.slugTimer = setTimeout(async () => {
            let slug = '';
            try {
                slug = name.trim() ? await requestSlugify(name) : '';
            } catch {
                return;
            }
            if (this.top !== tp || tp.handleTouched || tp.form.name !== name) return;
            tp.form.handle = slug;
            const input = this.w.root.querySelector('[data-adm-input="new-handle"]');
            if (input) input.value = slug;
        }, 250);
    }

    async createGo() {
        const f = this.top.form;
        const handle = f.handle.trim();
        if (!f.name.trim()) return this.w.formError(t`Enter a display name`);
        if (!handle) return this.w.formError(t`Handle is required`);
        if (!/^[a-z0-9-]+$/.test(handle)) return this.w.formError(t`The handle can only contain lowercase letters, numbers and dashes`);
        if (f.password !== f.confirm) return this.w.formError(t`Passwords do not match`);
        await this.w.runForm(async () => {
            await requestCreateUser({ name: f.name.trim(), handle, password: f.password });
            this.stale('overview');
            this.seg = 'users';
            await this.load('users');
            this.toRoot();
            this.w.toast(t`User created`);
        });
    }

    // ---------- overview & security ----------

    viewOverview() {
        const wait = this.state('overview');
        if (wait) return wait;
        const o = this.res.overview.data;
        const up = o.server?.uptimeSec || 0;
        const quota = Number(o.settings?.storage?.defaultUserQuotaBytes);
        const tot = o.totals || {};
        const tile = (label, value, bad = false) => `<div class="dw-adm-tile${bad ? ' bad' : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
        return `
            <section class="dw-sec"><div class="dw-sec-title">${t`Server Snapshot`}</div>
                <div class="dw-list">
                    <div class="dw-setrow"><span>Node.js</span><span class="dw-setrow-val">${esc(o.server?.nodeVersion || '-')}</span></div>
                    <div class="dw-setrow"><span>${t`Platform`}</span><span class="dw-setrow-val">${esc(o.server?.platform || '-')}</span></div>
                    <div class="dw-setrow"><span>${t`Uptime`}</span><span class="dw-setrow-val">${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m</span></div>
                    <div class="dw-setrow"><span>${t`Server time`}</span><span class="dw-setrow-val">${esc(o.server?.now ? new Date(o.server.now).toLocaleString() : '-')}</span></div>
                </div>
            </section>
            <div class="dw-adm-tiles">
                ${tile(t`Users`, tot.users ?? 0)}
                ${tile(t`Enabled`, tot.enabledUsers ?? 0)}
                ${tile(t`Admins`, tot.adminUsers ?? 0)}
                ${tile(t`Password protected`, tot.protectedUsers ?? 0)}
                ${tile(t`Total storage`, humanFileSize(tot.storageBytes ?? 0))}
                ${tile(t`Over quota`, tot.overQuotaUsers ?? 0, tot.overQuotaUsers > 0)}
                ${tile(t`Default quota`, Number.isFinite(quota) && quota >= 0 ? humanFileSize(quota) : t`Unlimited`)}
            </div>
            <section class="dw-sec"><div class="dw-sec-title">${t`User Storage`}</div>
                <div class="dw-list">${(o.users || []).map(u => this.storageRow(u)).join('')}</div>
            </section>`;
    }

    storageRow(u) {
        const ratio = Number.isFinite(Number(u.storageUsageRatio)) && u.storageUsageRatio !== null ? Number(u.storageUsageRatio) : null;
        const over = ratio !== null && ratio > 1;
        return `
            <button class="dw-adm-row" data-act="adm-user" data-handle="${esc(u.handle)}">
                <div class="dw-adm-row-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(u.name)}</span><span class="dw-kind">${esc(u.handle)}</span></div>
                    <div class="dw-card-meta">
                        <span class="dw-pilltag${u.admin ? ' is-ok' : ''}">${u.admin ? t`Admin` : t`User`}</span>
                        ${u.enabled ? '' : `<span class="dw-pilltag is-bad">${t`Disabled`}</span>`}
                        ${ratio !== null ? `<span${over ? ' class="bad"' : ''}>${t`${(ratio * 100).toFixed(1)}% of quota`}</span>` : ''}
                    </div>
                    ${ratio !== null ? `<div class="dw-adm-meter${over ? ' bad' : ''}"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></i></div>` : ''}
                </div>
                <span class="dw-adm-size">${esc(humanFileSize(u.storageBytes || 0))} / ${esc(u.storageQuotaBytes >= 0 ? humanFileSize(u.storageQuotaBytes) : t`Unlimited`)}</span>
            </button>`;
    }

    viewSecurity() {
        const wait = this.state('overview');
        if (wait) return wait;
        const s = this.res.overview.data.security || {};
        const row = (label, handles) => `
            <div class="dw-setrow dw-adm-secrow"><span>${esc(label)}</span>
                <span class="dw-setrow-val">${handles?.length
        ? `<span class="dw-chips">${handles.map(h => `<button class="dw-chip" data-act="adm-user" data-handle="${esc(h)}">${esc(h)}</button>`).join('')}</span>`
        : `<span class="dw-pilltag is-ok">${ic('check')}${t`None`}</span>`}</span>
            </div>`;
        const risky = (s.adminWithoutPassword || []).length + (s.disabledAdmins || []).length;
        return `
            ${risky ? `<div class="dw-banner warning">${ic('warn')}<span>${t`${risky} issues need attention`}</span></div>` : `<div class="dw-banner">${ic('shield')}<span>${t`No issues found`}</span></div>`}
            <div class="dw-list">
                ${row(t`Admins without password`, s.adminWithoutPassword)}
                ${row(t`Disabled admins`, s.disabledAdmins)}
                ${row(t`Disabled users`, s.disabledUsers)}
            </div>`;
    }

    // ---------- auth & limits ----------

    viewAuth() {
        const wait = this.state('settings');
        if (wait) return wait;
        const tp = this.top;
        tp.form ??= settingsToForm(this.res.settings.data);
        const f = tp.form;
        const gh = f.github;
        const dc = f.discord;
        return `
            <div class="dw-group">
                <div class="dw-sec-title">${ic('pie')}${t`Storage Quota`}</div>
                ${this.toggle('top.form.unlimited', f.unlimited, t`Unlimited storage for new users`)}
                ${f.unlimited ? '' : `<div class="dw-setrow dw-adm-inline"><span>${t`Default quota for new users (MB)`}</span>
                    <span class="dw-num"><input class="dw-inp num" type="number" min="0" step="1" data-model="top.form.quotaMb" value="${esc(f.quotaMb)}"><span class="dw-unit">MB</span></span></div>`}
            </div>
            <div class="dw-group">
                <div class="dw-sec-title">${ic('user')}${t`Account Registration`}</div>
                ${this.toggle('top.form.registration', f.registration, t`Allow visitors to register accounts from the login page`)}
            </div>
            <div class="dw-group">
                <div class="dw-sec-title">${ic('link')}${t`GitHub OAuth`}</div>
                ${this.toggle('top.form.github.enabled', gh.enabled, t`Enable GitHub OAuth login`)}
                ${this.toggle('top.form.github.autoCreate', gh.autoCreate, t`Auto-create user on first GitHub login`)}
                <div class="dw-grid2">
                    ${this.field(t`GitHub Client ID`, 'top.form.github.clientId', gh.clientId, 'spellcheck="false"')}
                    <label class="dw-field"><span>${t`GitHub Client Secret`}</span>${this.w.pw('top.form.github.clientSecret', gh.clientSecret, '', 'off')}</label>
                </div>
            </div>
            <div class="dw-group">
                <div class="dw-sec-title">${ic('chat')}${t`Discord OAuth`}</div>
                ${this.toggle('top.form.discord.enabled', dc.enabled, t`Enable Discord OAuth login`)}
                ${this.toggle('top.form.discord.autoCreate', dc.autoCreate, t`Auto-create user on first Discord login`)}
                ${this.toggle('top.form.discord.requireGuild', dc.requireGuild, t`Require membership in target server`)}
                <div class="dw-grid2">
                    ${this.field(t`Discord Client ID`, 'top.form.discord.clientId', dc.clientId, 'spellcheck="false"')}
                    <label class="dw-field"><span>${t`Discord Client Secret`}</span>${this.w.pw('top.form.discord.clientSecret', dc.clientSecret, '', 'off')}</label>
                </div>
                ${this.area(t`Extra OAuth scopes`, 'top.form.discord.scopes', dc.scopes, 'rows="2"')}
                ${this.area(t`Allowed server IDs`, 'top.form.discord.guilds', dc.guilds, 'rows="2"')}
                ${this.area(t`Required role IDs`, 'top.form.discord.roles', dc.roles, 'rows="2"')}
            </div>
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-auth-save">${this.w.busyIcon('check')}${t`Save`}</button>`)}`;
    }

    async authSave() {
        const tp = this.top;
        const f = tp.form;
        if (!f.unlimited) {
            const mb = Number(f.quotaMb);
            if (String(f.quotaMb).trim() === '' || !Number.isFinite(mb) || mb < 0) return this.w.formError(t`Please enter a valid number.`);
        }
        await this.w.runForm(async () => {
            const saved = await requestSaveAdminSettings(formToSettings(f));
            this.res.settings = { data: saved };
            tp.form = settingsToForm(saved);
            this.stale('overview');
            this.w.toast(t`Admin settings saved.`);
        });
    }

    // ---------- announcements ----------

    viewNotices() {
        const wait = this.state('notices');
        if (wait) return wait;
        const items = this.res.notices.data;
        if (!items.length) return `<div class="dw-empty"><span class="dw-card-icon">${ic('chat')}</span><b>${t`No announcements yet`}</b></div>`;
        return `<div class="dw-cards">${items.map(n => `
            <div class="dw-card" data-state="${n.level === 'critical' ? 'error' : n.level === 'warning' ? 'attention' : 'ok'}">
                <span class="dw-card-icon">${ic(n.level === 'info' ? 'chat' : 'warn')}</span>
                <div class="dw-card-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(n.title)}</span></div>
                    <div class="dw-card-meta"><span class="dw-pilltag ${levelTone(n.level)}">${levelLabel(n.level)}</span><span>${esc(new Date(n.createdAt).toLocaleString())}</span></div>
                </div>
                <div class="dw-card-act">
                    <button class="dw-ibtn" data-act="adm-notice-edit" data-id="${esc(n.id)}" title="${t`Edit`}">${ic('edit')}</button>
                    <button class="dw-ibtn dw-adm-danger${this.busyCls(`notice:${n.id}`)}" data-act="adm-notice-delete" data-id="${esc(n.id)}" title="${t`Delete`}">${this.busyIc(`notice:${n.id}`, 'trash')}</button>
                </div>
            </div>`).join('')}</div>`;
    }

    viewNotice() {
        const tp = this.top;
        if (!tp.form) {
            const n = tp.id ? (this.res.notices?.data || []).find(x => x.id === tp.id) : null;
            tp.form = { level: n?.level || 'info', title: n?.title || '', body: n?.body || '' };
        }
        const f = tp.form;
        const level = (key) => `<button class="dw-chip${f.level === key ? ' on' : ''}" data-act="adm-notice-level" data-level="${key}">${levelLabel(key)}</button>`;
        return `
            <div class="dw-field"><span>${t`Level`}</span><div class="dw-chips">${level('info')}${level('warning')}${level('critical')}</div></div>
            ${this.field(t`Title`, 'top.form.title', f.title, 'maxlength="200"')}
            ${this.area(t`Body (Markdown)`, 'top.form.body', f.body, 'rows="10" maxlength="10000" data-adm-input="notice-body"')}
            <section class="dw-sec"><div class="dw-sec-title">${t`Preview`}</div><div class="dw-adm-preview" data-region="adm-preview"></div></section>
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-notice-save">${this.w.busyIcon('check')}${tp.id ? t`Save` : t`Create`}</button>`)}`;
    }

    async noticeSave() {
        const tp = this.top;
        const f = tp.form;
        if (!f.title.trim()) return this.w.formError(t`Enter a title`);
        await this.w.runForm(async () => {
            const payload = { level: f.level, title: f.title, body: f.body };
            await requestAnnouncement(tp.id ? 'update' : 'create', tp.id ? { id: tp.id, ...payload } : payload);
            await this.load('notices');
            this.w.pop();
            this.w.toast(tp.id ? t`Announcement updated.` : t`Announcement created.`);
        });
    }

    async noticeDelete(id) {
        const n = (this.res.notices?.data || []).find(x => x.id === id);
        if (!n) return;
        const ok = await this.w.confirm({ title: t`Delete announcement "${n.title}"? This cannot be undone.`, ok: t`Delete`, danger: true });
        if (!ok) return;
        await this.act(`notice:${id}`, async () => {
            await requestAnnouncement('delete', { id });
            await this.load('notices');
            return t`Announcement deleted.`;
        });
    }

    // ---------- server plugins ----------

    viewPlugins() {
        const wait = this.state('plugins');
        if (wait) return wait;
        const p = this.res.plugins.data;
        const tp = this.top;
        tp.repo ??= '';
        const plugins = Array.isArray(p.plugins) ? p.plugins : [];
        return `
            ${p.enabled ? '' : `<div class="dw-banner warning">${ic('warn')}<span>${t`Server plugins are currently disabled in config.`} ${t`Installed plugins will load after you enable them and restart the backend.`}</span></div>`}
            <div class="dw-list">
                <div class="dw-setrow"><span>${t`Install path`}</span><span class="dw-setrow-val mono">${esc(p.pluginsPath || '-')}</span></div>
                <div class="dw-setrow"><span>${t`Installed directories`}</span><span class="dw-setrow-val">${plugins.length}</span></div>
            </div>
            <div class="dw-linkbox">
                <input class="dw-inp mono" data-model="top.repo" value="${esc(tp.repo)}" placeholder="${t`Git repository URL`}" autocomplete="off" spellcheck="false">
                <button class="dw-btn primary${this.busyCls('install')}" data-act="adm-plugin-install">${this.busyIc('install', 'download')}${t`Install`}</button>
            </div>
            ${plugins.length ? `<div class="dw-cards">${plugins.map(pl => this.pluginCard(pl)).join('')}</div>`
        : `<div class="dw-empty"><span class="dw-card-icon">${ic('branch')}</span><b>${t`No server plugins installed.`}</b></div>`}`;
    }

    pluginCard(pl) {
        const dir = pl.directory;
        const dep = pl.dependencyStatus;
        const meta = [pl.packageName, pl.description].filter(Boolean).join(' · ') || t`No package metadata`;
        let depTag = '';
        if (dep?.hasDependencies) {
            depTag = dep.needsInstall
                ? `<span class="dw-pilltag is-warn">${t`Dependencies not installed:`} ${dep.missing?.length ?? 0}</span>`
                : `<span class="dw-pilltag is-ok">${t`Dependencies installed`}</span>`;
        }
        const k = name => `${name}:${dir}`;
        return `
            <div class="dw-card" data-state="${dep?.needsInstall ? 'attention' : 'ok'}">
                <span class="dw-card-icon">${ic('branch')}</span>
                <div class="dw-card-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(dir || '-')}</span>${pl.version ? `<span class="dw-kind">v${esc(pl.version)}</span>` : ''}</div>
                    <div class="dw-card-meta">${depTag}<span>${esc(meta)}</span></div>
                </div>
                <div class="dw-card-act">
                    ${dep?.hasDependencies && dep.needsInstall ? `<button class="dw-btn${this.busyCls(k('deps'))}" data-act="adm-plugin-deps" data-dir="${esc(dir)}">${this.busyIc(k('deps'), 'download')}${t`Install dependencies`}</button>` : ''}
                    <button class="dw-btn${this.busyCls(k('update'))}" data-act="adm-plugin-update" data-dir="${esc(dir)}" ${pl.remoteUrl ? '' : `disabled title="${t`No git remote detected`}"`}>${this.busyIc(k('update'), 'sync')}${t`Update`}</button>
                    <button class="dw-ibtn dw-adm-danger${this.busyCls(k('remove'))}" data-act="adm-plugin-remove" data-dir="${esc(dir)}" title="${t`Remove`}">${this.busyIc(k('remove'), 'trash')}</button>
                </div>
                <code class="dw-adm-remote">${esc(pl.remoteUrl || t`No git remote detected`)}</code>
            </div>`;
    }

    /**
     * Offers to install a plugin's missing dependencies.
     * @param {any} plugin Plugin from the server
     */
    async offerDeps(plugin) {
        if (!plugin?.dependencyStatus?.needsInstall) return;
        const ok = await this.w.confirm({ title: t`This plugin declares dependencies that are not installed. Install them now?`, ok: t`Install dependencies` });
        if (!ok) return;
        await this.act(`deps:${plugin.directory}`, async () => {
            await requestInstallPluginDependencies(plugin.directory);
            return t`Dependencies installed.`;
        });
    }

    async pluginInstall() {
        const repo = String(this.top.repo || '').trim();
        if (!repo) return this.w.toast(t`Please enter a Git repository URL.`, true);
        const ok = await this.w.confirm({ title: t`Install this server plugin?`, text: t`Installing a server plugin grants backend code execution. Install only repositories you trust.`, ok: t`Install`, danger: true });
        if (!ok) return;
        let plugin = null;
        await this.act('install', async () => {
            const result = await requestInstallServerPlugin(repo);
            plugin = result.plugin;
            this.top.repo = '';
            return t`Server plugin installed to ${result.plugin?.directory || 'plugin directory'}.`;
        });
        if (!plugin) return;
        await this.offerDeps(plugin);
        await this.load('plugins');
        this.w.toast(t`Restart the backend to load newly installed server plugins.`);
    }

    async pluginUpdate(dir) {
        let result = null;
        await this.act(`update:${dir}`, async () => {
            result = await requestUpdateServerPlugin(dir);
            return result.plugin?.isUpToDate ? t`Server plugin is already up to date.` : t`Server plugin updated.`;
        });
        if (!result) return;
        await this.offerDeps(result.plugin);
        await this.load('plugins');
        if (result.restartRecommended) this.w.toast(t`Restart the backend to reload updated server plugins.`);
    }

    async pluginRemove(dir) {
        const ok = await this.w.confirm({ title: t`Remove server plugin "${dir}"?`, ok: t`Remove`, danger: true });
        if (!ok) return;
        let result = null;
        await this.act(`remove:${dir}`, async () => {
            result = await requestRemoveServerPlugin(dir);
            return t`Server plugin removed.`;
        });
        if (!result) return;
        await this.load('plugins');
        if (result.restartRecommended) this.w.toast(t`Restart the backend to unload removed server plugins.`);
    }

    async pluginDeps(dir) {
        await this.act(`deps:${dir}`, async () => {
            await requestInstallPluginDependencies(dir);
            return t`Dependencies installed.`;
        });
        await this.load('plugins');
    }

    // ---------- config.yaml ----------

    viewConfig() {
        const wait = this.state('config');
        if (wait) return wait;
        const tp = this.top;
        const c = this.res.config.data;
        tp.content ??= String(c.content || '');
        return `
            <div class="dw-list"><div class="dw-setrow"><span>${t`Path`}</span><span class="dw-setrow-val mono">${esc(c.path || '-')}</span></div></div>
            <textarea class="dw-inp mono dw-adm-code" data-model="top.content" spellcheck="false" rows="20" placeholder="${t`config.yaml content`}">${esc(tp.content)}</textarea>
            ${this.w.errorLine()}
            ${this.w.foot(`<button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="adm-config-save">${this.w.busyIcon('check')}${t`Save`}</button>`)}`;
    }

    async configReload() {
        const tp = this.top;
        const dirty = this.res.config?.data && tp.content !== undefined && tp.content !== String(this.res.config.data.content || '');
        if (dirty && !await this.w.confirm({ title: t`Discard your changes?`, text: t`The editor is reloaded from config.yaml on the server.`, ok: t`Reload`, danger: true })) return;
        delete tp.content;
        tp.error = null;
        await this.load('config');
    }

    async configSave() {
        const tp = this.top;
        await this.w.runForm(async () => {
            const result = await requestSaveRuntimeConfig(String(tp.content || ''));
            this.res.config.data = { ...this.res.config.data, content: tp.content };
            this.w.toast(result?.restartRecommended ? t`Config file saved. Some settings may require a backend restart to fully apply.` : t`Config file saved.`);
        });
    }

    // ---------- storage backend ----------

    viewBackend() {
        const wait = this.state('backend');
        if (wait) return wait;
        const s = this.res.backend.data;
        const tp = this.top;
        tp.db ??= { mysqlUrl: '', mysqlPoolSize: '', postgresUrl: '', postgresPoolSize: '' };
        const running = this.migrating || s.migrationInProgress;
        if (tp.target === s.currentMode) tp.target = null;
        const radio = mode => {
            const current = mode === s.currentMode;
            return `<button class="dw-radio${tp.target === mode ? ' on' : ''}" data-act="adm-backend-target" data-mode="${mode}" ${current || running ? 'disabled' : ''}>
                <span class="dw-ring"></span><span>${esc(modeLabel(mode))}</span>${current ? `<span class="dw-sp"></span><span class="dw-pilltag is-ok">${t`Current`}</span>` : ''}</button>`;
        };
        const db = tp.target === 'mysql' || tp.target === 'postgres' ? (() => {
            const pg = tp.target === 'postgres';
            const pre = pg ? 'postgres' : 'mysql';
            return `<div class="dw-group">
                <div class="dw-sec-title">${ic('db')}${pg ? t`PostgreSQL connection` : t`MySQL connection`}</div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>URL</span><input class="dw-inp mono" data-model="top.db.${pre}Url" value="${esc(tp.db[`${pre}Url`])}" placeholder="${pg ? 'postgresql://user:pass@host:5432/luker' : 'mysql://user:pass@host:3306/luker'}" autocomplete="off" spellcheck="false" ${running ? 'disabled' : ''}></label>
                    <label class="dw-field"><span>${t`Pool size`}</span><input class="dw-inp" type="number" min="1" data-model="top.db.${pre}PoolSize" value="${esc(tp.db[`${pre}PoolSize`])}" placeholder="10" ${running ? 'disabled' : ''}></label>
                </div>
            </div>`;
        })() : '';
        return `
            <div class="dw-list">
                <div class="dw-setrow"><span>${t`Current Mode`}</span><span class="dw-setrow-val" data-current-mode="${esc(s.currentMode)}">${esc(modeLabel(s.currentMode))}</span></div>
                <div class="dw-setrow"><span>${t`Read-Only`}</span><span class="dw-setrow-val">${s.readOnly ? `<span class="dw-pilltag is-warn">${t`yes`}</span>` : t`no`}</span></div>
                <div class="dw-setrow"><span>${t`Last Migration`}</span><span class="dw-setrow-val">${esc(s.lastMigration ? new Date(s.lastMigration).toLocaleString() : t`(none)`)}</span></div>
            </div>
            <section class="dw-sec"><div class="dw-sec-title">${t`Switch Backend`}</div>
                <div class="dw-radios">${BACKEND_MODES.map(radio).join('')}</div>
            </section>
            ${db}
            ${running ? this.migrationProgress(s) : ''}
            ${this.migrationResult()}
            ${this.w.foot(`<button class="dw-btn danger solid big${running ? ' busy' : ''}" data-act="adm-migrate" ${tp.target && !running ? '' : 'disabled'}>${running ? ic('sync', 'dw-spin') : ic('db')}${running ? t`Migration in progress, do not refresh...` : t`Migrate Now`}</button>`)}`;
    }

    migrationProgress(status) {
        const state = status?.state;
        if (!state?.perUser) {
            return `<div class="dw-banner">${ic('sync', 'dw-spin')}<span>${t`Migration in progress. This may take several minutes.`}</span></div>`;
        }
        const handles = Object.keys(state.perUser);
        const done = handles.filter(h => state.perUser[h]?.status === 'done').length;
        const failed = handles.filter(h => state.perUser[h]?.status === 'failed').length;
        const pct = handles.length ? Math.round((done + failed) / handles.length * 100) : 0;
        const stateTag = e => ({
            done: `<span class="dw-pilltag is-ok">${t`done`}</span>`,
            failed: `<span class="dw-pilltag is-bad">${t`failed`}</span>`,
            in_flight: `<span class="dw-pilltag is-warn">${ic('sync', 'dw-spin')}${t`in flight`}${e.stage ? ` · ${esc(e.stage)}` : ''}</span>`,
        })[e.status] || `<span class="dw-pilltag">${t`pending`}</span>`;
        return `
            <div class="dw-progress">
                <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>${t`Progress:`} ${done}/${handles.length} ${t`done`}${failed ? `, ${failed} ${t`failed`}` : ''}</span><span class="dw-sp"></span>
                    <span>${esc(modeLabel(state.targetMode))}${typeof state.staleSeconds === 'number' ? ` · ${t`last progress`} ${state.staleSeconds}s` : ''}</span></div>
                <div class="dw-stages"><div class="dw-stage now" style="--p:${pct}%"></div></div>
            </div>
            <div class="dw-list">${handles.map(h => {
        const e = state.perUser[h] ?? { status: 'pending' };
        const detail = e.status === 'failed' ? e.error || '' : countsLine(e.counts);
        return `<div class="dw-setrow dw-adm-migrow"><span>${esc(h)}</span><span class="dw-setrow-val">${stateTag(e)}</span>${detail ? `<code>${esc(detail)}</code>` : ''}</div>`;
    }).join('')}</div>`;
    }

    migrationResult() {
        const r = this.migrateResult;
        if (!r) return '';
        const d = r.data || {};
        const lines = [];
        if (typeof d.durationMs === 'number') lines.push(`${t`Duration:`} ${d.durationMs}ms`);
        if (d.message) lines.push(d.message);
        if (d.configPersisted === false && d.configPersistError) lines.push(t`Could not save to config.yaml: ${d.configPersistError}`);
        if (d.perUser) {
            lines.push('');
            for (const [handle, stats] of Object.entries(d.perUser)) {
                if (stats?.error) {
                    lines.push(`${handle}: FAIL ${stats.error}`);
                    continue;
                }
                const { verified, backupPath, ...counts } = stats || {};
                lines.push(`${handle}: ${verified ? 'OK' : 'UNVERIFIED'} ${countsLine(counts)}`);
                if (backupPath) lines.push(`  backup: ${backupPath}`);
            }
        }
        const text = r.ok ? t`Migration complete.` : (d.message || t`Migration failed for one or more users. Source backend retained.`);
        return `<div class="dw-banner${r.ok ? '' : ' error'}">${ic(r.ok ? 'check' : 'x')}<span>${esc(text)}</span><button class="dw-btn sm ghost" data-act="adm-migrate-x">${ic('x')}</button></div>
            ${lines.length ? `<pre class="dw-snap-pre">${esc(lines.join('\n'))}</pre>` : ''}`;
    }

    /** Polls the backend status while a migration runs (also one started elsewhere). */
    watchMigration() {
        const s = this.res.backend?.data;
        if (this.pollTimer || !(this.migrating || s?.migrationInProgress)) return;
        const poll = async () => {
            try {
                const next = await fetchStorageBackendStatus();
                if (!this.pollTimer) return;
                this.res.backend = { data: next };
                if (this.top.view === 'adminBackend') this.redraw();
                if (!next.migrationInProgress && !this.migrating) {
                    this.pollTimer = null;
                    return;
                }
            } catch (err) {
                console.warn('Storage migration progress poll failed:', err);
            }
            if (this.pollTimer) this.pollTimer = setTimeout(poll, 1000);
        };
        this.pollTimer = setTimeout(poll, 1000);
    }

    async migrateGo() {
        const tp = this.top;
        const target = tp.target;
        if (!target) return this.w.toast(t`Select a target backend mode.`, true);
        const ok = await this.w.confirm({
            title: t`Switch to ${modeLabel(target)}?`,
            text: t`Migrate ALL user data to ${target}? A backup will be saved permanently under the data-root _storage-migrations directory. This may take several minutes for large installs and the server will reject writes until it finishes.`,
            ok: t`Migrate Now`,
            danger: true,
        });
        if (!ok) return;
        this.migrating = true;
        this.migrateResult = null;
        this.redraw();
        this.watchMigration();
        try {
            const response = await triggerStorageBackendMigration(target, buildStorageBackendCreds(target, tp.db));
            this.migrateResult = { ok: response.ok && response.data?.ok, data: response.data || { message: t`Migration failed.` } };
            this.w.toast(this.migrateResult.ok ? t`Migration complete.` : (response.data?.message || t`Migration failed for one or more users. Source backend retained.`), !this.migrateResult.ok);
        } catch (err) {
            this.migrateResult = { ok: false, data: { message: errText(err) } };
            this.w.toast(errText(err) || t`Migration failed.`, true);
        } finally {
            this.migrating = false;
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
            if (tp.target) tp.target = null;
            await this.load('backend');
        }
    }

    // ---------- storage management ----------

    viewStorage() {
        const wait = this.state('overview');
        if (wait) return wait;
        const tp = this.top;
        tp.query ??= '';
        return `
            <input class="dw-inp" type="search" data-model="top.query" data-adm-input="storage" value="${esc(tp.query)}" placeholder="${t`Search users...`}" autocomplete="off">
            <div class="dw-list" data-region="adm-storage">${this.storagePicker()}</div>`;
    }

    storagePicker() {
        const q = String(this.top.query || '').trim().toLowerCase();
        const users = (this.res.overview?.data?.users || []).filter(u => !q || u.handle.toLowerCase().includes(q));
        const total = (this.res.overview?.data?.users || []).reduce((n, u) => n + (u.storageBytes || 0), 0);
        const row = (target, icon, name, size, tags = '') => `
            <button class="dw-adm-row" data-act="adm-storage-open" data-target="${esc(target)}">
                <span class="dw-card-icon">${ic(icon)}</span>
                <div class="dw-adm-row-main"><div class="dw-card-title"><span class="dw-card-name">${esc(name)}</span>${tags}</div></div>
                <span class="dw-adm-size">${esc(humanFileSize(size))}</span>${ic('chev', 'dw-adm-chev')}
            </button>`;
        return row('__all__', 'users', t`All Users`, total)
            + users.map(u => row(u.handle, 'user', u.handle, u.storageBytes ?? 0,
                `${u.admin ? `<span class="dw-pilltag is-ok">${t`Admin`}</span>` : ''}${u.enabled === false ? `<span class="dw-pilltag is-bad">${t`Disabled`}</span>` : ''}`)).join('');
    }

    viewStorageUser() {
        return '<div class="dw-inspector" data-region="adm-inspector"></div>';
    }

    /**
     * Puts the storage inspector of the page's user into the page; it is built once per page.
     * @param {HTMLElement} slot Placeholder in the page
     */
    mountInspector(slot) {
        const tp = this.top;
        if (!tp.el) {
            tp.el = document.createElement('div');
            tp.el.className = 'storageInspectorContainerWrapper';
            mountStorageInspector({ kind: 'any', target: tp.target }, tp.el).catch(err => this.w.toast(errText(err), true));
        }
        slot.replaceChildren(tp.el);
    }

    // ---------- events ----------

    /**
     * Updates the parts of a page that follow what is typed.
     * @param {InputEvent} e Input event (the field's data-model is already stored)
     */
    onInput(e) {
        const kind = e.target.dataset.admInput;
        const region = name => this.w.root.querySelector(`[data-region="${name}"]`);
        if (kind === 'users' && region('adm-users')) region('adm-users').innerHTML = this.userCards();
        if (kind === 'storage' && region('adm-storage')) region('adm-storage').innerHTML = this.storagePicker();
        if (kind === 'new-name') this.suggestHandle();
        if (kind === 'new-handle') this.top.handleTouched = e.target.value !== '';
        if (kind === 'notice-body' && region('adm-preview')) region('adm-preview').innerHTML = formatAnnouncementBody(this.top.form.body);
    }

    /**
     * Handles a change event; returns true when it was a user-management control.
     * @param {Event} e Change event
     * @returns {boolean} Handled
     */
    onChange(e) {
        const el = e.target;
        if (el.dataset.role !== 'adm-avatar') return false;
        const file = el.files?.[0];
        el.value = '';
        if (file) this.uploadAvatar(file);
        return true;
    }

    /**
     * Handles a user-management control.
     * @param {string} act data-act of the control (always starts with adm-)
     * @param {HTMLElement} el The control
     * @returns {Promise<void>|void}
     */
    onAction(act, el) {
        switch (act) {
            case 'adm-seg':
                this.seg = el.dataset.seg;
                return this.w.render();
            case 'adm-filter':
                this.filter = el.dataset.filter;
                return this.w.rerender();
            case 'adm-reload': return this.load(el.dataset.key);
            case 'adm-push': return this.pushFor(el.dataset.view);
            case 'adm-user': return this.w.push('adminUser', { handle: el.dataset.handle });
            case 'adm-toggle': {
                const parts = el.dataset.path.split('.');
                this.w.setModel(el.dataset.path, !getPath(this.top, parts.slice(1)));
                return this.w.rerender();
            }
            case 'adm-switch': return this.userSwitchGo(el.dataset.kind);
            case 'adm-avatar-pick': return this.w.root.querySelector('[data-role="adm-avatar"]')?.click();
            case 'adm-avatar-remove': return this.removeAvatar();
            case 'adm-data': return this.openUserData();
            case 'adm-name-save': return this.nameSave();
            case 'adm-password-save': return this.passwordSave();
            case 'adm-quota-mode':
                this.top.mode = el.dataset.mode;
                this.top.error = null;
                return this.w.rerender();
            case 'adm-quota-save': return this.quotaSave();
            case 'adm-delete-go': return this.deleteGo();
            case 'adm-create': return this.createGo();
            case 'adm-auth-save': return this.authSave();
            case 'adm-notice-edit': return this.w.push('adminNotice', { id: el.dataset.id });
            case 'adm-notice-delete': return this.noticeDelete(el.dataset.id);
            case 'adm-notice-level':
                this.top.form.level = el.dataset.level;
                return this.w.rerender();
            case 'adm-notice-save': return this.noticeSave();
            case 'adm-plugin-install': return this.pluginInstall();
            case 'adm-plugin-update': return this.pluginUpdate(el.dataset.dir);
            case 'adm-plugin-remove': return this.pluginRemove(el.dataset.dir);
            case 'adm-plugin-deps': return this.pluginDeps(el.dataset.dir);
            case 'adm-config-reload': return this.configReload();
            case 'adm-config-save': return this.configSave();
            case 'adm-backend-target':
                this.top.target = el.dataset.mode;
                return this.w.rerender();
            case 'adm-migrate': return this.migrateGo();
            case 'adm-migrate-x':
                this.migrateResult = null;
                return this.w.rerender();
            case 'adm-storage-open': return this.w.push('adminStorageUser', { target: el.dataset.target });
        }
    }
}
