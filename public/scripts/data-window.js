// Data pages of the Account window: sync, backup, restore and migration.
import { t } from './i18n.js';
import { LukerWindow, ic, esc } from './luker-window.js';
import { createConflictDiffPanels, createConflictDiffQueue } from './sync-conflict-view.js';

export const dataTitles = () => ({
    list: t`Sync`,
    backup: t`Backup`,
    restore: t`Restore`,
    migrate: t`Migrate`,
    settings: t`Device settings`,
    add: t`Add sync backend`,
    pairNew: t`Let another device connect`,
    pairExist: t`Connect to another device`,
    s3: t`Add S3 storage`,
    s3Edit: t`Edit S3 storage`,
    unlock: t`Unlock S3 storage`,
    lanEdit: t`Edit device`,
    conflicts: t`Sync issues`,
    migrateOut: t`Migrate out of this device`,
    migrateIn: t`Migrate into this device`,
});

export const dataHelp = () => ({
    list: [t`Sync automatically exchanges data between this device and others. LAN devices connect directly; S3 relays through an encrypted bucket.`, t`Sync keeps running on the server even if you close the browser. Conflicting files keep a usable version until you choose.`],
    settings: [t`The device name appears in other devices' version history. Leave it blank to use the host name. Renaming only affects later edits; old records stay unchanged.`, t`Sync runs a short while after you stop editing. It also checks other devices for updates at the poll interval.`],
    add: [t`LAN: both devices must be able to reach each other. Generate a link on one and paste it on the other.`, t`S3: use the same bucket, prefix and passphrase on every device.`],
    pairNew: [t`A link works only once and carries the other device's name and what to sync. Changing the address keeps the same link; click "Regenerate" to void the old one.`, t`The other device must be able to reach this one at the selected address. The login account it enters when connecting is saved on its server.`],
    pairExist: [t`After you paste the link, the address, device ID and sync content are filled in automatically. Both devices must sign in as the same user; special characters in a username become underscores.`, t`The account is only needed if the other device has a login password. It is saved on this device after pairing and can be cleared from the device menu at any time.`],
    s3: [t`Devices with the same bucket, prefix and passphrase sync with each other.`, t`The bucket and prefix cannot be changed after saving.`],
    s3Edit: [t`Leave the keys and passphrase blank to keep the current values. The bucket and prefix cannot be changed after saving.`],
    unlock: [t`After a server restart, enter the passphrase again to keep reading and writing this bucket.`],
    lanEdit: [t`Only changes the name and sync content on this device's side.`],
    conflicts: [t`When two devices edit the same file and it cannot be merged, it waits here for you to pick a version.`, t`Choosing anything other than "Current version" overwrites changes made after the conflict; the overwritten version stays in sync history.`],
    backup: [t`Packs the selected data into a ZIP and downloads it.`, t`API keys are not included by default. Backup, restore and migrate share the same content selection.`],
    restore: [t`Incremental: writes the files in the backup, replacing files at the same path and leaving everything else alone.`, t`Replace: clears the selected content first, then writes the backup.`, t`Stages after the upload cannot be cancelled.`, t`If the backup comes from a different type of database, you will be asked for a temporary database connection to relay through.`],
    migrate: [t`Moves data to another device in one go. For long-term use across several devices, use "Sync".`],
    migrateOut: [t`The link expires quickly and works only once.`],
    migrateIn: [t`Generate a link on the old device and paste it here.`],
});

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1', 'ap-southeast-1', 'ap-east-1', 'ap-hongkong', 'ap-shanghai', 'ap-guangzhou', 'ap-beijing', 'oss-cn-hangzhou', 'oss-cn-shanghai', 'auto'];
// Each stage is [name, progress text].
const restoreStages = () => [[t`Upload`, t`Uploading…`], [t`Prepare`, t`Preparing…`], [t`Check`, t`Checking…`], [t`Restore`, t`Restoring…`]];
const migrateStages = () => [[t`Download`, t`Downloading…`], [t`Prepare`, t`Preparing…`], [t`Restore`, t`Restoring…`]];
const stateTag = () => ({ ok: ['is-ok', t`Synced`], running: ['is-ok', t`Syncing`], error: ['is-bad', t`Failed`], pending: ['', t`Waiting for the other device`], unknown: ['is-warn', t`Status unknown`] });

function ago(ts) {
    if (!ts) return t`Never synced`;
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return t`Just now`;
    if (s < 3600) return t`${Math.floor(s / 60)} min ago`;
    if (s < 86400) return t`${Math.floor(s / 3600)} hr ago`;
    return t`${Math.floor(s / 86400)} d ago`;
}

function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function size(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const defaultSyncCats = groups => new Set(groups.flatMap(([, items]) => items.filter(i => !i[2]).map(i => i[0])));
const allSyncCats = groups => groups.flatMap(([, items]) => items.map(i => i[0]));
const isLoopback = url => /\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(:|\/|$)/i.test(url);
const firstReachable = list => list.find(a => !isLoopback(a)) || list[0];

/** Hostname of a database connection URL, or '' when it has no usable host. */
function dbUrlHost(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

// Survives closing and reopening the window, like the old per-backend action lock.
const shared = { pending: new Set(), jobsByHandle: new Map(), backupSel: null };

function getSharedJobs(key) {
    if (!shared.jobsByHandle.has(key)) {
        shared.jobsByHandle.set(key, {
            backup: { running: false, stage: null, percent: 0, done: null },
            restore: { file: null, mode: 'merge', needsDb: null, db: { host: '', port: '', user: '', pass: '', name: '' }, running: false, stage: -1, percent: 0, note: '', done: null, error: null, interrupted: null },
            migrate: { link: null, addresses: [], addr: '', expiresAt: 0, inLink: '', mode: 'merge', running: false, stage: -1, percent: 0, done: null, error: null, busy: false },
        });
    }
    return shared.jobsByHandle.get(key);
}

/**
 * Sync, backup, restore and migration pages. The Account window extends this with its own pages.
 */
export class DataPages extends LukerWindow {
    /**
     * @param {HTMLElement} root Element the window renders into
     * @param {object} provider Data source (see createLukerProvider)
     * @param {object} options
     * @param {string} options.tab Tab to show first
     * @param {string} [options.handle] User whose data backup/restore/migration acts on
     * @param {() => void} [options.onDone] Called after a successful restore or migration
     */
    constructor(root, provider, { tab, handle, onDone }) {
        super(root, { tab });
        this.p = provider;
        this.handle = handle;
        this.onDone = onDone;
        Object.assign(this.stack, { sync: [{ view: 'list' }], backup: [{ view: 'backup' }], restore: [{ view: 'restore' }], migrate: [{ view: 'migrate' }], settings: [{ view: 'settings' }] });
        this.pending = shared.pending;
        this.menu = null;
        this.flash = null;
        this.choices = {};
        this.failedKeys = new Set();
        this.noticeBusy = new Set();
        const s = this.p.snapshot();
        shared.backupSel ??= new Set(s.backupCategories.filter(c => c.def && (c.id !== 'secrets' || s.caps.allowSecrets)).map(c => c.id));
        this.backupSel = shared.backupSel;
        const jobsKey = this.handle || s.handle || '';
        this.f = { device: { label: s.device.label }, schedule: { ...s.schedule }, ...getSharedJobs(jobsKey) };

        this.root.addEventListener('input', e => this.onInput(e));
        this.root.addEventListener('change', e => this.onChange(e));
        this.root.addEventListener('dragover', e => this.onDrag(e, true));
        this.root.addEventListener('dragleave', e => this.onDrag(e, false));
        this.root.addEventListener('drop', e => this.onDrop(e));
        this.unsubscribe = this.p.subscribe(() => this.refreshLive());
        this.ticker = setInterval(() => this.tick(), 1000);
        this.finishTimer = null;
        this.conflictTrees = new Map();
        this.conflictQueue = createConflictDiffQueue(2);
    }

    afterRender() {
        this.mountConflictViews();
    }

    /**
     * Keep the mounted diff panels across page rerenders: a status refresh
     * replaces the page markup, so the existing panel is moved into the new
     * placeholder instead of being rebuilt and losing its open fields.
     */
    mountConflictViews() {
        if (this.top.view !== 'conflicts') return;
        const shown = new Set();
        for (const slot of this.root.querySelectorAll('[data-conflict-view]')) {
            const key = slot.dataset.conflictView;
            shown.add(key);
            const conflict = this.snap.conflicts.find(item => item.key === key);
            if (!conflict) continue;
            const signature = JSON.stringify(conflict.review);
            let mounted = this.conflictTrees.get(key);
            if (!mounted || mounted.signature !== signature) {
                mounted = {
                    signature,
                    group: createConflictDiffPanels(
                        conflict.review,
                        this.conflictQueue,
                        oid => this.p.previewUrl(conflict.review.backendId, oid),
                    ),
                };
                this.conflictTrees.set(key, mounted);
            }
            slot.append(mounted.group);
        }
        for (const key of this.conflictTrees.keys()) {
            if (!shown.has(key)) this.conflictTrees.delete(key);
        }
    }

    /** Name of the long-running job in progress, if any. */
    get busyJob() {
        const { backup, restore, migrate } = this.f;
        if (backup.running) return t`Downloading backup`;
        if (restore.running) return t`Restoring`;
        if (migrate.running) return t`Migrating`;
        if (this.applying) return t`Applying conflict choices`;
        return null;
    }

    /** Disabled attribute for a main button while another heavy job runs. */
    lockAttr(own) {
        const job = this.busyJob;
        return job && !own ? `disabled title="${esc(t`${job}. Please wait for it to finish.`)}"` : '';
    }

    destroy() {
        this.unsubscribe?.();
        clearInterval(this.ticker);
        clearTimeout(this.finishTimer);
        this.finishTimer = null;
    }

    get snap() {
        return this.p.snapshot();
    }

    get viewKey() {
        return this.top.view === 's3' && this.top.id ? 's3Edit' : this.top.view;
    }

    push(view, params = {}) {
        this.menu = null;
        super.push(view, params);
    }

    /** Whether backup/restore/migration act on a user other than the signed-in one. */
    get isOtherUser() {
        return !!this.handle && this.handle !== this.p.currentHandle();
    }

    /** Conflicts and notices waiting for the user. */
    get syncIssues() {
        return this.snap.conflicts.length + this.snap.notices.length;
    }

    pageTitle() {
        return dataTitles()[this.viewKey] || '';
    }

    helpLines() {
        return dataHelp()[this.viewKey] || [];
    }

    headExtra() {
        const canAdd = this.top.view === 'list' && this.snap.available && this.snap.backends.length;
        const other = this.isOtherUser && ['backup', 'restore', 'migrate'].includes(this.tab);
        return `${other ? `<span class="dw-pilltag is-warn">${esc(t`Acting on user ${this.handle}`)}</span>` : ''}
            ${canAdd ? `<button class="dw-btn primary sm" data-act="push" data-view="add">${ic('plus')}${t`Add`}</button>` : ''}`;
    }

    renderView() {
        switch (this.top.view) {
            case 'list': return this.viewList();
            case 'settings': return this.viewSettings();
            case 'add': return this.viewAdd();
            case 'pairNew': return this.viewPairNew();
            case 'pairExist': return this.viewPairExist();
            case 's3': return this.viewS3();
            case 'unlock': return this.viewUnlock();
            case 'lanEdit': return this.viewLanEdit();
            case 'conflicts': return this.viewConflicts();
            case 'backup': return this.viewBackup();
            case 'restore': return this.viewRestore();
            case 'migrate': return this.viewMigrate();
            case 'migrateOut': return this.viewMigrateOut();
            case 'migrateIn': return this.viewMigrateIn();
        }
        return '';
    }

    statusInfo() {
        const { backends, conflicts, notices, available, statusError } = this.snap;
        if (!available) return { tone: 'error', text: t`Sync unavailable` };
        if (statusError) return { tone: 'error', text: t`Can't read sync status` };
        const running = backends.find(b => b.state === 'running');
        if (running) return { tone: 'running', text: t`Syncing ${running.label} · ${clock(Date.now() - running.startedAt)}` };
        if (conflicts.length) return { tone: 'attention', text: t`${conflicts.length} conflicts to resolve`, act: 'conflicts' };
        if (notices.length) return { tone: 'attention', text: t`${notices.length} sync notices`, act: 'conflicts' };
        const failed = backends.find(b => b.state === 'error');
        if (failed) return { tone: 'error', text: t`${failed.label} sync failed` };
        const stalled = backends.filter(b => b.stalled?.length);
        if (stalled.length) return { tone: 'attention', text: t`${stalled.reduce((n, b) => n + b.stalled.length, 0)} files could not be updated`, act: 'conflicts' };
        const synced = backends.filter(b => b.lastSync);
        if (!synced.length) return null;
        return { tone: 'ok', text: t`Synced · ${ago(Math.max(...synced.map(b => b.lastSync)))}` };
    }

    tick() {
        this.renderStatus();
        if (this.f.migrate.link && this.top.view === 'migrateOut') {
            const el = this.root.querySelector('[data-region="expire"]');
            if (el) el.innerHTML = this.expireText();
        }
        if (Date.now() % 15000 < 1000) this.refreshRegion('cards');
    }

    refreshLive() {
        const v = this.top.view;
        // Settings load after the window opens; fill the form until the user edits it.
        if (!this.settingsTouched) {
            const s = this.snap;
            this.f.device = { label: s.device.label };
            this.f.schedule = { ...s.schedule };
            if (v === 'settings') this.rerender();
        }
        if (v === 'list') {
            this.refreshRegion('top');
            this.refreshRegion('cards');
            this.refreshRegion('summary');
        } else if (v === 'conflicts') {
            this.rerender();
        }
        const tab = this.root.querySelector('.dw-tab[data-tab="sync"]');
        if (tab) {
            const n = this.syncIssues;
            let count = tab.querySelector('.dw-tab-count');
            if (n && !count) {
                tab.insertAdjacentHTML('beforeend', '<span class="dw-tab-count"></span>');
                count = tab.querySelector('.dw-tab-count');
            }
            if (count) n ? (count.textContent = String(n)) : count.remove();
        }
        this.renderStatus();
    }

    refreshRegion(name) {
        const el = this.root.querySelector(`[data-region="${name}"]`);
        if (!el) return;
        if (name === 'cards') el.innerHTML = this.renderCards();
        if (name === 'top') el.innerHTML = this.renderTop();
        if (name === 'summary') el.innerHTML = this.renderSummary();
    }

    // ---------- category pickers ----------

    syncCats(key, set) {
        return `<section class="dw-sec">
            <div class="dw-sec-title">${t`Sync content`}<span class="dw-sp"></span><span class="dw-count">${t`Selected ${set.size} / ${allSyncCats(this.snap.syncCategories).length}`}</span></div>
            <div class="dw-cats">${this.snap.syncCategories.map(([group, items], gi) => `
                <div class="dw-cat-g">
                    <button data-act="cat-group" data-set="${key}" data-g="${gi}" title="${t`Select all / none`}">${esc(group)}</button>
                    <div class="dw-chips">${items.map(([id, label, opt]) => `
                        <button class="dw-chip${set.has(id) ? ' on' : ''}${opt ? ' opt' : ''}" data-act="cat" data-set="${key}" data-id="${id}" ${opt ? `title="${t`Not synced by default`}"` : ''}>${opt ? ic('lock') : ''}${esc(label)}</button>`).join('')}
                    </div>
                </div>`).join('')}
            </div>
        </section>`;
    }

    backupCats(title = t`Content`) {
        const { backupCategories, isAdmin, caps } = this.snap;
        const cats = backupCategories.filter(c => !c.adminOnly || isAdmin);
        const n = cats.filter(c => this.backupSel.has(c.id)).length;
        const off = c => c.id === 'secrets' && !caps.allowSecrets;
        return `<section class="dw-sec">
            <div class="dw-sec-title">${title}<span class="dw-count">${n} / ${cats.length}</span><span class="dw-sp"></span>
                <button class="dw-link" data-act="bsel" data-mode="all">${t`Select all`}</button>
                <button class="dw-link" data-act="bsel" data-mode="def">${t`Default`}</button>
                <button class="dw-link" data-act="bsel" data-mode="none">${t`Clear`}</button>
            </div>
            <div class="dw-cats"><div class="dw-chips">${cats.map(c => `
                <button class="dw-chip${this.backupSel.has(c.id) ? ' on' : ''}${c.sensitive || c.adminOnly ? ' opt' : ''}" data-act="bcat" data-id="${c.id}" ${off(c) ? `disabled title="${t`The server does not allow exporting API keys`}"` : ''}>${c.sensitive ? ic('lock') : ''}${esc(c.label)}</button>`).join('')}
            </div></div>
        </section>
        ${this.backupSel.has('secrets') && caps.allowSecrets ? `<div class="dw-banner warning">${ic('key')}<span>${t`API keys will be included. Keep the file safe.`}</span></div>` : ''}`;
    }

    catSet(key) {
        return key === 's3' ? this.top.form.cats : this.top.cats;
    }

    // ---------- sync: list ----------

    viewList() {
        if (!this.snap.available) {
            return `<div class="dw-empty"><span class="dw-card-icon" style="--tone:var(--dw-danger)">${ic('warn')}</span><b>${t`Sync unavailable`}</b>
                <div>${esc(this.snap.unavailableReason || t`Sync is not enabled on the server`)}</div></div>`;
        }
        return `
            <div data-region="summary" style="display:contents">${this.renderSummary()}</div>
            <div data-region="top" style="display:contents">${this.renderTop()}</div>
            <div class="dw-cards" data-region="cards">${this.renderCards()}</div>`;
    }

    renderSummary() {
        const { backends } = this.snap;
        if (!backends.length) return '';
        const n = fn => backends.filter(fn).length;
        const parts = [`<span><b>${backends.length}</b> ${t`sync backends`}</span>`];
        if (n(b => b.state === 'error')) parts.push(`<span class="bad"><b>${n(b => b.state === 'error')}</b> ${t`backends failed`}</span>`);
        if (n(b => b.stalled?.length)) parts.push(`<span class="warn"><b>${n(b => b.stalled?.length)}</b> ${t`with files not updated`}</span>`);
        if (n(b => b.state === 'pending')) parts.push(`<span><b>${n(b => b.state === 'pending')}</b> ${t`waiting to connect`}</span>`);
        parts.push(`<span>${t`This device`} <b>${esc(this.snap.device.label || this.snap.device.placeholder)}</b></span>`);
        return `<div class="dw-summary">${parts.join('')}</div>`;
    }

    renderTop() {
        const { conflicts, notices, statusError, listError } = this.snap;
        let html = '';
        if (statusError) html += `<div class="dw-banner error">${ic('x')}<span>${t`Can't read sync status. Check the connection; it will update automatically once restored.`}</span></div>`;
        if (listError) html += `<div class="dw-banner error">${ic('x')}<span>${t`Couldn't refresh sync backends. Showing what was loaded last time.`}</span></div>`;
        if (conflicts.length || notices.length) {
            const text = conflicts.length
                ? (notices.length ? t`${conflicts.length} files need you to choose a version, plus ${notices.length} notices` : t`${conflicts.length} files need you to choose a version`)
                : t`${notices.length} sync notices`;
            html += `<div class="dw-banner warning">${ic('warn')}<span>${text}</span><button class="dw-btn sm" data-act="conflicts">${t`Resolve`}</button></div>`;
        }
        if (this.flash) {
            const f = this.flash;
            const icon = f.tone === 'error' ? 'x' : f.tone === 'warning' ? 'warn' : 'check';
            const files = f.files?.length ? `<code class="dw-files">${f.files.slice(0, 4).map(esc).join('<br>')}${f.files.length > 4 ? `<br>${t`and ${f.files.length} more`}` : ''}</code>` : '';
            html += `<div class="dw-banner ${f.tone}" data-flash="${f.tone}">${ic(icon)}<span>${esc(f.text)}${files}</span>
                ${f.act ? `<button class="dw-btn sm" data-act="${f.act}">${esc(f.actLabel)}</button>` : ''}
                <button class="dw-ibtn" data-act="flash-x" style="width:24px;height:24px">${ic('x')}</button></div>`;
        }
        return html;
    }

    renderCards() {
        const { backends } = this.snap;
        if (!backends.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('sync')}</span><b>${t`No sync backends yet`}</b>
                <button class="dw-btn primary" data-act="push" data-view="add">${ic('plus')}${t`Add`}</button></div>`;
        }
        return backends.map(b => this.renderCard(b)).join('');
    }

    renderCard(b) {
        const [tagCls, tagText] = stateTag()[b.state] || ['', ''];
        const detail = {
            running: t`Last: ${ago(b.lastSync)}`,
            ok: ago(b.lastSync),
            error: ago(b.lastSync),
            pending: t`The other device hasn't connected with the pairing link yet`,
            unknown: t`Pending records could not be read, so the status can't be determined yet`,
        }[b.state] || ago(b.lastSync);
        const running = b.state === 'running';
        let main = '';
        if (running) main = `<button class="dw-btn" disabled>${ic('sync', 'dw-spin')}${t`Syncing`}</button>`;
        else if (b.state !== 'pending') main = `<button class="dw-btn" data-act="sync-now" data-id="${b.id}">${ic('sync')}${b.state === 'error' ? t`Retry` : t`Sync now`}</button>`;
        const locked = this.isLocked(b.id);
        const menu = this.menu === b.id ? `
            <div class="dw-menu" role="menu">
                ${b.state === 'pending' ? '' : `
                ${b.canUndo ? `<button data-act="undo" data-id="${b.id}">${ic('undo')}${t`Undo last sync`}</button>` : ''}
                <button data-act="edit" data-id="${b.id}" ${locked ? 'disabled' : ''}>${ic('edit')}${t`Edit`}</button>
                ${b.kind === 's3' ? `<button data-act="unlock" data-id="${b.id}" ${running || locked ? 'disabled' : ''}>${ic('key')}${t`Unlock`}</button>` : ''}
                ${b.kind === 'lan' && b.hasStoredCredentials ? `<button data-act="clear-auth" data-id="${b.id}">${ic('key')}${t`Clear saved account`}</button>` : ''}
                <hr>`}
                <button class="danger" data-act="remove" data-id="${b.id}">${ic('trash')}${b.state === 'pending' ? t`Cancel pairing` : t`Remove`}</button>
            </div>` : '';
        const error = b.state === 'error' && b.error ? `<div class="dw-card-note bad">${esc(b.error)}</div>` : '';
        const stalled = b.stalled?.length
            ? `<div class="dw-stalled">${t`${b.stalled.length} files could not be updated; this device kept its current version`}${b.stalled.map(p => `<code>${esc(p)}</code>`).join('')}</div>`
            : '';
        return `
            <div class="dw-card${locked ? ' locked' : ''}" data-backend="${esc(b.id)}" data-kind="${b.kind}" data-state="${b.stalled?.length && b.state === 'ok' ? 'attention' : b.state}">
                <span class="dw-card-icon">${ic(b.kind === 's3' ? 'cloud' : 'lan')}</span>
                <div class="dw-card-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(b.label)}</span><span class="dw-kind">${b.kind === 's3' ? 'S3' : t`LAN`}</span></div>
                    <div class="dw-card-meta"><span class="dw-pilltag ${tagCls}">${tagText}</span><span>${esc(detail)}</span></div>
                </div>
                <div class="dw-card-act">
                    ${main}
                    <button class="dw-ibtn" data-act="menu" data-id="${b.id}" title="${t`More`}">${ic('more')}</button>
                    ${menu}
                </div>
                ${error}${stalled}
            </div>`;
    }

    viewSettings() {
        return `
            <div class="dw-list">
                <div class="dw-setrow"><span>${t`Device name`}</span>
                    <input class="dw-inp" data-model="device.label" value="${esc(this.f.device.label)}" placeholder="${esc(this.snap.device.placeholder)}"></div>
                <div class="dw-setrow"><span>${t`Sync after editing stops`}</span>
                    <span class="dw-num"><input class="dw-inp num" type="number" min="1" data-model="schedule.idle" value="${this.f.schedule.idle}"><span class="dw-unit">${t`sec`}</span></span></div>
                <div class="dw-setrow"><span>${t`Check other devices every`}</span>
                    <span class="dw-num"><input class="dw-inp num" type="number" min="1" data-model="schedule.poll" value="${this.f.schedule.poll}"><span class="dw-unit">${t`sec`}</span></span></div>
            </div>
            ${this.foot(`<button class="dw-btn primary big" data-act="save-local">${t`Save`}</button>`)}`;
    }

    // ---------- sync: add / pair / s3 ----------

    option(view, icon, title, tone = '') {
        return `<button class="dw-option ${tone}" data-act="push" data-view="${view}">
            <span class="dw-card-icon">${ic(icon)}</span><b>${title}</b>${ic('chev')}</button>`;
    }

    viewAdd() {
        return `<div class="dw-sec-title">${t`LAN`}</div>
            <div class="dw-options">
                ${this.option('pairNew', 'qr', t`Let another device connect`)}
                ${this.option('pairExist', 'link', t`Connect to another device`)}
            </div>
            <div class="dw-sec-title" style="margin-top:4px">${t`Cloud storage`}</div>
            <div class="dw-options">${this.option('s3', 'cloud', t`Use S3 storage`, 'blue')}</div>`;
    }

    viewPairNew() {
        const tp = this.top;
        tp.cats ??= defaultSyncCats(this.snap.syncCategories);
        tp.label ??= '';
        if (tp.result) {
            const link = tp.result.link(tp.addr);
            return `
                <div class="dw-step"><i>${ic('check')}</i>${t`Link generated. "${esc(tp.label)}" was added to the sync list and is waiting for the other device to connect`}</div>
                <div class="dw-step"><i>2</i>${t`On "${esc(tp.label)}", open "Connect to another device" and paste this link`}</div>
                ${tp.result.addresses.length > 1 ? `
                    <label class="dw-field"><span>${t`Address the other device uses to reach this one`}</span>
                        <select class="dw-inp" data-act-change="pair-addr">${tp.result.addresses.map(a => `<option value="${esc(a)}" ${a === tp.addr ? 'selected' : ''}>${esc(a)}${isLoopback(a) ? t`(this device only)` : ''}</option>`).join('')}</select>
                    </label>` : ''}
                ${isLoopback(tp.addr) ? `<div class="dw-banner warning">${ic('warn')}<span>${t`Only this device can reach this address; other devices can't connect`}</span></div>` : ''}
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(link)}">${ic('copy')}${t`Copy`}</button>
                    <button class="dw-btn icon" data-act="pair-gen" title="${t`Generate a new link (the old one stops working)`}">${ic('sync')}</button>
                </div>
                ${this.foot(`<button class="dw-btn big" data-act="done-pair">${t`Done`}</button>`)}`;
        }
        return `
            <label class="dw-field"><span>${t`Other device name`}</span><input class="dw-inp" data-model="top.label" value="${esc(tp.label)}" placeholder="${t`e.g. Phone, Laptop`}"></label>
            ${this.syncCats('pairNew', tp.cats)}
            ${tp.error ? `<div class="dw-err">${esc(tp.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="pair-gen">${tp.busy ? ic('sync', 'dw-spin') : ic('qr')}${t`Generate pairing link`}</button>`)}`;
    }

    viewPairExist() {
        const tp = this.top;
        tp.cats ??= defaultSyncCats(this.snap.syncCategories);
        tp.form ??= { link: '', url: '', peerId: '', code: '', handle: '', label: '', user: '', pass: '' };
        const f = tp.form;
        return `
            <label class="dw-field"><span>${t`Pairing link`}</span><input class="dw-inp mono" data-model="top.form.link" data-act-input="parse-link" value="${esc(f.link)}" placeholder="${t`Paste the link generated on the other device`}"></label>
            <details ${tp.manual ? 'open' : ''}>
                <summary class="dw-more">${ic('chev', 'dw-chev')}${t`Enter manually / the other device has a login password`}</summary>
                <div class="dw-more-body">
                    <div class="dw-grid2">
                        <label class="dw-field"><span>${t`Other device address`}</span><input class="dw-inp" data-model="top.form.url" value="${esc(f.url)}" placeholder="http://192.168.1.42:8000"></label>
                        <label class="dw-field"><span>${t`Other device ID`}</span><input class="dw-inp" data-model="top.form.peerId" value="${esc(f.peerId)}"></label>
                    </div>
                    <label class="dw-field"><span>${t`Other device name`}</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="${t`Leave blank to use the device ID`}"></label>
                    <div class="dw-grid2">
                        <label class="dw-field"><span>${t`Login account on the other device`}</span><input class="dw-inp" data-model="top.form.user" data-focus="user" value="${esc(f.user)}" autocomplete="off"></label>
                        <label class="dw-field"><span>${t`Password`}</span>${this.pw('top.form.pass', f.pass)}</label>
                    </div>
                </div>
            </details>
            ${this.syncCats('pairExist', tp.cats)}
            ${tp.error ? `<div class="dw-err">${esc(tp.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="pair-accept">${tp.busy ? `${ic('sync', 'dw-spin')}${t`Pairing…`}` : `${ic('link')}${t`Pair and sync`}`}</button>`)}`;
    }

    viewS3() {
        const tp = this.top;
        const editing = !!tp.id;
        if (!tp.form) {
            const base = editing ? this.p.getS3(tp.id) : { endpoint: '', region: '', bucket: '', prefix: '', pathStyle: false, stripQuotes: false };
            const b = editing ? this.snap.backends.find(x => x.id === tp.id) : null;
            tp.form = { label: b?.label || '', ...base, accessKey: '', secretKey: '', passphrase: '', cats: new Set(b?.categories || defaultSyncCats(this.snap.syncCategories)) };
        }
        const f = tp.form;
        const keep = editing ? t`Leave blank to keep the current value` : '';
        return `
            <label class="dw-field"><span>${t`Name`}</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="${t`e.g. Shared archive`}"></label>
            <div class="dw-group">
                <div class="dw-sec-title">${t`Storage location`}<span class="dw-sp"></span><span class="dw-lockhint">${ic('lock')}${t`Bucket and prefix cannot be changed after saving`}</span></div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>Endpoint</span><input class="dw-inp" data-model="top.form.endpoint" value="${esc(f.endpoint)}" placeholder="https://s3.example.com"></label>
                    <label class="dw-field"><span>${t`S3 region`}</span><input class="dw-inp" data-model="top.form.region" value="${esc(f.region)}" placeholder="us-east-1" list="dw-regions"></label>
                    <datalist id="dw-regions">${REGIONS.map(r => `<option value="${r}">`).join('')}</datalist>
                </div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>${t`Bucket name`}</span><input class="dw-inp" data-model="top.form.bucket" value="${esc(f.bucket)}" ${editing ? 'disabled' : ''}></label>
                    <label class="dw-field"><span>${t`Prefix`}</span><input class="dw-inp" data-model="top.form.prefix" value="${esc(f.prefix)}" placeholder="luker/" ${editing ? 'disabled' : ''}></label>
                </div>
                <button class="dw-toggle${f.pathStyle ? ' on' : ''}" data-act="toggle-path" type="button"><span class="dw-sw"></span>${t`Path-style requests (needed by MinIO, etc.)`}</button>
                <button class="dw-toggle${f.stripQuotes ? ' on' : ''}" data-act="toggle-quotes" type="button"><span class="dw-sw"></span>${t`Send ETag without quotes`}</button>
            </div>
            <div class="dw-group">
                <div class="dw-sec-title">${t`Credentials`}</div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>Access Key ID</span>${this.pw('top.form.accessKey', f.accessKey, keep)}</label>
                    <label class="dw-field"><span>Secret Access Key</span>${this.pw('top.form.secretKey', f.secretKey, keep)}</label>
                </div>
                <label class="dw-field"><span>${t`Encryption passphrase`}</span>${this.pw('top.form.passphrase', f.passphrase, editing ? keep : t`Other devices must use the same passphrase`)}</label>
            </div>
            ${this.syncCats('s3', f.cats)}
            ${tp.error ? `<div class="dw-err">${esc(tp.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="s3-save">${tp.busy ? `${ic('sync', 'dw-spin')}${t`Connecting…`}` : `${ic('check')}${t`Save`}`}</button>`)}`;
    }

    viewUnlock() {
        const tp = this.top;
        const b = this.snap.backends.find(x => x.id === tp.id);
        tp.form ??= { pass: '' };
        return `
            <div class="dw-card" data-state="${b?.state || 'ok'}" style="grid-template-columns:auto minmax(0,1fr)">
                <span class="dw-card-icon">${ic('cloud')}</span>
                <div class="dw-card-main"><div class="dw-card-title"><span class="dw-card-name">${esc(b?.label)}</span><span class="dw-kind">S3</span></div></div>
            </div>
            <label class="dw-field"><span>${t`Encryption passphrase`}</span>${this.pw('top.form.pass', tp.form.pass)}</label>
            ${tp.error ? `<div class="dw-err">${esc(tp.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="unlock-save">${tp.busy ? ic('sync', 'dw-spin') : ic('key')}${t`Unlock`}</button>`)}`;
    }

    viewLanEdit() {
        const tp = this.top;
        const b = this.snap.backends.find(x => x.id === tp.id);
        tp.label ??= b?.label || '';
        tp.cats ??= new Set(b?.categories || defaultSyncCats(this.snap.syncCategories));
        return `
            <label class="dw-field"><span>${t`Name`}</span><input class="dw-inp" data-model="top.label" value="${esc(tp.label)}"></label>
            ${this.syncCats('lanEdit', tp.cats)}
            ${tp.error ? `<div class="dw-err">${esc(tp.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">${t`Cancel`}</button>
                <button class="dw-btn primary big${tp.busy ? ' busy' : ''}" data-act="lan-save">${tp.busy ? ic('sync', 'dw-spin') : ic('check')}${t`Save`}</button>`)}`;
    }

    // ---------- sync: conflicts ----------

    viewConflicts() {
        const { conflicts, notices, backends } = this.snap;
        const stalled = [...new Set(backends.flatMap(b => b.stalled || []))];
        if (!conflicts.length && !notices.length && !stalled.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('check')}</span><b>${t`No sync issues to handle`}</b><button class="dw-btn" data-act="back">${t`Back`}</button></div>`;
        }
        const chosen = Object.keys(this.choices).filter(k => conflicts.some(c => c.key === k)).length;
        const failed = conflicts.filter(c => this.failedKeys.has(c.key));
        const preview = p => {
            if (!p) return '';
            if (p.kind === 'loading') return `<span class="dw-preview is-empty">${t`Reading…`}</span>`;
            if (p.kind === 'deleted') return `<span class="dw-preview is-empty">${t`The file is deleted in this version`}</span>`;
            if (p.kind === 'image') return `<span class="dw-preview is-image"><img src="${esc(p.url)}" alt=""></span>`;
            if (p.kind === 'error') return `<span class="dw-preview is-empty">${t`Failed to read: ${esc(p.message)}`}</span>`;
            return '';
        };
        const conflictHtml = conflicts.map(c => `
            <div class="dw-conflict${this.failedKeys.has(c.key) ? ' is-failed' : ''}" data-path="${esc(c.path)}" data-stale="${c.stale}">
                <div class="dw-conflict-head"><span class="dw-pilltag is-warn">${esc(c.kind)}</span><b title="${esc(c.path)}">${esc(c.path)}</b></div>
                ${c.stale ? `<div class="dw-banner warning">${ic('clock')}<span>${t`This file was edited again after the conflict; choosing another version will overwrite those changes`}</span></div>` : ''}
                <div class="dw-versions">${c.versions.map(v => `
                    <button class="dw-version${this.choices[c.key] === v.id ? ' on' : ''}" data-act="choose" data-key="${esc(c.key)}" data-v="${v.id}" ${c.unknown ? 'disabled' : ''}>
                        <span class="dw-version-head"><span class="dw-ring"></span><span>${v.current ? t`Current version` : t`Version from ${esc(v.from)}`}</span>${v.inUse ? `<span class="dw-pilltag is-ok">${t`In use`}</span>` : ''}</span>
                        ${preview(v.preview)}
                        ${v.sameAs?.length ? `<span class="dw-version-note">${t`Same as ${v.sameAs.join(', ')}`}</span>` : ''}
                        <span class="dw-version-act">${v.current ? t`Keep current version` : t`Use this version`}</span>
                    </button>`).join('')}
                </div>
                <div class="dw-conflict-diff" data-conflict-view="${esc(c.key)}"></div>
            </div>`).join('');
        const noticeHtml = notices.map(n => {
            const busy = this.noticeBusy.has(n.id);
            return `
            <div class="dw-notice" data-path="${esc(n.path)}">
                <span class="dw-card-icon">${ic(n.type === 'fork' ? 'branch' : 'chat')}</span>
                <div style="min-width:0"><b>${esc(n.title)}</b><small>${esc(n.missingGroup ? t`The group this chat belongs to can't be found, so it can't be opened` : n.detail)}</small></div>
                <div class="dw-notice-act">
                    <button class="dw-btn sm" data-act="notice-open" data-id="${n.id}" ${n.missingGroup || busy ? 'disabled' : ''}>${esc(n.action)}</button>
                    <button class="dw-btn sm ghost" data-act="notice-x" data-id="${n.id}" ${busy || n.unknown ? 'disabled' : ''}>${t`Close`}</button>
                </div>
            </div>`;
        }).join('');
        return `
            ${failed.length ? `<div class="dw-banner error">${ic('x')}<span>${t`These choices could not be applied. Try again.`}${failed.map(c => `<code class="dw-files">${esc(c.path)}</code>`).join('')}</span></div>` : ''}
            ${conflicts.length ? `<section class="dw-sec"><div class="dw-sec-title">${t`Choose the version to keep`}<span class="dw-sp"></span><span class="dw-count">${t`Selected ${chosen} / ${conflicts.length}`}</span></div><div class="dw-cards">${conflictHtml}</div></section>` : ''}
            ${notices.length ? `<section class="dw-sec"><div class="dw-sec-title">${t`Notices`}</div><div class="dw-cards">${noticeHtml}</div></section>` : ''}
            ${stalled.length ? `<section class="dw-sec"><div class="dw-sec-title">${t`Files not updated`}</div>
                <div class="dw-stalled">${t`The other device's version could not be stored here; this device kept its current version`}${stalled.map(p => `<code>${esc(p)}</code>`).join('')}</div></section>` : ''}
            ${conflicts.length ? this.foot(`<button class="dw-btn primary big${this.applying ? ' busy' : ''}" data-act="apply" ${chosen ? '' : `disabled title="${t`Choose a version for at least one file first`}"`}>${this.applying ? ic('sync', 'dw-spin') : ic('check')}${t`Apply choices`}</button>`) : ''}`;
    }

    viewBackup() {
        const b = this.f.backup;
        let status = '';
        if (b.running) {
            status = `<div class="dw-progress">
                <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>${b.stage === 'pack' ? t`Packing…` : t`Downloading…`}</span><span class="dw-sp"></span><span>${b.stage === 'download' ? `${b.percent}%` : b.loaded ? size(b.loaded) : ''}</span></div>
                ${b.stage === 'download' ? `<div class="dw-stages"><div class="dw-stage now" style="--p:${b.percent}%"></div></div>` : '<div class="dw-bar"></div>'}
            </div>`;
        } else if (b.done) {
            status = `<div class="dw-banner">${ic('check')}<span>${t`Downloaded ${esc(b.done.fileName)} (${size(b.done.size)})`}</span></div>`;
        }
        const blocked = !this.snap.caps.allowFullBackup;
        return `
            ${blocked ? `<div class="dw-banner error">${ic('lock')}<span>${t`The server has disabled backup downloads`}</span></div>` : ''}
            ${this.backupCats(t`Content to back up`)}
            ${status}
            ${this.foot(`<button class="dw-btn primary big${b.running ? ' busy' : ''}" data-act="backup-go" ${this.backupSel.size && !blocked ? this.lockAttr(b.running) : 'disabled'}>${ic('download')}${t`Download backup`}</button>`)}`;
    }

    viewRestore() {
        const r = this.f.restore;
        const file = r.file
            ? `<div class="dw-file"><span class="dw-card-icon">${ic('zip')}</span><div style="min-width:0"><b>${esc(r.file.name)}</b><small>${size(r.file.size)}${r.uploaded ? ` · ${t`Uploaded`}` : ''}</small></div>
                ${r.running ? '' : `<button class="dw-ibtn" data-act="file-x" title="${t`Remove`}">${ic('x')}</button>`}</div>`
            : `<div class="dw-drop" data-act="pick" role="button"><span class="dw-card-icon">${ic('upload')}</span><div>${t`Choose a backup ZIP, or drop it here`}</div></div>`;
        const pg = r.needsDb?.kind === 'postgres';
        const db = r.needsDb ? `
            <div class="dw-group">
                <div class="dw-sec-title">${ic('db')}${t`Temporary ${pg ? 'PostgreSQL' : 'MySQL'} connection`}<span class="dw-sp"></span><span class="dw-pilltag">${esc(r.needsDb.source)} → ${esc(r.needsDb.target)}</span></div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>${t`Host`}</span><input class="dw-inp" data-model="restore.db.host" value="${esc(r.db.host)}" placeholder="127.0.0.1"></label>
                    <label class="dw-field"><span>${t`Port`}</span><input class="dw-inp" data-model="restore.db.port" value="${esc(r.db.port)}" placeholder="${pg ? '5432' : '3306'}"></label>
                </div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>${t`Username`}</span><input class="dw-inp" data-model="restore.db.user" value="${esc(r.db.user)}" placeholder="${pg ? 'postgres' : 'root'}" autocomplete="off"></label>
                    <label class="dw-field"><span>${t`Password`}</span>${this.pw('restore.db.pass', r.db.pass)}</label>
                </div>
                <label class="dw-field"><span>${t`Database name`}</span><input class="dw-inp" data-model="restore.db.name" value="${esc(r.db.name)}" placeholder="${pg ? 'postgres' : 'mysql'}"></label>
            </div>` : '';
        const label = r.needsDb ? t`Continue restore` : r.mode === 'replace' ? t`Replace and restore` : t`Start restore`;
        return `
            ${file}
            <input type="file" accept=".zip,application/zip" data-role="file" hidden>
            ${this.modeRadios('restore', r.mode)}
            ${this.backupCats(t`Content to restore`)}
            ${db}
            ${this.renderRun(r, restoreStages(), t`Restore complete`)}
            ${r.done ? '' : this.foot(`<button class="dw-btn ${r.mode === 'replace' ? 'danger solid' : 'primary'} big${r.running ? ' busy' : ''}" data-act="restore-go" ${r.file && this.backupSel.size ? this.lockAttr(r.running) : 'disabled'}>${ic('restore')}${label}</button>`)}`;
    }

    modeRadios(set, mode) {
        return `<section class="dw-sec"><div class="dw-sec-title">${t`Restore mode`}</div>
            <div class="dw-radios">
                <button class="dw-radio${mode === 'merge' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="merge"><span class="dw-ring"></span><span>${t`Incremental`}</span></button>
                <button class="dw-radio danger${mode === 'replace' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="replace"><span class="dw-ring"></span><span>${t`Replace`}</span></button>
            </div></section>`;
    }

    renderRun(run, stages, doneText) {
        if (run.interrupted) {
            return `<div class="dw-banner error">${ic('x')}<span>${t`Upload interrupted at ${run.interrupted.percent}%`}</span>
                <button class="dw-btn sm" data-act="upload-resume">${t`Resume upload`}</button><button class="dw-btn sm ghost" data-act="upload-cancel">${t`Give up`}</button></div>`;
        }
        if (run.error) return `<div class="dw-banner error">${ic('x')}<span>${esc(run.error)}</span></div>`;
        if (run.done) {
            const d = run.done;
            // A restore that matched nothing is not a success: show it as a warning
            // and skip the auto-reload so the user reads it instead of missing it.
            // A database backup restores rows from its engine dump, so no files
            // written is not the same as nothing restored.
            const parts = [];
            if (d.empty) parts.push(t`No files were restored`);
            else if (d.restored) parts.push(t`Restored ${d.restored} files`);
            if (d.skipped) parts.push(t`${d.skipped} skipped`);
            if (d.rejected) parts.push(t`${d.rejected} rejected`);
            if (d.failed) parts.push(t`${d.failed} failed to write`);
            const warn = d.skipped || d.rejected || d.failed || d.empty;
            const sep = t`, `;
            const line = parts.length ? t`${doneText}: ${parts.join(sep)}` : doneText;
            return `<div class="dw-banner${warn ? ' warning' : ''}">${ic(warn ? 'warn' : 'check')}<span>${line}${d.crossEngine ? t` (${esc(d.crossEngine)})` : ''}</span>
                    <button class="dw-btn sm" data-act="reload">${this.isOtherUser ? t`Done` : t`Reload page`}</button></div>
                ${d.samples?.length ? `<details class="dw-fold"><summary>${ic('chev', 'dw-chev')}${t`View skipped files`}</summary>
                    <div class="dw-stalled" style="margin:0 12px 12px">${d.samples.map(x => `<code>${esc(x)}</code>`).join('')}</div></details>` : ''}`;
        }
        if (!run.running) return '';
        return `<div class="dw-progress">
            <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>${run.note ? esc(run.note) : (stages[run.stage] || stages[0])[1]}</span><span class="dw-sp"></span><span>${run.stage === 0 && run.percent ? `${run.percent}%` : ''}</span></div>
            <div class="dw-stages">${stages.map((s, i) => `<div class="dw-stage${i < run.stage ? ' done' : i === run.stage ? (i === 0 ? ' now' : ' now indet') : ''}" style="--p:${i === run.stage && i === 0 ? run.percent : 0}%">${s[0]}</div>`).join('')}</div>
        </div>`;
    }

    viewMigrate() {
        return `<div class="dw-options">
            ${this.option('migrateOut', 'upload', t`Migrate out of this device`)}
            ${this.option('migrateIn', 'download', t`Migrate into this device`, 'blue')}
        </div>`;
    }

    expireText() {
        const left = this.f.migrate.expiresAt - Date.now();
        return left > 0 ? `${ic('clock')}${t`Expires in ${clock(left)} · single use`}` : `${ic('clock')}${t`Expired`}`;
    }

    viewMigrateOut() {
        const m = this.f.migrate;
        if (m.link) {
            const link = m.link(m.addr);
            return `
                <div class="dw-step"><i>${ic('check')}</i>${t`Migration link generated`}</div>
                <div class="dw-step"><i>2</i>${t`Paste it into "Migrate into this device" on the new device`}</div>
                ${m.addresses.length > 1 ? `
                    <label class="dw-field"><span>${t`Address the new device uses to reach this one`}</span>
                        <select class="dw-inp" data-act-change="migrate-addr">${m.addresses.map(a => `<option value="${esc(a)}" ${a === m.addr ? 'selected' : ''}>${esc(a)}${isLoopback(a) ? t`(this device only)` : ''}</option>`).join('')}</select>
                    </label>` : ''}
                ${isLoopback(m.addr) ? `<div class="dw-banner warning">${ic('warn')}<span>${t`Only this device can reach this address; the new device can't open it`}</span></div>` : ''}
                ${m.addresses.every(isLoopback) ? `<label class="dw-field"><span>${t`This device's LAN address`}</span><input class="dw-inp" data-act-change="migrate-addr" value="${isLoopback(m.addr) ? '' : esc(m.addr)}" placeholder="192.168.1.20"></label>` : ''}
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(link)}">${ic('copy')}${t`Copy`}</button>
                    <button class="dw-btn icon" data-act="migrate-link" title="${t`Generate a new link`}">${ic('sync')}</button>
                </div>
                <span class="dw-expire" data-region="expire">${this.expireText()}</span>
                ${this.foot(`<button class="dw-btn big" data-act="back">${t`Done`}</button>`)}`;
        }
        return `
            ${this.backupCats(t`Content to migrate`)}
            ${this.foot(`<button class="dw-btn primary big${m.busy ? ' busy' : ''}" data-act="migrate-link" ${this.backupSel.size ? this.lockAttr(false) : 'disabled'}>${m.busy ? ic('sync', 'dw-spin') : ic('link')}${t`Generate migration link`}</button>`)}`;
    }

    viewMigrateIn() {
        const m = this.f.migrate;
        return `
            <label class="dw-field"><span>${t`Migration link`}</span><input class="dw-inp mono" data-model="migrate.inLink" value="${esc(m.inLink)}" placeholder="${t`Paste the link generated on the old device`}" ${m.running ? 'disabled' : ''}></label>
            ${this.modeRadios('migrate', m.mode)}
            ${this.backupCats(t`Content to migrate in`)}
            ${this.renderRun(m, migrateStages(), t`Migration complete`)}
            ${m.done ? '' : this.foot(`<button class="dw-btn ${m.mode === 'replace' ? 'danger solid' : 'primary'} big${m.running ? ' busy' : ''}" data-act="migrate-go" ${this.backupSel.size ? this.lockAttr(m.running) : 'disabled'}>${ic('move')}${t`Start migration`}</button>`)}`;
    }

    setModel(path, value) {
        const parts = path.split('.');
        let obj = parts[0] === 'top' ? this.top : this.f[parts[0]];
        for (const p of parts.slice(1, -1)) obj = obj[p];
        obj[parts[parts.length - 1]] = value;
    }

    onInput(e) {
        const el = e.target;
        if (el.dataset.model) this.setModel(el.dataset.model, el.value);
        if (/^(device|schedule)\./.test(el.dataset.model || '')) this.settingsTouched = true;
        if (el.dataset.actInput === 'parse-link') {
            const parsed = this.p.parsePairLink(el.value);
            if (!parsed) return;
            const { categories, ...fields } = parsed;
            Object.assign(this.top.form, fields);
            if (categories.length) this.top.cats = new Set(categories);
            this.top.error = null;
            this.rerender();
        }
    }

    onChange(e) {
        const el = e.target;
        if (el.dataset.actChange === 'pair-addr') {
            this.top.addr = el.value;
            this.rerender();
        }
        if (el.dataset.actChange === 'migrate-addr') {
            this.f.migrate.addr = el.value;
            this.rerender();
        }
        if (el.dataset.role === 'file' && el.files?.[0]) this.setFile(el.files[0]);
    }

    onDrag(e, over) {
        const drop = e.target.closest?.('.dw-drop');
        if (!drop) return;
        e.preventDefault();
        drop.classList.toggle('over', over);
    }

    onDrop(e) {
        if (!e.target.closest?.('.dw-drop')) return;
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) this.setFile(file);
    }

    setFile(file) {
        if (!/\.zip$/i.test(file.name)) {
            this.toast(t`Choose a backup file in .zip format`, true);
            return;
        }
        if (!file.size) {
            this.toast(t`This file is empty`, true);
            return;
        }
        Object.assign(this.f.restore, { file, needsDb: null, uploaded: false, error: null, done: null, interrupted: null });
        this.rerender();
    }

    get hasPopover() {
        return super.hasPopover || !!this.menu;
    }

    closePopovers() {
        this.menu = null;
        super.closePopovers();
    }

    dismiss(e, act) {
        super.dismiss(e, act);
        if (this.menu && act !== 'menu' && !e.target.closest('.dw-menu')) {
            this.menu = null;
            this.refreshRegion('cards');
        }
    }

    /**
     * Handles the data pages' own controls.
     * @param {string} act data-act of the control
     * @param {HTMLElement} el The control
     */
    async onAction(act, el) {
        const id = el.dataset.id;
        switch (act) {
            case 'conflicts':
                this.tab = 'sync';
                if (this.top.view !== 'conflicts') this.push('conflicts');
                else this.render();
                return;
            case 'flash-x':
                this.flash = null;
                return this.refreshRegion('top');
            case 'menu':
                this.menu = this.menu === id ? null : id;
                return this.refreshRegion('cards');
            case 'sync-now': return this.syncNow(id);
            case 'undo': return this.undo(id);
            case 'edit': {
                const b = this.snap.backends.find(x => x.id === id);
                return this.push(b.kind === 's3' ? 's3' : 'lanEdit', { id });
            }
            case 'unlock': return this.push('unlock', { id });
            case 'clear-auth': return this.backendAction(id, () => this.p.clearAuth(id), t`Saved account cleared`);
            case 'remove': return this.remove(id);
            case 'save-local': return this.saveLocal(el);
            case 'cat':
            case 'cat-group': return this.toggleCat(el);
            case 'bcat':
                if (el.disabled) return;
                this.backupSel.has(id) ? this.backupSel.delete(id) : this.backupSel.add(id);
                return this.rerender();
            case 'bsel': {
                const cats = this.snap.backupCategories.filter(c => !c.adminOnly || this.snap.isAdmin);
                const mode = el.dataset.mode;
                const allowed = cats.filter(c => c.id !== 'secrets' || this.snap.caps.allowSecrets);
                const ids = mode === 'all' ? allowed.map(c => c.id) : mode === 'def' ? allowed.filter(c => c.def).map(c => c.id) : [];
                this.backupSel.clear();
                ids.forEach(x => this.backupSel.add(x));
                return this.rerender();
            }
            case 'copy': return this.copy(el.dataset.text);
            case 'pair-gen': return this.pairGen();
            case 'pair-accept': return this.pairAccept();
            case 'toggle-quotes':
                this.top.form.stripQuotes = !this.top.form.stripQuotes;
                el.classList.toggle('on', this.top.form.stripQuotes);
                return;
            case 'toggle-path':
                this.top.form.pathStyle = !this.top.form.pathStyle;
                el.classList.toggle('on', this.top.form.pathStyle);
                return;
            case 's3-save': return this.s3Save();
            case 'unlock-save': return this.unlockSave();
            case 'lan-save': return this.lanSave();
            case 'choose':
                this.choices[el.dataset.key] = el.dataset.v;
                return this.rerender();
            case 'apply': return this.applyChoices();
            case 'notice-open': return this.openNotice(id);
            case 'notice-x': return this.dismissNotice(id);
            case 'done-pair':
                this.stack.sync = [{ view: 'list' }];
                return this.render();
            case 'upload-resume': return this.restoreGo(true);
            case 'upload-cancel':
                this.p.cancelUpload();
                Object.assign(this.f.restore, { interrupted: null, running: false });
                this.toast(t`Upload discarded`);
                return this.rerender();
            case 'backup-go': return this.backupGo();
            case 'pick': return this.root.querySelector('[data-role="file"]')?.click();
            case 'file-x':
                if (this.f.restore.uploaded || this.f.restore.interrupted) this.p.cancelUpload();
                Object.assign(this.f.restore, { file: null, needsDb: null, uploaded: false, error: null, interrupted: null });
                return this.rerender();
            case 'mode':
                this.f[el.dataset.set].mode = el.dataset.mode;
                return this.rerender();
            case 'restore-go': return this.restoreGo();
            case 'migrate-link': return this.migrateLink();
            case 'migrate-go': return this.migrateGo();
            case 'reload': return this.finish();
        }
    }

    toggleCat(el) {
        const set = this.catSet(el.dataset.set);
        if (el.dataset.act === 'cat') {
            set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id);
        } else {
            const ids = this.snap.syncCategories[Number(el.dataset.g)][1].map(i => i[0]);
            const all = ids.every(i => set.has(i));
            ids.forEach(i => all ? set.delete(i) : set.add(i));
        }
        this.rerender();
    }

    async copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.toast(t`Copied`);
        } catch {
            this.toast(t`Copy failed. Select and copy it manually.`, true);
        }
    }

    isLocked(id) {
        return this.pending.has(id) || !!this.p.isBusy(id);
    }

    async backendAction(id, fn, okText) {
        if (this.isLocked(id)) return;
        this.pending.add(id);
        this.menu = null;
        this.refreshRegion('cards');
        try {
            const result = await fn();
            if (okText) this.toast(typeof okText === 'function' ? okText(result) : okText);
            return result;
        } catch (err) {
            this.toast(err.message || String(err), true);
        } finally {
            this.pending.delete(id);
            this.refreshRegion('cards');
        }
    }

    async syncNow(id) {
        const b = this.snap.backends.find(x => x.id === id);
        if (this.isLocked(id)) return;
        this.flash = null;
        this.refreshRegion('top');
        this.pending.add(id);
        try {
            const r = await this.p.syncNow(id);
            if (r?.conflicts && r?.stalled) this.flash = { tone: 'warning', text: t`Synced with "${b.label}"; ${r.conflicts} files need you to choose a version, and ${r.stalled} files kept this device's version`, act: 'conflicts', actLabel: t`Resolve` };
            else if (r?.conflicts) this.flash = { tone: 'warning', text: t`Synced with "${b.label}"; ${r.conflicts} files need you to choose a version`, act: 'conflicts', actLabel: t`Resolve` };
            else if (r?.stalled) this.flash = { tone: 'warning', text: t`Synced with "${b.label}"; ${r.stalled} files could not be updated and kept this device's version` };
            else this.flash = { tone: 'success', text: t`Synced with "${b.label}"` };
        } catch (err) {
            console.error('[data-window] sync failed', err);
            this.flash = { tone: 'error', text: t`Sync with "${b.label}" failed: ${err.message}` };
        } finally {
            this.pending.delete(id);
            this.refreshLive();
        }
    }

    async undo(id) {
        const b = this.snap.backends.find(x => x.id === id);
        this.menu = null;
        this.refreshRegion('cards');
        if (!await this.confirm({ title: t`Undo the last sync with "${b.label}"?`, text: t`The undo itself will also sync to other devices.`, ok: t`Undo` })) return;
        if (this.isLocked(id)) return;
        this.pending.add(id);
        this.refreshRegion('cards');
        try {
            const r = await this.p.undo(id);
            this.flash = r?.kept?.length
                ? { tone: 'warning', text: t`Undone. The ${r.kept.length} files below were edited after the sync and kept their current version:`, files: r.kept }
                : { tone: 'success', text: t`Undid the last sync with "${b.label}"` };
        } catch (err) {
            this.flash = { tone: 'error', text: err.message };
        } finally {
            this.pending.delete(id);
            this.refreshLive();
        }
    }

    async remove(id) {
        const b = this.snap.backends.find(x => x.id === id);
        this.menu = null;
        this.refreshRegion('cards');
        const pendingPair = b.state === 'pending';
        const ok = await this.confirm(pendingPair
            ? { title: t`Cancel pairing with "${b.label}"?`, text: t`The pairing link you already sent will stop working.`, ok: t`Cancel pairing`, danger: true }
            : { title: t`Remove "${b.label}"?`, text: t`This device's sync settings and sync history will be deleted, and earlier syncs can no longer be undone. The bucket and data on other devices are not affected.`, ok: t`Remove`, danger: true });
        if (!ok) return;
        await this.backendAction(id, () => this.p.remove(id), pendingPair ? t`Pairing cancelled` : t`Removed`);
    }

    async saveLocal(btn) {
        const idle = Number(this.f.schedule.idle);
        const poll = Number(this.f.schedule.poll);
        if (!(idle > 0) || !(poll > 0)) {
            this.toast(t`Enter a number greater than 0 for the times`, true);
            return;
        }
        btn.classList.add('busy');
        try {
            this.f.device.label = await this.p.saveDevice(this.f.device.label.trim());
            this.f.schedule = { ...await this.p.saveSchedule(idle, poll) };
            this.rerender();
            this.toast(t`Saved`);
        } catch (err) {
            this.toast(err.code === 'INVALID_DEVICE_LABEL' ? t`Enter a valid device name` : err.message, true);
        } finally {
            btn.classList.remove('busy');
        }
    }

    async pairGen() {
        const tp = this.top;
        if (!tp.label.trim()) return this.formError(t`Enter the other device's name`);
        if (!tp.cats.size) return this.formError(t`Select at least one item to sync`);
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            tp.result = await this.p.createPairLink({ label: tp.label.trim(), categories: [...tp.cats] });
            tp.addr = firstReachable(tp.result.addresses);
        } catch (err) {
            tp.error = err.message;
        } finally {
            tp.busy = false;
            this.rerender();
        }
    }

    formError(text) {
        this.top.error = text;
        this.rerender();
        this.root.querySelector('.dw-err')?.scrollIntoView({ block: 'nearest' });
    }

    async pairAccept() {
        const tp = this.top;
        const f = tp.form;
        if (!f.url || !f.peerId) {
            tp.manual = !f.link;
            return this.formError(f.link ? t`This pairing link is not valid. Ask the other device to generate a new one.` : t`Paste the pairing link, or enter the other device's address and device ID manually`);
        }
        if (!tp.cats.size) return this.formError(t`Select at least one item to sync`);
        const me = this.p.currentHandle();
        if (f.handle && f.handle !== me) return this.formError(t`This pairing link is for user "${f.handle}", but you are signed in as "${me}"`);
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            const b = await this.p.acceptPair({ ...f, label: f.label.trim() || f.peerId, categories: [...tp.cats] });
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: f.user ? t`Paired and synced with "${b.label}". The other device's account is saved on this device and can be cleared from the device menu.` : t`Paired and synced with "${b.label}"` };
            this.render();
        } catch (err) {
            tp.busy = false;
            if (err.paired) {
                this.stack.sync = [{ view: 'list' }];
                this.flash = { tone: 'warning', text: t`Paired, but the first sync failed: ${err.message}` };
                return this.render();
            }
            if (/^PEER_AUTH/.test(err.code || '')) {
                tp.manual = true;
                tp.error = err.message;
                this.rerender();
                return this.root.querySelector('[data-focus="user"]')?.focus();
            }
            Object.assign(f, { code: '', pass: '', link: '' });
            tp.error = t`${err.message}. The pairing code is no longer valid; ask the other device to generate a new link.`;
            this.rerender();
        }
    }

    async s3Save() {
        const tp = this.top;
        const f = tp.form;
        const missing = [];
        const sep = t`, `;
        if (!f.label.trim()) missing.push(t`Name`);
        if (!f.endpoint.trim()) missing.push('Endpoint');
        if (!f.bucket.trim()) missing.push(t`Bucket name`);
        if (!tp.id && !f.accessKey) missing.push('Access Key ID');
        if (!tp.id && !f.secretKey) missing.push('Secret Access Key');
        if (!tp.id && !f.passphrase) missing.push(t`Encryption passphrase`);
        if (missing.length) return this.formError(t`Please fill in: ${missing.join(sep)}`);
        if (!f.cats.size) return this.formError(t`Select at least one item to sync`);
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            await this.p.saveS3({ ...f, region: f.region.trim() || 'us-east-1', categories: [...f.cats] }, tp.id);
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: tp.id ? t`Saved "${f.label}"` : t`Added "${f.label}"` };
            this.render();
        } catch (err) {
            tp.error = err.message;
            tp.busy = false;
            this.rerender();
        }
    }

    async unlockSave() {
        const tp = this.top;
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            await this.p.unlockS3(tp.id, tp.form.pass);
            this.pop();
            this.toast(t`Unlocked`);
        } catch (err) {
            tp.error = err.message;
            tp.busy = false;
            this.rerender();
        }
    }

    async lanSave() {
        const tp = this.top;
        if (!tp.label.trim()) return this.formError(t`Enter a name`);
        if (!tp.cats.size) return this.formError(t`Select at least one item to sync`);
        tp.busy = true;
        tp.error = null;
        this.rerender();
        try {
            await this.p.editLan(tp.id, { label: tp.label.trim(), categories: [...tp.cats] });
            this.pop();
            this.toast(t`Saved`);
        } catch (err) {
            tp.busy = false;
            tp.error = err.message;
            this.rerender();
        }
    }

    async applyChoices() {
        for (const c of this.snap.conflicts) {
            const pick = this.choices[c.key];
            if (c.stale && pick && pick !== 'current') {
                if (!await this.confirm({ title: t`Overwrite "${c.path.split('/').pop()}"?`, text: t`Changes made after the conflict will be overwritten; the overwritten version stays in sync history.`, ok: t`Overwrite`, danger: true })) return;
            }
        }
        this.applying = true;
        this.rerender();
        // Shown after the page is rebuilt: going back to the list rebuilds the whole window.
        let message = null;
        try {
            const picks = Object.fromEntries(this.snap.conflicts.filter(c => this.choices[c.key]).map(c => [c.key, { version: this.choices[c.key], review: c.review }]));
            const r = await this.p.applyConflicts(picks);
            this.failedKeys = new Set(r.failed.map(x => x.key));
            // Failed picks are cleared too: the file may have changed, so the user chooses again.
            for (const k of [...r.applied, ...r.alreadyResolved.map(x => x.key), ...r.failed.map(x => x.key)]) delete this.choices[k];
            if (r.alreadyResolved.length) message = [t`${r.alreadyResolved.length} files were already handled on another device`];
            else if (!r.failed.length) message = [t`Applied`];
        } catch (err) {
            message = [err.message, true];
        } finally {
            this.applying = false;
            const s = this.snap;
            if (s.conflicts.length || s.notices.length || s.backends.some(b => b.stalled?.length)) this.rerender();
            else this.pop();
            if (message) this.toast(...message);
        }
    }

    async openNotice(id) {
        this.noticeBusy.add(id);
        this.rerender();
        try {
            await this.p.openNotice(id);
            this.close?.();
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            this.noticeBusy.delete(id);
            if (this.root.isConnected) this.rerender();
        }
    }

    async dismissNotice(id) {
        this.noticeBusy.add(id);
        this.rerender();
        try {
            await this.p.dismissNotice(id);
        } catch (err) {
            this.toast(t`Some notices could not be dismissed: ${err.message}`, true);
        } finally {
            this.noticeBusy.delete(id);
            this.rerender();
        }
    }

    async backupGo() {
        const b = this.f.backup;
        Object.assign(b, { running: true, done: null, stage: 'pack', percent: 0 });
        this.rerender();
        try {
            b.done = await this.p.downloadBackup([...this.backupSel], p => {
                Object.assign(b, p);
                if (this.top.view === 'backup') this.rerender();
            });
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            b.running = false;
            if (this.top.view === 'backup') this.rerender();
        }
    }

    async restoreGo(resume = false) {
        const r = this.f.restore;
        if (!resume && !r.needsDb) {
            const ok = await this.confirm(r.mode === 'replace'
                ? { title: t`Replace and restore?`, text: t`The selected content will be cleared first, then the data in the backup is written.`, ok: t`Replace and restore`, danger: true }
                : { title: t`Start restore?`, text: t`Files at the same path will be replaced by the version in the backup; other files are left alone.`, ok: t`Start restore` });
            if (!ok) return;
        }
        if (r.needsDb) {
            const host = r.db.host.trim();
            const scheme = /^(mysql|postgres(ql)?):\/\//i.exec(host);
            const kind = r.needsDb.kind;
            const urlOk = !scheme || (!kind || scheme[1].toLowerCase().startsWith(kind)) && Boolean(dbUrlHost(host));
            if (!host || (scheme ? !urlOk : !r.db.user.trim())) {
                this.toast(t`Enter the host and username of the temporary database`, true);
                return;
            }
        }
        const initialPercent = resume ? r.interrupted?.percent || 0 : 0;
        Object.assign(r, { running: true, stage: 0, percent: initialPercent, note: '', error: null, done: null, interrupted: null });
        this.rerender();
        try {
            r.done = await this.p.restoreBackup({ file: r.file, mode: r.mode, categories: [...this.backupSel], tempDb: r.needsDb ? r.db : null, handle: this.handle }, p => {
                Object.assign(r, p);
                if (p.stage > 0) r.uploaded = true;
                if (this.top.view === 'restore') this.rerender();
            });
            Object.assign(r, { file: null, needsDb: null, uploaded: false });
            // A job keeps running after its window closes; do not schedule a
            // page reload or a close for a window that is already gone.
            if (this.root.isConnected && !r.done.skipped && !r.done.rejected && !r.done.failed && !r.done.empty) {
                clearTimeout(this.finishTimer);
                this.finishTimer = setTimeout(() => {
                    this.finishTimer = null;
                    if (this.f.restore.done) this.finish();
                }, 3000);
            }
        } catch (err) {
            if (err.code === 'needs-temp-db') {
                r.needsDb = { kind: err.kind, source: err.source, target: err.target };
            } else if (err.code === 'upload-interrupted') {
                r.interrupted = { percent: err.percent };
            } else {
                r.error = err.message;
            }
        } finally {
            r.running = false;
            if (this.top.view === 'restore') this.rerender();
        }
    }

    /** After a successful restore or migration the page reloads (or closes the per-user window). */
    finish() {
        clearTimeout(this.finishTimer);
        this.finishTimer = null;
        if (this.isOtherUser) {
            this.f.restore.done = null;
            this.f.migrate.done = null;
        }
        this.onDone?.();
    }

    async migrateLink() {
        const m = this.f.migrate;
        m.busy = true;
        this.rerender();
        try {
            const res = await this.p.createMigrationLink([...this.backupSel], this.handle);
            Object.assign(m, { link: res.link, addresses: res.addresses, addr: firstReachable(res.addresses), expiresAt: res.expiresAt });
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            m.busy = false;
            this.rerender();
        }
    }

    async migrateGo() {
        const m = this.f.migrate;
        if (!m.inLink.trim()) {
            this.toast(t`Paste the migration link first`, true);
            return;
        }
        const ok = await this.confirm(m.mode === 'replace'
            ? { title: t`Replace and migrate in?`, text: t`The selected content will be cleared first, then the data from the old device is written.`, ok: t`Replace and migrate in`, danger: true }
            : { title: t`Start migrating in?`, text: t`Files at the same path will be replaced by the version from the old device; other files are left alone.`, ok: t`Start migration` });
        if (!ok) return;
        Object.assign(m, { running: true, stage: 0, percent: 0, error: null, done: null });
        this.rerender();
        try {
            m.done = await this.p.migrateFromLink({ link: m.inLink, mode: m.mode, categories: [...this.backupSel], handle: this.handle }, p => {
                Object.assign(m, p);
                if (this.top.view === 'migrateIn') this.rerender();
            });
            m.inLink = '';
            if (this.root.isConnected && !m.done.skipped && !m.done.rejected && !m.done.failed && !m.done.empty) {
                clearTimeout(this.finishTimer);
                this.finishTimer = setTimeout(() => {
                    this.finishTimer = null;
                    if (this.f.migrate.done) this.finish();
                }, 3000);
            }
        } catch (err) {
            m.error = err.message;
        } finally {
            m.running = false;
            if (this.top.view === 'migrateIn') this.rerender();
        }
    }
}


/**
 * Opens the Account window on a data page, or brings the open one to the requested page.
 * @param {object} [options]
 * @param {string} [options.tab] Page to show first: 'sync', 'backup', 'restore', 'migrate', 'settings', or any Account page
 * @param {'conflicts'} [options.view] Sub-page to open inside the tab
 * @param {string} [options.handle] User whose data backup/restore/migration acts on (admin panel)
 * @param {() => void} [options.onDone] Called after a successful restore or migration
 * @returns {Promise<void>} Resolves when the window closes
 */
export async function openDataWindow(options = {}) {
    // Loaded lazily: the Account window builds on DataPages from this module.
    const { openAccountWindow } = await import('./account-window.js');
    return openAccountWindow({ tab: 'sync', ...options });
}
