// Account window: profile, sync/backup/restore/migration, settings snapshots, storage and reset in one window.
import { t } from './i18n.js';
import { DataPages } from './data-window.js';
import { createLukerProvider } from './data-window-provider.js';
import { mountLukerWindow, ic, esc } from './luker-window.js';
import { POPUP_TYPE, callGenericPopup } from './popup.js';
import { ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';
import { mountStorageInspector, createStorageInspector } from './storage-inspector.js';
import { BrowserProvider, BrowserMutator } from './browser-storage-inspector.js';
import { AdminPages } from './account-admin.js';
import {
    accountsEnabled,
    currentUser,
    fetchSnapshotContent,
    fetchSnapshots,
    getCurrentUser,
    isAdmin,
    requestChangeAvatar,
    requestChangeName,
    requestChangePassword,
    requestMakeSnapshot,
    requestResetCode,
    requestResetEverything,
    requestResetSettings,
    requestRestoreSnapshot,
} from './user.js';

const accountTitles = () => ({
    profile: t`Profile`,
    rename: t`Change display name`,
    password: t`Change Password`,
    snapshots: t`Settings snapshots`,
    storage: t`Storage`,
    reset: t`Reset`,
    resetSettings: t`Reset Settings`,
    resetAll: t`Reset Everything`,
});

const accountHelp = () => ({
    profile: [
        t`To change your user avatar, use the buttons below or select a default persona in the Persona Management menu.`,
        ...(accountsEnabled ? [] : [`${t`To enable multi-account features, restart the Luker server with`} enableUserAccounts ${t`set to true in the config.yaml file.`}`]),
    ],
    rename: [t`The display name is what others see. The handle used to sign in stays the same.`],
    password: [t`Leave the new password blank to remove the password.`],
    snapshots: [t`A snapshot records your settings only, not characters or chats.`, t`Restoring a snapshot replaces the current settings and reloads the page.`],
    storage: [t`Server storage shows how much space your data takes on the server.`, t`Browser storage shows what this browser keeps for Luker. Deleting items here only affects this browser.`, t`The data directory is where Luker stores chats, backups, plugins, and extensions on this device.`],
    reset: [t`Reset Settings only restores settings to factory defaults. Reset Everything deletes all your data.`],
    resetSettings: [t`Don't forget to save a snapshot of your settings before proceeding.`],
    resetAll: [t`Account reset code has been posted to the server console.`, t`Make sure you have a backup before proceeding.`],
});

const ACCOUNT_VIEWS = new Set(Object.keys(accountTitles()));

/**
 * The Account window: DataPages plus the profile, snapshot, storage, user and reset pages.
 */
class AccountWindow extends DataPages {
    /**
     * @param {HTMLElement} root Element the window renders into
     * @param {object} provider Data source for the data pages
     * @param {object} options
     * @param {string} options.tab Tab to show first
     * @param {string} [options.view] Sub-page to open inside the tab
     * @param {string} [options.handle] User whose data backup/restore/migration acts on
     * @param {() => void} [options.onDone] Called after a successful restore or migration
     * @param {object[]} [options.usersStack] User-management pages to show again
     */
    constructor(root, provider, { tab, view, handle, onDone, usersStack }) {
        super(root, provider, { tab, handle, onDone });
        this.otherUser = this.isOtherUser;
        this.admin = new AdminPages(this, { reopen: reopenUsers });
        Object.assign(this.stack, {
            profile: [{ view: 'profile' }],
            snapshots: [{ view: 'snapshots' }],
            storage: [{ view: 'storage' }],
            users: usersStack?.length ? usersStack : [{ view: 'users' }],
            reset: [{ view: 'reset' }],
        });
        this.snaps = { list: null, loading: false, error: null, busy: false, open: new Set(), content: new Map() };
        this.storageKind = 'server';
        this.inspectors = {};
        this.dataDirectory = null;
        this.dataDirectoryLoading = false;
        this.dataDirectoryBusy = false;
        const keys = this.navKeys();
        if (!keys.includes(this.tab)) this.tab = keys[0];
        if (view && this.top.view !== view) this.stack[this.tab].push({ view });
        if (!this.otherUser) {
            getCurrentUser().then(() => this.root.isConnected && this.render());
        }
    }

    get windowTitle() {
        return this.otherUser ? t`Account · ${this.handle}` : t`Account`;
    }

    get windowIcon() {
        return 'user';
    }

    navItems() {
        const item = (key, label, icon, extra = {}) => ({ key, label, icon, ...extra });
        const data = [
            item('backup', t`Backup`, 'download'),
            item('restore', t`Restore`, 'restore'),
            item('migrate', t`Migrate`, 'move'),
        ];
        // An admin acting on another user's data only sees these pages.
        if (this.otherUser) return data;
        return [
            item('profile', t`Profile`, 'user'),
            { sep: true },
            item('sync', t`Sync`, 'sync', { count: this.syncIssues }),
            ...data,
            item('settings', t`Device settings`, 'gear'),
            { sep: true },
            item('snapshots', t`Settings snapshots`, 'camera'),
            item('storage', t`Storage`, 'pie'),
            ...(isAdmin() ? [item('users', t`User management`, 'users')] : []),
        ];
    }

    footItems() {
        return this.otherUser ? [] : [{ key: 'reset', label: t`Reset`, icon: 'reset', danger: true }];
    }

    /** Keys of every page reachable from the navigation. */
    navKeys() {
        return [...this.navItems(), ...this.footItems()].filter(i => i.key).map(i => i.key);
    }

    navigate({ tab, view }) {
        if (tab && !this.navKeys().includes(tab)) return this.render();
        super.navigate({ tab, view });
    }

    get isAccountView() {
        return ACCOUNT_VIEWS.has(this.top.view);
    }

    /** Whether the page belongs to user management (account-admin.js). */
    get isAdminView() {
        return this.admin.owns(this.top.view);
    }

    get busyJob() {
        return super.busyJob || this.admin?.busyJob || null;
    }

    destroy() {
        super.destroy();
        this.admin.destroy();
    }

    statusInfo() {
        return this.otherUser ? null : super.statusInfo();
    }

    pageTitle() {
        if (this.isAdminView) return this.admin.title();
        return this.isAccountView ? accountTitles()[this.top.view] : super.pageTitle();
    }

    helpLines() {
        if (this.isAdminView) return this.admin.help();
        return this.isAccountView ? accountHelp()[this.top.view] || [] : super.helpLines();
    }

    headExtra() {
        if (this.isAdminView) return this.admin.headExtra();
        if (this.top.view === 'snapshots') {
            return `<button class="dw-btn primary sm${this.snaps.busy ? ' busy' : ''}" data-act="snap-make">${this.snaps.busy ? ic('sync', 'dw-spin') : ic('camera')}${t`Make a Snapshot`}</button>`;
        }
        return this.isAccountView ? '' : super.headExtra();
    }

    renderView() {
        switch (this.top.view) {
            case 'profile': return this.viewProfile();
            case 'rename': return this.viewRename();
            case 'password': return this.viewPassword();
            case 'snapshots': return this.viewSnapshots();
            case 'storage': return this.viewStorage();
            case 'reset': return this.viewReset();
            case 'resetSettings': return this.viewResetSettings();
            case 'resetAll': return this.viewResetAll();
        }
        if (this.isAdminView) return this.admin.render();
        return super.renderView();
    }

    afterRender() {
        super.afterRender();
        const slot = this.root.querySelector('[data-region="storage"]');
        if (slot) this.mountInspector(slot);
        if (this.top.view === 'storage' && this.storageKind === 'server') this.loadDataDirectory();
        if (this.isAdminView) this.admin.afterRender();
    }

    async loadDataDirectory() {
        if (this.dataDirectory || this.dataDirectoryLoading) return;
        const bridge = window.LukerDesktop;
        if (!bridge || typeof bridge.getDataDirectory !== 'function') return;
        this.dataDirectoryLoading = true;
        try {
            this.dataDirectory = await bridge.getDataDirectory() || { error: true };
        } catch (error) {
            this.dataDirectory = { error: error?.message || String(error) };
        } finally {
            this.dataDirectoryLoading = false;
        }
        if (this.root.isConnected && this.top.view === 'storage') this.rerender();
    }

    async changeDataDirectory() {
        const bridge = window.LukerDesktop;
        if (!bridge || typeof bridge.chooseDataDirectory !== 'function' || this.dataDirectoryBusy) return;
        this.dataDirectoryBusy = true;
        this.rerender();
        try {
            const result = await bridge.chooseDataDirectory();
            if (result?.restarting) {
                this.toast(t`Restarting Luker to apply the new data directory…`);
            }
        } catch (error) {
            this.toast(error?.message || String(error), true);
        } finally {
            this.dataDirectoryBusy = false;
            if (this.root.isConnected && this.top.view === 'storage') this.rerender();
        }
    }

    errorLine() {
        return this.top.error ? `<div class="dw-err">${esc(this.top.error)}</div>` : '';
    }

    busyIcon(icon) {
        return this.top.busy ? ic('sync', 'dw-spin') : ic(icon);
    }

    // ---------- profile ----------

    viewProfile() {
        const u = currentUser;
        if (!u) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('sync', 'dw-spin')}</span></div>`;
        }
        const password = u.password
            ? `<span class="dw-pilltag is-ok">${ic('lock')}${t`Set`}</span>`
            : `<span class="dw-pilltag is-warn">${ic('unlock')}${t`Not set`}</span>`;
        return `
            <div class="dw-profile">
                <span class="dw-avatar"><img src="${esc(u.avatar)}" alt=""></span>
                <div class="dw-profile-main">
                    <div class="dw-profile-name">${esc(u.name)}</div>
                    <div class="dw-card-meta"><span class="dw-pilltag${u.admin ? ' is-ok' : ''}">${u.admin ? t`Admin` : t`User`}</span></div>
                </div>
                <div class="dw-profile-act">
                    <button class="dw-btn sm" data-act="avatar-pick">${ic('image')}${t`Change avatar`}</button>
                    <button class="dw-btn sm icon" data-act="avatar-remove" title="${t`Remove your custom avatar.`}">${ic('trash')}</button>
                </div>
                <input type="file" accept="image/*" data-role="avatar" hidden>
            </div>
            <div class="dw-list">
                <div class="dw-setrow"><span>${t`Handle`}</span><span class="dw-setrow-val">${esc(u.handle)}</span></div>
                <div class="dw-setrow"><span>${t`Created`}</span><span class="dw-setrow-val">${esc(new Date(u.created).toLocaleString())}</span></div>
                <div class="dw-setrow"><span>${t`Password`}</span><span class="dw-setrow-val">${password}</span></div>
            </div>
            ${accountsEnabled ? `<div class="dw-options">
                ${this.option('rename', 'edit', t`Change display name`)}
                ${this.option('password', 'key', t`Change Password`)}
            </div>` : ''}`;
    }

    viewRename() {
        const tp = this.top;
        tp.name ??= currentUser?.name || '';
        return `
            <label class="dw-field"><span>${t`Display name`}</span><input class="dw-inp" data-model="top.name" value="${esc(tp.name)}" autocomplete="off"></label>
            ${this.errorLine()}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="rename-save">${this.busyIcon('check')}${t`Save`}</button>`)}`;
    }

    viewPassword() {
        const tp = this.top;
        tp.form ??= { current: '', next: '', confirm: '' };
        const needCurrent = !isAdmin() && currentUser?.password;
        return `
            ${needCurrent ? `<label class="dw-field"><span>${t`Current password`}</span>${this.pw('top.form.current', tp.form.current, '', 'current-password')}</label>` : ''}
            <div class="dw-grid2">
                <label class="dw-field"><span>${t`New password`}</span>${this.pw('top.form.next', tp.form.next, t`[ No password ]`)}</label>
                <label class="dw-field"><span>${t`Confirm new password`}</span>${this.pw('top.form.confirm', tp.form.confirm, t`[ No password ]`)}</label>
            </div>
            ${this.errorLine()}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="password-save">${this.busyIcon('key')}${t`Change Password`}</button>`)}`;
    }

    async renameSave() {
        const tp = this.top;
        const name = String(tp.name || '').trim();
        if (!name) return this.formError(t`Enter a display name`);
        await this.runForm(async () => {
            await requestChangeName(currentUser.handle, name);
            await getCurrentUser();
            this.pop();
            this.toast(t`Name changed`);
        });
    }

    async passwordSave() {
        const f = this.top.form;
        if (f.next !== f.confirm) return this.formError(t`Passwords do not match`);
        if (!f.next && currentUser?.password && !await this.confirm({
            title: t`Remove the password?`,
            text: t`Anyone who can open this server will be able to sign in to this account.`,
            ok: t`Remove password`,
            danger: true,
        })) return;
        await this.runForm(async () => {
            await requestChangePassword(currentUser.handle, f.current, f.next);
            await getCurrentUser();
            this.pop();
            this.toast(f.next ? t`Password changed` : t`Password removed`);
        });
    }

    /**
     * Runs a form submit with the busy state and error line of the current page.
     * @param {() => Promise<void>} fn Submit
     */
    async runForm(fn) {
        const tp = this.top;
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            await fn();
        } catch (err) {
            tp.error = err.message || String(err);
        } finally {
            tp.busy = false;
            if (this.top === tp) this.rerender();
        }
    }

    onInput(e) {
        super.onInput(e);
        if (this.isAdminView) this.admin.onInput(e);
    }

    onChange(e) {
        if (this.admin.onChange(e)) return;
        const el = e.target;
        if (el.dataset.role === 'avatar') {
            const file = el.files?.[0];
            el.value = '';
            if (file) this.uploadAvatar(file);
            return;
        }
        super.onChange(e);
    }

    async uploadAvatar(file) {
        try {
            const cropImage = await getBase64Async(await ensureImageFormatSupported(file));
            // The crop popup opens above this window.
            const cropped = await callGenericPopup(t`Set the crop position of the avatar image`, POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage });
            if (!cropped) return;
            await requestChangeAvatar(currentUser.handle, String(cropped));
            await getCurrentUser();
            this.rerender();
            this.toast(t`Avatar updated`);
        } catch (err) {
            this.toast(err.message || String(err), true);
        }
    }

    async removeAvatar() {
        try {
            await requestChangeAvatar(currentUser.handle, '');
            await getCurrentUser();
            this.rerender();
            this.toast(t`Avatar removed`);
        } catch (err) {
            this.toast(err.message || String(err), true);
        }
    }

    // ---------- settings snapshots ----------

    viewSnapshots() {
        const s = this.snaps;
        if (!s.list && !s.loading && !s.error) this.loadSnapshots();
        if (s.error) {
            return `<div class="dw-banner error">${ic('x')}<span>${esc(s.error)}</span><button class="dw-btn sm" data-act="snap-reload">${t`Retry`}</button></div>`;
        }
        if (!s.list) return `<div class="dw-empty"><span class="dw-card-icon">${ic('sync', 'dw-spin')}</span></div>`;
        if (!s.list.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('camera')}</span><b>${t`No snapshots yet`}</b></div>`;
        }
        return `<div class="dw-cards">${s.list.map(snap => {
            const open = s.open.has(snap.name);
            const content = s.content.get(snap.name);
            return `
                <div class="dw-card">
                    <span class="dw-card-icon">${ic('camera')}</span>
                    <div class="dw-card-main">
                        <div class="dw-card-title"><span class="dw-card-name" title="${esc(snap.name)}">${esc(snap.name)}</span></div>
                        <div class="dw-card-meta"><span>${esc(new Date(snap.date).toLocaleString())}</span><span>${esc(humanFileSize(snap.size))}</span></div>
                    </div>
                    <div class="dw-card-act">
                        <button class="dw-ibtn${open ? ' on' : ''}" data-act="snap-view" data-name="${esc(snap.name)}" title="${t`View`}">${ic('eye')}</button>
                        <button class="dw-btn" data-act="snap-restore" data-name="${esc(snap.name)}">${ic('restore')}${t`Restore`}</button>
                    </div>
                    ${open ? `<pre class="dw-snap-pre">${content === undefined ? esc(t`Loading…`) : esc(content)}</pre>` : ''}
                </div>`;
        }).join('')}</div>`;
    }

    async loadSnapshots() {
        const s = this.snaps;
        s.loading = true;
        s.error = null;
        try {
            s.list = (await fetchSnapshots()).sort((a, b) => b.date - a.date);
        } catch (err) {
            s.error = err.message || String(err);
        } finally {
            s.loading = false;
            if (this.top.view === 'snapshots') this.rerender();
        }
    }

    async makeSnapshot() {
        const s = this.snaps;
        if (s.busy) return;
        s.busy = true;
        this.rerender();
        try {
            await requestMakeSnapshot();
            this.toast(t`Snapshot created`);
            s.list = null;
        } catch (err) {
            this.toast(err.message || String(err), true);
        } finally {
            s.busy = false;
            if (this.top.view === 'snapshots') this.rerender();
        }
    }

    async toggleSnapshot(name) {
        const s = this.snaps;
        if (s.open.has(name)) {
            s.open.delete(name);
            return this.rerender();
        }
        s.open.add(name);
        this.rerender();
        if (s.content.has(name)) return;
        try {
            s.content.set(name, await fetchSnapshotContent(name));
        } catch (err) {
            s.open.delete(name);
            this.toast(err.message || String(err), true);
        }
        if (this.top.view === 'snapshots') this.rerender();
    }

    async restoreSnapshot(name) {
        const ok = await this.confirm({ title: t`Restore the settings from "${name}"?`, text: t`The current settings are replaced and the page reloads.`, ok: t`Restore` });
        if (!ok) return;
        try {
            await requestRestoreSnapshot(name);
            location.reload();
        } catch (err) {
            this.toast(err.message || String(err), true);
        }
    }

    // ---------- storage ----------

    viewStorage() {
        const seg = (kind, icon, label) => `<button class="${this.storageKind === kind ? 'on' : ''}" data-act="storage-kind" data-kind="${kind}" role="tab" aria-selected="${this.storageKind === kind}">${ic(icon)}${label}</button>`;
        const showPath = this.storageKind === 'server'
            && window.LukerDesktop?.getDataDirectory
            && (!accountsEnabled || isAdmin());
        const dir = this.dataDirectory;
        const canChoose = showPath && typeof window.LukerDesktop?.chooseDataDirectory === 'function';
        const row = showPath ? `<div class="dw-data-dir">
            <div class="dw-data-dir-main">
                <span>${t`Data directory`}</span>
                <span class="dw-data-dir-path" title="${esc(dir?.path || '')}">${esc(dir?.path || (dir?.error ? t`Unavailable` : t`Loading…`))}</span>
            </div>
            ${canChoose ? `<button class="dw-btn sm${this.dataDirectoryBusy ? ' busy' : ''}" data-act="data-dir-change"
                ${!dir || dir.locked || dir.error || this.dataDirectoryBusy ? 'disabled' : ''}
                title="${dir?.locked ? t`Managed by the launch environment.` : ''}">
                ${this.dataDirectoryBusy ? ic('sync', 'dw-spin') : ic('move')}${t`Change`}
            </button>` : ''}
        </div>` : '';
        return `${row}
            <div class="dw-seg" role="tablist">${seg('server', 'server', t`Server storage`)}${seg('browser', 'browser', t`Browser Storage`)}</div>
            <div class="dw-inspector" data-region="storage"></div>`;
    }

    /**
     * Puts the inspector for the selected storage into the page; each one is built once and kept.
     * @param {HTMLElement} slot Placeholder in the page
     */
    mountInspector(slot) {
        const kind = this.storageKind;
        let entry = this.inspectors[kind];
        if (!entry) {
            const el = document.createElement('div');
            el.className = 'storageInspectorContainerWrapper';
            entry = this.inspectors[kind] = { el };
            const ready = kind === 'server'
                ? mountStorageInspector({ kind: 'self' }, el)
                : createStorageInspector({ provider: new BrowserProvider(), mutator: new BrowserMutator(), container: el }).init();
            ready.catch(err => {
                delete this.inspectors[kind];
                this.toast(err.message || String(err), true);
            });
        }
        slot.replaceChildren(entry.el);
    }

    // ---------- reset ----------

    viewReset() {
        return `<div class="dw-options">
            ${this.option('resetSettings', 'gear', t`Reset Settings`, 'red')}
            ${this.option('resetAll', 'skull', t`Reset Everything`, 'red')}
        </div>`;
    }

    viewResetSettings() {
        const tp = this.top;
        tp.password ??= '';
        return `
            <div class="dw-banner warning">${ic('camera')}<span>${t`Don't forget to save a snapshot of your settings before proceeding.`}</span>
                <button class="dw-btn sm" data-act="tab" data-tab="snapshots">${t`Settings snapshots`}</button></div>
            <label class="dw-field"><span>${t`Password`}</span>${this.pw('top.password', tp.password, '', 'current-password')}</label>
            ${this.errorLine()}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn danger solid big${tp.busy ? ' busy' : ''}" data-act="reset-settings-go">${this.busyIcon('reset')}${t`Reset Settings`}</button>`)}`;
    }

    viewResetAll() {
        const tp = this.top;
        tp.form ??= { password: '', code: '' };
        if (!tp.codeState) {
            tp.codeState = 'sending';
            setTimeout(() => this.sendResetCode(tp));
        }
        let code = '';
        if (tp.codeState === 'sending') code = `<div class="dw-banner">${ic('sync', 'dw-spin')}<span>${t`Requesting a reset code…`}</span></div>`;
        if (tp.codeState === 'sent') code = `<div class="dw-banner">${ic('check')}<span>${t`Account reset code has been posted to the server console.`}</span><button class="dw-btn sm" data-act="reset-code">${t`Send again`}</button></div>`;
        if (tp.codeState === 'error') code = `<div class="dw-banner error">${ic('x')}<span>${esc(tp.codeError)}</span><button class="dw-btn sm" data-act="reset-code">${t`Retry`}</button></div>`;
        return `
            <div class="dw-banner error">${ic('warn')}<span>${t`This will delete all your settings and data. There will be no undo button. Make sure you have a backup before proceeding.`}</span>
                <button class="dw-btn sm" data-act="tab" data-tab="backup">${t`Backup`}</button></div>
            ${code}
            <div class="dw-grid2">
                <label class="dw-field"><span>${t`Password`}</span>${this.pw('top.form.password', tp.form.password, '', 'current-password')}</label>
                <label class="dw-field"><span>${t`Reset code`}</span><input class="dw-inp mono" data-model="top.form.code" value="${esc(tp.form.code)}" placeholder="XXXXXX" autocomplete="off"></label>
            </div>
            ${this.errorLine()}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn danger solid big${tp.busy ? ' busy' : ''}" data-act="reset-all-go">${this.busyIcon('skull')}${t`Reset Everything`}</button>`)}`;
    }

    /**
     * Asks the server to print a reset code to its console.
     * @param {object} tp Reset-everything page state
     */
    async sendResetCode(tp) {
        tp.codeState = 'sending';
        if (this.top === tp) this.rerender();
        try {
            await requestResetCode();
            tp.codeState = 'sent';
        } catch (err) {
            tp.codeState = 'error';
            tp.codeError = err.message || String(err);
        }
        if (this.top === tp) this.rerender();
    }

    async resetSettingsGo() {
        const tp = this.top;
        const ok = await this.confirm({ title: t`Are you sure you want to reset your settings to factory defaults?`, ok: t`Reset Settings`, danger: true });
        if (!ok) return;
        await this.runForm(async () => {
            await requestResetSettings(currentUser?.handle, tp.password);
            location.reload();
        });
    }

    async resetAllGo() {
        const f = this.top.form;
        if (!f.code.trim()) return this.formError(t`Enter the reset code`);
        const ok = await this.confirm({ title: t`Reset everything?`, text: t`All your settings and data will be deleted. This cannot be undone.`, ok: t`Reset Everything`, danger: true });
        if (!ok) return;
        await this.runForm(async () => {
            await requestResetEverything(f.password, f.code.trim());
            location.reload();
        });
    }

    // ---------- actions ----------

    async onAction(act, el, e) {
        if (act.startsWith('adm-')) return this.admin.onAction(act, el);
        switch (act) {
            case 'rename-save': return this.renameSave();
            case 'password-save': return this.passwordSave();
            case 'avatar-pick': return this.root.querySelector('[data-role="avatar"]')?.click();
            case 'avatar-remove': return this.removeAvatar();
            case 'snap-make': return this.makeSnapshot();
            case 'snap-reload':
                this.snaps.error = null;
                return this.rerender();
            case 'snap-view': return this.toggleSnapshot(el.dataset.name);
            case 'snap-restore': return this.restoreSnapshot(el.dataset.name);
            case 'storage-kind':
                this.storageKind = el.dataset.kind;
                return this.rerender();
            case 'data-dir-change': return this.changeDataDirectory();
            case 'reset-code': return this.sendResetCode(this.top);
            case 'reset-settings-go': return this.resetSettingsGo();
            case 'reset-all-go': return this.resetAllGo();
        }
        return super.onAction(act, el, e);
    }
}

let openWindow = null;

/**
 * Shows user management again after another user's data window closed, unless an Account window is already open.
 * @param {object[]} usersStack User-management pages to restore
 */
function reopenUsers(usersStack) {
    if (openWindow || !isAdmin()) return;
    openAccountWindow({ tab: 'users', usersStack });
}

/**
 * Opens the Account window, or brings the open one to the requested page.
 * @param {object} [options]
 * @param {string} [options.tab] Page to show first: profile, sync, backup, restore, migrate, settings, snapshots, storage, users or reset
 * @param {string} [options.view] Sub-page to open inside the tab (e.g. 'conflicts')
 * @param {string} [options.handle] User whose data backup/restore/migration acts on (admin panel); another user's handle limits the window to those pages
 * @param {() => void} [options.onDone] Called after a successful restore or migration; reloads the page (or closes a per-user window) by default
 * @param {object[]} [options.usersStack] User-management pages to show (internal)
 * @returns {Promise<void>} Resolves when the window closes
 */
export function openAccountWindow({ tab = 'profile', view, handle, onDone, usersStack } = {}) {
    if (openWindow && openWindow.handle !== handle) {
        openWindow.close();
    }
    if (openWindow) {
        if (onDone) openWindow.ui.onDone = onDone;
        openWindow.ui.navigate({ tab, view });
        openWindow.win.focus();
        return openWindow.closed;
    }
    const source = createLukerProvider({ handle });
    source.start();
    let mounted;
    const done = onDone ?? (() => (mounted.ui.otherUser ? mounted.close() : location.reload()));
    mounted = mountLukerWindow({
        label: t`Account`,
        create: root => new AccountWindow(root, source, { tab, view, handle, onDone: done, usersStack }),
        onClosed: () => {
            source.stop();
            openWindow = null;
        },
    });
    openWindow = { ...mounted, handle };
    return mounted.closed;
}
