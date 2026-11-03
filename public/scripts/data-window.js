// Data window: sync, backup, restore and migration in one floating window.
import { createMockProvider } from './data-window-mock.js';

const ICONS = {
    sync: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    cloud: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
    lan: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    warn: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6"/><path d="M12 8v4l3 2"/>',
    move: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    zip: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M11 7h1M11 10h1M11 13h1M10.5 16h2v2h-2z"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>',
    chat: '<path d="M5 18 3 21V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.6-2.4 2.1-2.4 3.6M12 17h.01"/>',
};

const TABS = [
    { key: 'sync', label: '同步', icon: 'sync' },
    { key: 'backup', label: '备份', icon: 'download' },
    { key: 'restore', label: '恢复', icon: 'restore' },
    { key: 'migrate', label: '迁移', icon: 'move' },
];

const TITLES = {
    list: '同步',
    backup: '备份',
    restore: '恢复',
    migrate: '迁移',
    settings: '本机设置',
    add: '添加同步对象',
    pairNew: '让另一台设备连过来',
    pairExist: '连接到另一台设备',
    s3: '添加 S3 存储',
    s3Edit: '编辑 S3 存储',
    unlock: '解锁 S3 存储',
    lanEdit: '编辑设备',
    conflicts: '同步问题',
    migrateOut: '迁出这台的数据',
    migrateIn: '迁入数据到这台',
};

const HELP = {
    list: ['同步会在这台和其他设备之间自动交换数据。局域网设备直接互连；S3 通过加密的存储桶中转。', '只要服务端在运行，关掉浏览器也会继续同步。冲突的文件会先保留可用版本，等你来选。'],
    settings: ['本机名称会出现在其他设备的版本记录里，留空就用主机名。改名只影响之后的修改，旧记录不变。', '编辑停下后等一段时间再同步；另外按检查间隔定期去其他设备看看有没有更新。'],
    add: ['局域网：两台设备要能互相访问。在一台上生成链接，到另一台粘贴。', 'S3：多台设备填同一个存储桶、前缀和加密口令即可。'],
    pairNew: ['链接只能用一次，里面带着对方的名字和要同步的内容。换地址不会换链接，点「重新生成」才会作废旧链接。', '对方要能用这里选的地址访问到本机。对方连过来时填的登录账号，会保存在对方的服务器上。'],
    pairExist: ['粘贴链接后，地址、设备 ID 和同步内容会自动填好。两台设备要用同一个用户登录，用户名里的特殊字符会变成下划线。', '对方开了登录密码才需要填账号；配对后保存在本机，可以随时在设备菜单里清除。'],
    s3: ['同一个桶、前缀、加密口令的设备会互相同步。', '桶和前缀保存后不能改。'],
    s3Edit: ['密钥和口令留空表示保留原来的值；桶和前缀保存后不能改。'],
    unlock: ['服务端重启后需要重新输入加密口令，才能继续读写这个存储桶。'],
    lanEdit: ['只改本机这一侧的名字和同步内容。'],
    conflicts: ['两台设备改了同一个文件、又合并不了时，会在这里等你选用哪个版本。', '选的不是「当前版本」时，会覆盖掉冲突之后的修改；被覆盖的版本仍留在同步历史里。'],
    backup: ['把选中的数据打包成一个 ZIP 下载到本地。', 'API 密钥默认不打包。备份、恢复、迁移共用同一组内容选择。'],
    restore: ['增量恢复：写入备份里的文件，同路径的文件会被替换，其他不动。', '覆盖恢复：先清空所选内容，再写入备份。', '上传之外的阶段不能中途取消。', '备份来自另一种数据库时，会要求填一个临时数据库连接用于中转。'],
    migrate: ['一次性把数据搬到另一台设备。多台设备长期使用，请用「同步」。'],
    migrateOut: ['链接很快失效，而且只能用一次。'],
    migrateIn: ['在旧设备上生成链接，粘贴到这里。'],
};

const THEMES = [
    { key: 'mist', label: '晨雾', dark: false, a: '#f3f4f2', b: '#13a68b' },
    { key: 'latte', label: '奶茶', dark: false, a: '#f3ece2', b: '#c0673b' },
    { key: 'ocean', label: '深海', dark: true, a: '#1c2433', b: '#4fd1b9' },
    { key: 'dusk', label: '暮紫', dark: true, a: '#2a2833', b: '#a594f9' },
];
const THEME_KEY = 'luker.dataWindow.theme';

function loadTheme() {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    if (THEMES.some(t => t.key === saved)) return saved;
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'mist' : 'ocean';
}

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1', 'ap-southeast-1', 'ap-east-1', 'ap-hongkong', 'ap-shanghai', 'ap-guangzhou', 'ap-beijing', 'oss-cn-hangzhou', 'oss-cn-shanghai', 'auto'];
const RESTORE_STAGES = ['上传', '整理', '检查', '恢复'];
const MIGRATE_STAGES = ['下载', '整理', '恢复'];
const STATE_TAG = { ok: ['is-ok', '已同步'], running: ['is-ok', '同步中'], error: ['is-bad', '失败'], pending: ['', '等待对方连接'], unknown: ['is-warn', '状态未知'] };

const ic = (name, cls = '') => `<svg class="dw-ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]);
}

function ago(ts) {
    if (!ts) return '从未同步';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
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

// Survives closing and reopening the window, like the old per-backend action lock.
const shared = { pending: new Set(), jobs: null, backupSel: null, provider: null };

class DataWindow {
    constructor(root, provider, { tab, view, handle, onDone }) {
        this.root = root;
        this.p = provider;
        this.tab = tab;
        this.handle = handle;
        this.onDone = onDone;
        this.stack = { sync: [{ view: 'list' }], backup: [{ view: 'backup' }], restore: [{ view: 'restore' }], migrate: [{ view: 'migrate' }], settings: [{ view: 'settings' }] };
        if (view) this.stack[tab].push({ view });
        this.pending = shared.pending;
        this.menu = null;
        this.flash = null;
        this.help = false;
        this.themeMenu = false;
        this.theme = loadTheme();
        this.choices = {};
        this.failedKeys = new Set();
        this.noticeBusy = new Set();
        const s = this.p.snapshot();
        shared.backupSel ??= new Set(s.backupCategories.filter(c => c.def && (c.id !== 'secrets' || s.caps.allowSecrets)).map(c => c.id));
        this.backupSel = shared.backupSel;
        shared.jobs ??= {
            backup: { running: false, stage: null, percent: 0, done: null },
            restore: { file: null, mode: 'merge', needsDb: null, db: { host: '', port: '', user: '', pass: '', name: '' }, running: false, stage: -1, percent: 0, note: '', done: null, error: null, interrupted: null },
            migrate: { link: null, addresses: [], addr: '', expiresAt: 0, inLink: '', mode: 'merge', running: false, stage: -1, percent: 0, done: null, error: null, busy: false },
        };
        this.f = { device: { label: s.device.label }, schedule: { ...s.schedule }, ...shared.jobs };

        this.root.addEventListener('click', e => this.onClick(e));
        this.root.addEventListener('input', e => this.onInput(e));
        this.root.addEventListener('change', e => this.onChange(e));
        this.root.addEventListener('dragover', e => this.onDrag(e, true));
        this.root.addEventListener('dragleave', e => this.onDrag(e, false));
        this.root.addEventListener('drop', e => this.onDrop(e));
        this.unsubscribe = this.p.subscribe(() => this.refreshLive());
        this.ticker = setInterval(() => this.tick(), 1000);
        this.render();
    }

    /** Opens another request in the already-open window. */
    navigate({ tab, view }) {
        if (tab) this.tab = tab;
        if (view && this.top.view !== view) this.stack[this.tab].push({ view });
        this.render();
    }

    /** Name of the long-running job in progress, if any. */
    get busyJob() {
        const { backup, restore, migrate } = this.f;
        if (backup.running) return '正在下载备份';
        if (restore.running) return '正在恢复';
        if (migrate.running) return '正在迁移';
        if (this.applying) return '正在应用冲突选择';
        return null;
    }

    /** Disabled attribute for a main button while another heavy job runs. */
    lockAttr(own) {
        const job = this.busyJob;
        return job && !own ? `disabled title="${job}，请等它完成"` : '';
    }

    destroy() {
        this.unsubscribe?.();
        clearInterval(this.ticker);
    }

    get snap() {
        return this.p.snapshot();
    }

    get top() {
        const s = this.stack[this.tab];
        return s[s.length - 1];
    }

    get viewKey() {
        return this.top.view === 's3' && this.top.id ? 's3Edit' : this.top.view;
    }

    push(view, params = {}) {
        this.stack[this.tab].push({ view, ...params });
        this.menu = null;
        this.help = false;
        this.render();
    }

    pop() {
        const s = this.stack[this.tab];
        if (s.length > 1) s.pop();
        this.help = false;
        this.render();
    }

    // ---------- shell ----------

    render() {
        const issues = this.snap.conflicts.length + this.snap.notices.length;
        const tab = t => `<button class="dw-tab" data-act="tab" data-tab="${t.key}" role="tab" aria-selected="${t.key === this.tab}">
            ${ic(t.icon)}<span>${t.label}</span>${t.key === 'sync' && issues ? `<span class="dw-tab-count">${issues}</span>` : ''}</button>`;
        this.root.innerHTML = `
            <header class="dw-titlebar">
                <span class="dw-mark">${ic('db')}</span>
                <span class="dw-title">数据</span>
                <span data-region="status"></span>
                <span class="dw-sp"></span>
                <button class="dw-ibtn${this.themeMenu ? ' on' : ''}" data-act="theme-menu" title="配色">${ic(THEMES.find(t => t.key === this.theme)?.dark ? 'moon' : 'sun')}</button>
                <button class="dw-ibtn${this.help ? ' on' : ''}" data-act="help" title="说明">${ic('help')}</button>
                <button class="dw-ibtn is-close" data-act="close" title="关闭">${ic('x')}</button>
            </header>
            <div class="dw-shell">
                <nav class="dw-rail" role="tablist">
                    ${TABS.map(tab).join('')}
                    <div class="dw-rail-foot">${tab({ key: 'settings', label: '本机设置', icon: 'gear' })}</div>
                </nav>
                <main class="dw-main"><div class="dw-body">${this.renderPage()}</div></main>
            </div>
            ${this.themeMenu ? `<div class="dw-themes" role="menu">${THEMES.map(t => `
                <button class="dw-theme" role="menuitemradio" aria-checked="${t.key === this.theme}" data-act="theme" data-theme="${t.key}">
                    <span class="dw-swatch" style="--a:${t.a};--b:${t.b}"></span><span>${t.label}</span>${t.key === this.theme ? ic('check') : ''}
                </button>`).join('')}</div>` : ''}
            ${this.help ? `<div class="dw-pop">${(HELP[this.viewKey] || HELP.list).map(l => `<p>${esc(l)}</p>`).join('')}</div>` : ''}`;
        this.renderStatus();
    }

    renderPage() {
        const deep = this.stack[this.tab].length > 1;
        const canAdd = this.top.view === 'list' && this.snap.available && this.snap.backends.length;
        const other = this.handle && this.handle !== this.p.currentHandle() && ['backup', 'restore', 'migrate'].includes(this.tab);
        const head = `<div class="dw-pagehead">
            ${deep ? `<button class="dw-ibtn" data-act="back" title="返回">${ic('back')}</button>` : ''}
            <h2 class="dw-h2">${esc(TITLES[this.viewKey])}</h2>
            <span class="dw-sp"></span>
            ${other ? `<span class="dw-pilltag is-warn">正在操作用户 ${esc(this.handle)}</span>` : ''}
            ${canAdd ? `<button class="dw-btn primary sm" data-act="push" data-view="add">${ic('plus')}添加</button>` : ''}
        </div>`;
        return head + this.renderView();
    }

    rerender() {
        const main = this.root.querySelector('.dw-main');
        const body = this.root.querySelector('.dw-body');
        if (!body) return;
        const scroll = main.scrollTop;
        body.innerHTML = this.renderPage();
        body.style.animation = 'none';
        main.scrollTop = scroll;
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

    foot(html) {
        return `<div class="dw-foot">${html}</div>`;
    }

    statusInfo() {
        const { backends, conflicts, notices, available, statusError } = this.snap;
        if (!available) return { tone: 'error', text: '同步不可用' };
        if (statusError) return { tone: 'error', text: '读不到同步状态' };
        const running = backends.find(b => b.state === 'running');
        if (running) return { tone: 'running', text: `正在同步 ${running.label} · ${clock(Date.now() - running.startedAt)}` };
        if (conflicts.length) return { tone: 'attention', text: `${conflicts.length} 个冲突待处理`, act: 'conflicts' };
        if (notices.length) return { tone: 'attention', text: `${notices.length} 条同步通知`, act: 'conflicts' };
        const failed = backends.find(b => b.state === 'error');
        if (failed) return { tone: 'error', text: `${failed.label} 同步失败` };
        const stalled = backends.filter(b => b.stalled?.length);
        if (stalled.length) return { tone: 'attention', text: `${stalled.reduce((n, b) => n + b.stalled.length, 0)} 个文件没能更新`, act: 'conflicts' };
        const synced = backends.filter(b => b.lastSync);
        if (!synced.length) return null;
        return { tone: 'ok', text: `已同步 · ${ago(Math.max(...synced.map(b => b.lastSync)))}` };
    }

    renderStatus() {
        const el = this.root.querySelector('[data-region="status"]');
        if (!el) return;
        const s = this.statusInfo();
        el.outerHTML = s
            ? `<span class="dw-title-ctx" data-region="status" data-tone="${s.tone}" ${s.act ? `data-act="${s.act}" role="button"` : ''}><i class="dw-dot"></i><span>${esc(s.text)}</span></span>`
            : '<span data-region="status"></span>';
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
        if (v === 'list') {
            this.refreshRegion('top');
            this.refreshRegion('cards');
            this.refreshRegion('summary');
        } else if (v === 'conflicts') {
            this.rerender();
        }
        const tab = this.root.querySelector('.dw-tab[data-tab="sync"]');
        if (tab) {
            const n = this.snap.conflicts.length + this.snap.notices.length;
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

    toast(text, error = false) {
        this.root.querySelector('.dw-toast')?.remove();
        const el = document.createElement('div');
        el.className = `dw-toast${error ? ' error' : ''}`;
        el.innerHTML = `${ic(error ? 'x' : 'check')}<span>${esc(text)}</span>`;
        this.root.append(el);
        setTimeout(() => el.remove(), 2800);
    }

    confirm({ title, text, ok = '确定', danger = false }) {
        return new Promise(resolve => {
            const el = document.createElement('div');
            el.className = 'dw-modal';
            el.innerHTML = `
                <div class="dw-modal-card" role="alertdialog">
                    <h4>${esc(title)}</h4>
                    ${text ? `<p>${esc(text)}</p>` : ''}
                    <div class="dw-actions">
                        <button class="dw-btn" data-r="0">取消</button>
                        <button class="dw-btn ${danger ? 'danger solid' : 'primary'}" data-r="1">${esc(ok)}</button>
                    </div>
                </div>`;
            this.modal = el;
            el.addEventListener('click', e => {
                e.stopPropagation();
                const btn = e.target.closest('[data-r]');
                if (!btn && e.target !== el) return;
                el.remove();
                this.modal = null;
                resolve(btn?.dataset.r === '1');
            });
            this.root.append(el);
            el.querySelector('[data-r="1"]').focus();
        });
    }

    // ---------- category pickers ----------

    syncCats(key, set) {
        return `<section class="dw-sec">
            <div class="dw-sec-title">同步内容<span class="dw-sp"></span><span class="dw-count">已选 ${set.size} / ${allSyncCats(this.snap.syncCategories).length}</span></div>
            <div class="dw-cats">${this.snap.syncCategories.map(([group, items], gi) => `
                <div class="dw-cat-g">
                    <button data-act="cat-group" data-set="${key}" data-g="${gi}" title="全选 / 全不选">${esc(group)}</button>
                    <div class="dw-chips">${items.map(([id, label, opt]) => `
                        <button class="dw-chip${set.has(id) ? ' on' : ''}${opt ? ' opt' : ''}" data-act="cat" data-set="${key}" data-id="${id}" ${opt ? 'title="默认不同步"' : ''}>${opt ? ic('lock') : ''}${esc(label)}</button>`).join('')}
                    </div>
                </div>`).join('')}
            </div>
        </section>`;
    }

    backupCats(title = '内容') {
        const { backupCategories, isAdmin, caps } = this.snap;
        const cats = backupCategories.filter(c => !c.adminOnly || isAdmin);
        const n = cats.filter(c => this.backupSel.has(c.id)).length;
        const off = c => c.id === 'secrets' && !caps.allowSecrets;
        return `<section class="dw-sec">
            <div class="dw-sec-title">${title}<span class="dw-count">${n} / ${cats.length}</span><span class="dw-sp"></span>
                <button class="dw-link" data-act="bsel" data-mode="all">全选</button>
                <button class="dw-link" data-act="bsel" data-mode="def">默认</button>
                <button class="dw-link" data-act="bsel" data-mode="none">清空</button>
            </div>
            <div class="dw-cats"><div class="dw-chips">${cats.map(c => `
                <button class="dw-chip${this.backupSel.has(c.id) ? ' on' : ''}${c.sensitive || c.adminOnly ? ' opt' : ''}" data-act="bcat" data-id="${c.id}" ${off(c) ? 'disabled title="服务器不允许导出 API 密钥"' : ''}>${c.sensitive ? ic('lock') : ''}${esc(c.label)}</button>`).join('')}
            </div></div>
        </section>
        ${this.backupSel.has('secrets') && caps.allowSecrets ? `<div class="dw-banner warning">${ic('key')}<span>会包含 API 密钥，请妥善保管文件</span></div>` : ''}`;
    }

    catSet(key) {
        return key === 's3' ? this.top.form.cats : this.top.cats;
    }

    // ---------- sync: list ----------

    viewList() {
        if (!this.snap.available) {
            return `<div class="dw-empty"><span class="dw-card-icon" style="--tone:var(--dw-danger)">${ic('warn')}</span><b>同步不可用</b>
                <div>${esc(this.snap.unavailableReason || '服务器没有开启同步功能')}</div></div>`;
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
        const parts = [`<span><b>${backends.length}</b> 个同步对象</span>`];
        if (n(b => b.state === 'error')) parts.push(`<span class="bad"><b>${n(b => b.state === 'error')}</b> 个失败</span>`);
        if (n(b => b.stalled?.length)) parts.push(`<span class="warn"><b>${n(b => b.stalled?.length)}</b> 个有文件没能更新</span>`);
        if (n(b => b.state === 'pending')) parts.push(`<span><b>${n(b => b.state === 'pending')}</b> 个等待连接</span>`);
        parts.push(`<span>本机 <b>${esc(this.snap.device.label || this.snap.device.placeholder)}</b></span>`);
        return `<div class="dw-summary">${parts.join('')}</div>`;
    }

    renderTop() {
        const { conflicts, notices, statusError, listError } = this.snap;
        let html = '';
        if (statusError) html += `<div class="dw-banner error">${ic('x')}<span>读不到同步状态，请检查连接，恢复后会自动更新</span></div>`;
        if (listError) html += `<div class="dw-banner error">${ic('x')}<span>刷新同步对象失败，下面是上次读到的内容</span></div>`;
        if (conflicts.length || notices.length) {
            const text = conflicts.length ? `${conflicts.length} 个文件需要你选版本${notices.length ? `，另有 ${notices.length} 条通知` : ''}` : `${notices.length} 条同步通知`;
            html += `<div class="dw-banner warning">${ic('warn')}<span>${text}</span><button class="dw-btn sm" data-act="conflicts">去处理</button></div>`;
        }
        if (this.flash) {
            const f = this.flash;
            const icon = f.tone === 'error' ? 'x' : f.tone === 'warning' ? 'warn' : 'check';
            const files = f.files?.length ? `<code class="dw-files">${f.files.slice(0, 4).map(esc).join('<br>')}${f.files.length > 4 ? `<br>等 ${f.files.length} 个` : ''}</code>` : '';
            html += `<div class="dw-banner ${f.tone}">${ic(icon)}<span>${esc(f.text)}${files}</span>
                ${f.act ? `<button class="dw-btn sm" data-act="${f.act}">${esc(f.actLabel)}</button>` : ''}
                <button class="dw-ibtn" data-act="flash-x" style="width:24px;height:24px">${ic('x')}</button></div>`;
        }
        return html;
    }

    renderCards() {
        const { backends } = this.snap;
        if (!backends.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('sync')}</span><b>还没有同步对象</b>
                <button class="dw-btn primary" data-act="push" data-view="add">${ic('plus')}添加</button></div>`;
        }
        return backends.map(b => this.renderCard(b)).join('');
    }

    renderCard(b) {
        const [tagCls, tagText] = STATE_TAG[b.state] || ['', ''];
        const detail = {
            running: `上次 ${ago(b.lastSync)}`,
            ok: ago(b.lastSync),
            error: ago(b.lastSync),
            pending: '对方还没用配对链接连过来',
            unknown: '待处理记录读取失败，暂时无法判断',
        }[b.state] || ago(b.lastSync);
        const running = b.state === 'running';
        let main = '';
        if (running) main = `<button class="dw-btn" disabled>${ic('sync', 'dw-spin')}同步中</button>`;
        else if (b.state !== 'pending') main = `<button class="dw-btn" data-act="sync-now" data-id="${b.id}">${ic('sync')}${b.state === 'error' ? '重试' : '立即同步'}</button>`;
        const locked = this.pending.has(b.id);
        const menu = this.menu === b.id ? `
            <div class="dw-menu" role="menu">
                ${b.state === 'pending' ? '' : `
                ${b.canUndo ? `<button data-act="undo" data-id="${b.id}">${ic('undo')}撤销上次同步</button>` : ''}
                <button data-act="edit" data-id="${b.id}" ${running ? 'disabled' : ''}>${ic('edit')}编辑</button>
                ${b.kind === 's3' ? `<button data-act="unlock" data-id="${b.id}" ${running ? 'disabled' : ''}>${ic('key')}解锁</button>` : ''}
                ${b.kind === 'lan' && b.hasStoredCredentials ? `<button data-act="clear-auth" data-id="${b.id}">${ic('key')}清除保存的账号</button>` : ''}
                <hr>`}
                <button class="danger" data-act="remove" data-id="${b.id}">${ic('trash')}${b.state === 'pending' ? '取消配对' : '移除'}</button>
            </div>` : '';
        const error = b.state === 'error' && b.error ? `<div class="dw-card-note bad">${esc(b.error)}</div>` : '';
        const stalled = b.stalled?.length
            ? `<div class="dw-stalled">${b.stalled.length} 个文件没能更新，本机保留了当前版本${b.stalled.map(p => `<code>${esc(p)}</code>`).join('')}</div>`
            : '';
        return `
            <div class="dw-card${locked ? ' locked' : ''}" data-state="${b.stalled?.length && b.state === 'ok' ? 'attention' : b.state}">
                <span class="dw-card-icon">${ic(b.kind === 's3' ? 'cloud' : 'lan')}</span>
                <div class="dw-card-main">
                    <div class="dw-card-title"><span class="dw-card-name">${esc(b.label)}</span><span class="dw-kind">${b.kind === 's3' ? 'S3' : '局域网'}</span></div>
                    <div class="dw-card-meta"><span class="dw-pilltag ${tagCls}">${tagText}</span><span>${esc(detail)}</span></div>
                </div>
                <div class="dw-card-act">
                    ${main}
                    <button class="dw-ibtn" data-act="menu" data-id="${b.id}" title="更多">${ic('more')}</button>
                    ${menu}
                </div>
                ${error}${stalled}
            </div>`;
    }

    viewSettings() {
        return `
            <div class="dw-list">
                <div class="dw-setrow"><span>本机名称</span>
                    <input class="dw-inp" data-model="device.label" value="${esc(this.f.device.label)}" placeholder="${esc(this.snap.device.placeholder)}"></div>
                <div class="dw-setrow"><span>编辑停下后多久同步</span>
                    <span class="dw-num"><input class="dw-inp num" type="number" min="1" data-model="schedule.idle" value="${this.f.schedule.idle}"><span class="dw-unit">秒</span></span></div>
                <div class="dw-setrow"><span>多久检查一次其他设备</span>
                    <span class="dw-num"><input class="dw-inp num" type="number" min="1" data-model="schedule.poll" value="${this.f.schedule.poll}"><span class="dw-unit">秒</span></span></div>
            </div>
            ${this.foot('<button class="dw-btn primary big" data-act="save-local">保存</button>')}`;
    }

    // ---------- sync: add / pair / s3 ----------

    option(view, icon, title, tone = '') {
        return `<button class="dw-option ${tone}" data-act="push" data-view="${view}">
            <span class="dw-card-icon">${ic(icon)}</span><b>${title}</b>${ic('chev')}</button>`;
    }

    viewAdd() {
        return `<div class="dw-sec-title">局域网</div>
            <div class="dw-options">
                ${this.option('pairNew', 'qr', '让另一台设备连过来')}
                ${this.option('pairExist', 'link', '连接到另一台设备')}
            </div>
            <div class="dw-sec-title" style="margin-top:4px">云存储</div>
            <div class="dw-options">${this.option('s3', 'cloud', '使用 S3 存储', 'blue')}</div>`;
    }

    viewPairNew() {
        const t = this.top;
        t.cats ??= defaultSyncCats(this.snap.syncCategories);
        t.label ??= '';
        if (t.result) {
            const link = t.result.link(t.addr);
            return `
                <div class="dw-step"><i>${ic('check')}</i>链接已生成，「${esc(t.label)}」已加到同步列表，等待对方连接</div>
                <div class="dw-step"><i>2</i>在「${esc(t.label)}」上打开「连接到另一台设备」，粘贴这条链接</div>
                ${t.result.addresses.length > 1 ? `
                    <label class="dw-field"><span>对方通过哪个地址访问本机</span>
                        <select class="dw-inp" data-act-change="pair-addr">${t.result.addresses.map(a => `<option value="${esc(a)}" ${a === t.addr ? 'selected' : ''}>${esc(a)}${isLoopback(a) ? '（仅本机）' : ''}</option>`).join('')}</select>
                    </label>` : ''}
                ${isLoopback(t.addr) ? `<div class="dw-banner warning">${ic('warn')}<span>这个地址只有本机能访问，其他设备连不上</span></div>` : ''}
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(link)}">${ic('copy')}复制</button>
                    <button class="dw-btn icon" data-act="pair-gen" title="换一条新链接（旧的作废）">${ic('sync')}</button>
                </div>
                ${this.foot('<button class="dw-btn big" data-act="done-pair">完成</button>')}`;
        }
        return `
            <label class="dw-field"><span>对方设备名称</span><input class="dw-inp" data-model="top.label" value="${esc(t.label)}" placeholder="例如：手机、笔记本"></label>
            ${this.syncCats('pairNew', t.cats)}
            ${t.error ? `<div class="dw-err">${esc(t.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="pair-gen">${t.busy ? ic('sync', 'dw-spin') : ic('qr')}生成配对链接</button>`)}`;
    }

    viewPairExist() {
        const t = this.top;
        t.cats ??= defaultSyncCats(this.snap.syncCategories);
        t.form ??= { link: '', url: '', peerId: '', code: '', handle: '', label: '', user: '', pass: '' };
        const f = t.form;
        return `
            <label class="dw-field"><span>配对链接</span><input class="dw-inp mono" data-model="top.form.link" data-act-input="parse-link" value="${esc(f.link)}" placeholder="粘贴另一台设备生成的链接"></label>
            <details ${t.manual ? 'open' : ''}>
                <summary class="dw-more">${ic('chev', 'dw-chev')}手动填写 / 对方设置了登录密码</summary>
                <div class="dw-more-body">
                    <div class="dw-grid2">
                        <label class="dw-field"><span>对方地址</span><input class="dw-inp" data-model="top.form.url" value="${esc(f.url)}" placeholder="http://192.168.1.42:8000"></label>
                        <label class="dw-field"><span>对方设备 ID</span><input class="dw-inp" data-model="top.form.peerId" value="${esc(f.peerId)}"></label>
                    </div>
                    <label class="dw-field"><span>对方设备名称</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="留空就用设备 ID"></label>
                    <div class="dw-grid2">
                        <label class="dw-field"><span>对方的登录账号</span><input class="dw-inp" data-model="top.form.user" data-focus="user" value="${esc(f.user)}" autocomplete="off"></label>
                        <label class="dw-field"><span>密码</span>${this.pw('top.form.pass', f.pass)}</label>
                    </div>
                </div>
            </details>
            ${this.syncCats('pairExist', t.cats)}
            ${t.error ? `<div class="dw-err">${esc(t.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="pair-accept">${t.busy ? `${ic('sync', 'dw-spin')}正在配对…` : `${ic('link')}配对并同步`}</button>`)}`;
    }

    pw(model, value, placeholder = '') {
        return `<span class="dw-pw"><input class="dw-inp" type="password" data-model="${model}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="new-password"><button class="dw-eye" data-act="eye" type="button" title="显示">${ic('eye')}</button></span>`;
    }

    viewS3() {
        const t = this.top;
        const editing = !!t.id;
        if (!t.form) {
            const base = editing ? this.p.getS3(t.id) : { endpoint: '', region: '', bucket: '', prefix: '', pathStyle: false };
            const b = editing ? this.snap.backends.find(x => x.id === t.id) : null;
            t.form = { label: b?.label || '', ...base, accessKey: '', secretKey: '', passphrase: '', cats: new Set(b?.categories || defaultSyncCats(this.snap.syncCategories)) };
        }
        const f = t.form;
        const keep = editing ? '留空则保留原值' : '';
        return `
            <label class="dw-field"><span>名称</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="例如：共享归档"></label>
            <div class="dw-group">
                <div class="dw-sec-title">存储位置<span class="dw-sp"></span><span class="dw-lockhint">${ic('lock')}桶和前缀保存后不能改</span></div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>Endpoint</span><input class="dw-inp" data-model="top.form.endpoint" value="${esc(f.endpoint)}" placeholder="https://s3.example.com"></label>
                    <label class="dw-field"><span>区域</span><input class="dw-inp" data-model="top.form.region" value="${esc(f.region)}" placeholder="us-east-1" list="dw-regions"></label>
                    <datalist id="dw-regions">${REGIONS.map(r => `<option value="${r}">`).join('')}</datalist>
                </div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>桶</span><input class="dw-inp" data-model="top.form.bucket" value="${esc(f.bucket)}" ${editing ? 'disabled' : ''}></label>
                    <label class="dw-field"><span>前缀</span><input class="dw-inp" data-model="top.form.prefix" value="${esc(f.prefix)}" placeholder="luker/" ${editing ? 'disabled' : ''}></label>
                </div>
                <button class="dw-toggle${f.pathStyle ? ' on' : ''}" data-act="toggle-path" type="button"><span class="dw-sw"></span>路径风格请求（MinIO 等需要）</button>
            </div>
            <div class="dw-group">
                <div class="dw-sec-title">访问凭据</div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>Access Key ID</span>${this.pw('top.form.accessKey', f.accessKey, keep)}</label>
                    <label class="dw-field"><span>Secret Access Key</span>${this.pw('top.form.secretKey', f.secretKey, keep)}</label>
                </div>
                <label class="dw-field"><span>加密口令</span>${this.pw('top.form.passphrase', f.passphrase, editing ? keep : '其他设备要用同一个口令')}</label>
            </div>
            ${this.syncCats('s3', f.cats)}
            ${t.error ? `<div class="dw-err">${esc(t.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">取消</button>
                <button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="s3-save">${t.busy ? `${ic('sync', 'dw-spin')}正在连接…` : `${ic('check')}保存`}</button>`)}`;
    }

    viewUnlock() {
        const t = this.top;
        const b = this.snap.backends.find(x => x.id === t.id);
        t.form ??= { pass: '' };
        return `
            <div class="dw-card" data-state="${b?.state || 'ok'}" style="grid-template-columns:auto minmax(0,1fr)">
                <span class="dw-card-icon">${ic('cloud')}</span>
                <div class="dw-card-main"><div class="dw-card-title"><span class="dw-card-name">${esc(b?.label)}</span><span class="dw-kind">S3</span></div></div>
            </div>
            <label class="dw-field"><span>加密口令</span>${this.pw('top.form.pass', t.form.pass)}</label>
            ${t.error ? `<div class="dw-err">${esc(t.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">取消</button>
                <button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="unlock-save">${t.busy ? ic('sync', 'dw-spin') : ic('key')}解锁</button>`)}`;
    }

    viewLanEdit() {
        const t = this.top;
        const b = this.snap.backends.find(x => x.id === t.id);
        t.label ??= b?.label || '';
        t.cats ??= new Set(b?.categories || defaultSyncCats(this.snap.syncCategories));
        return `
            <label class="dw-field"><span>名称</span><input class="dw-inp" data-model="top.label" value="${esc(t.label)}"></label>
            ${this.syncCats('lanEdit', t.cats)}
            ${t.error ? `<div class="dw-err">${esc(t.error)}</div>` : ''}
            ${this.foot(`<button class="dw-btn big" data-act="back">取消</button>
                <button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="lan-save">${t.busy ? ic('sync', 'dw-spin') : ic('check')}保存</button>`)}`;
    }

    // ---------- sync: conflicts ----------

    viewConflicts() {
        const { conflicts, notices, backends } = this.snap;
        const stalled = [...new Set(backends.flatMap(b => b.stalled || []))];
        if (!conflicts.length && !notices.length && !stalled.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('check')}</span><b>没有待处理的同步问题</b><button class="dw-btn" data-act="back">返回</button></div>`;
        }
        const chosen = Object.keys(this.choices).filter(k => conflicts.some(c => c.key === k)).length;
        const failed = conflicts.filter(c => this.failedKeys.has(c.key));
        const preview = p => {
            if (!p || p.kind === 'deleted') return '<span class="dw-preview is-empty">这个版本里文件已被删除</span>';
            if (p.kind === 'image') return `<span class="dw-preview is-image"><img src="${esc(p.url)}" alt=""></span>`;
            if (p.kind === 'binary') return `<span class="dw-preview is-empty">二进制文件 ${size(p.bytes)}</span>`;
            if (p.kind === 'error') return `<span class="dw-preview is-empty">读取失败：${esc(p.message)}</span>`;
            return `<span class="dw-preview">${esc(p.text)}</span>`;
        };
        const conflictHtml = conflicts.map(c => `
            <div class="dw-conflict${this.failedKeys.has(c.key) ? ' is-failed' : ''}">
                <div class="dw-conflict-head"><span class="dw-pilltag is-warn">${esc(c.kind)}</span><b title="${esc(c.path)}">${esc(c.path)}</b></div>
                ${c.stale ? `<div class="dw-banner warning">${ic('clock')}<span>冲突之后这个文件又改过，选其他版本会覆盖这些修改</span></div>` : ''}
                <div class="dw-versions">${c.versions.map(v => `
                    <button class="dw-version${this.choices[c.key] === v.id ? ' on' : ''}" data-act="choose" data-key="${c.key}" data-v="${v.id}" ${c.unknown ? 'disabled' : ''}>
                        <span class="dw-version-head"><span class="dw-ring"></span><span>${v.current ? '当前版本' : `来自 ${esc(v.from)} 的版本`}</span>${v.inUse ? '<span class="dw-pilltag is-ok">正在使用</span>' : ''}</span>
                        ${preview(v.preview)}
                        <span class="dw-version-act">${v.current ? '保留当前版本' : '使用此版本'}</span>
                    </button>`).join('')}
                </div>
            </div>`).join('');
        const noticeHtml = notices.map(n => {
            const busy = this.noticeBusy.has(n.id);
            return `
            <div class="dw-notice">
                <span class="dw-card-icon">${ic(n.type === 'fork' ? 'branch' : 'chat')}</span>
                <div style="min-width:0"><b>${esc(n.title)}</b><small>${esc(n.missingGroup ? '找不到这个聊天所在的群，无法打开' : n.detail)}</small></div>
                <div class="dw-notice-act">
                    <button class="dw-btn sm" data-act="notice-open" data-id="${n.id}" ${n.missingGroup || busy ? 'disabled' : ''}>${esc(n.action)}</button>
                    <button class="dw-btn sm ghost" data-act="notice-x" data-id="${n.id}" ${busy ? 'disabled' : ''}>关闭</button>
                </div>
            </div>`;
        }).join('');
        return `
            ${failed.length ? `<div class="dw-banner error">${ic('x')}<span>这些选择暂时没能应用，请再试一次${failed.map(c => `<code class="dw-files">${esc(c.path)}</code>`).join('')}</span></div>` : ''}
            ${conflicts.length ? `<section class="dw-sec"><div class="dw-sec-title">选择要保留的版本<span class="dw-sp"></span><span class="dw-count">已选 ${chosen} / ${conflicts.length}</span></div><div class="dw-cards">${conflictHtml}</div></section>` : ''}
            ${notices.length ? `<section class="dw-sec"><div class="dw-sec-title">通知</div><div class="dw-cards">${noticeHtml}</div></section>` : ''}
            ${stalled.length ? `<section class="dw-sec"><div class="dw-sec-title">没能更新的文件</div>
                <div class="dw-stalled">对方的版本存不到本机，已保留本机当前版本${stalled.map(p => `<code>${esc(p)}</code>`).join('')}</div></section>` : ''}
            ${conflicts.length ? this.foot(`<button class="dw-btn primary big${this.applying ? ' busy' : ''}" data-act="apply" ${chosen ? '' : 'disabled title="先给至少一个文件选版本"'}>${this.applying ? ic('sync', 'dw-spin') : ic('check')}应用选择</button>`) : ''}`;
    }

    viewBackup() {
        const b = this.f.backup;
        let status = '';
        if (b.running) {
            status = `<div class="dw-progress">
                <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>${b.stage === 'pack' ? '正在打包…' : '正在下载…'}</span><span class="dw-sp"></span><span>${b.stage === 'download' ? `${b.percent}%` : ''}</span></div>
                ${b.stage === 'download' ? `<div class="dw-stages"><div class="dw-stage now" style="--p:${b.percent}%"></div></div>` : '<div class="dw-bar"></div>'}
            </div>`;
        } else if (b.done) {
            status = `<div class="dw-banner">${ic('check')}<span>已下载 ${esc(b.done.fileName)}（${size(b.done.size)}）</span></div>`;
        }
        const blocked = !this.snap.caps.allowFullBackup;
        return `
            ${blocked ? `<div class="dw-banner error">${ic('lock')}<span>服务器关闭了备份下载</span></div>` : ''}
            ${this.backupCats('要备份的内容')}
            ${status}
            ${this.foot(`<button class="dw-btn primary big${b.running ? ' busy' : ''}" data-act="backup-go" ${this.backupSel.size && !blocked ? this.lockAttr(b.running) : 'disabled'}>${ic('download')}下载备份</button>`)}`;
    }

    viewRestore() {
        const r = this.f.restore;
        const file = r.file
            ? `<div class="dw-file"><span class="dw-card-icon">${ic('zip')}</span><div style="min-width:0"><b>${esc(r.file.name)}</b><small>${size(r.file.size)}${r.uploaded ? ' · 已上传' : ''}</small></div>
                ${r.running ? '' : `<button class="dw-ibtn" data-act="file-x" title="移除">${ic('x')}</button>`}</div>`
            : `<div class="dw-drop" data-act="pick" role="button"><span class="dw-card-icon">${ic('upload')}</span><div>选择备份 ZIP，或拖到这里</div></div>`;
        const pg = r.needsDb?.kind === 'postgres';
        const db = r.needsDb ? `
            <div class="dw-group">
                <div class="dw-sec-title">${ic('db')}临时 ${pg ? 'PostgreSQL' : 'MySQL'} 连接<span class="dw-sp"></span><span class="dw-pilltag">${esc(r.needsDb.source)} → ${esc(r.needsDb.target)}</span></div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>地址</span><input class="dw-inp" data-model="restore.db.host" value="${esc(r.db.host)}" placeholder="127.0.0.1"></label>
                    <label class="dw-field"><span>端口</span><input class="dw-inp" data-model="restore.db.port" value="${esc(r.db.port)}" placeholder="${pg ? '5432' : '3306'}"></label>
                </div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>用户名</span><input class="dw-inp" data-model="restore.db.user" value="${esc(r.db.user)}" placeholder="${pg ? 'postgres' : 'root'}" autocomplete="off"></label>
                    <label class="dw-field"><span>密码</span>${this.pw('restore.db.pass', r.db.pass)}</label>
                </div>
                <label class="dw-field"><span>数据库名</span><input class="dw-inp" data-model="restore.db.name" value="${esc(r.db.name)}" placeholder="${pg ? 'postgres' : 'mysql'}"></label>
            </div>` : '';
        const label = r.needsDb ? '继续恢复' : r.mode === 'replace' ? '覆盖并恢复' : '开始恢复';
        return `
            ${file}
            <input type="file" accept=".zip,application/zip" data-role="file" hidden>
            ${this.modeRadios('restore', r.mode)}
            ${this.backupCats('要恢复的内容')}
            ${db}
            ${this.renderRun(r, RESTORE_STAGES, '恢复完成')}
            ${r.done ? '' : this.foot(`<button class="dw-btn ${r.mode === 'replace' ? 'danger solid' : 'primary'} big${r.running ? ' busy' : ''}" data-act="restore-go" ${r.file && this.backupSel.size ? this.lockAttr(r.running) : 'disabled'}>${ic('restore')}${label}</button>`)}`;
    }

    modeRadios(set, mode) {
        return `<section class="dw-sec"><div class="dw-sec-title">恢复方式</div>
            <div class="dw-radios">
                <button class="dw-radio${mode === 'merge' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="merge"><span class="dw-ring"></span><span>增量恢复</span></button>
                <button class="dw-radio danger${mode === 'replace' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="replace"><span class="dw-ring"></span><span>覆盖恢复</span></button>
            </div></section>`;
    }

    renderRun(run, stages, doneText) {
        if (run.interrupted) {
            return `<div class="dw-banner error">${ic('x')}<span>上传在 ${run.interrupted.percent}% 中断</span>
                <button class="dw-btn sm" data-act="upload-resume">从断点继续</button><button class="dw-btn sm ghost" data-act="upload-cancel">放弃</button></div>`;
        }
        if (run.error) return `<div class="dw-banner error">${ic('x')}<span>${esc(run.error)}</span></div>`;
        if (run.done) {
            const d = run.done;
            const parts = [`恢复了 ${d.restored} 个文件`];
            if (d.skipped) parts.push(`跳过 ${d.skipped} 个`);
            if (d.rejected) parts.push(`拒绝 ${d.rejected} 个`);
            const warn = d.skipped || d.rejected;
            return `<div class="dw-banner${warn ? ' warning' : ''}">${ic(warn ? 'warn' : 'check')}<span>${doneText}：${parts.join('，')}${d.crossEngine ? `（${esc(d.crossEngine)}）` : ''}</span>
                    <button class="dw-btn sm" data-act="reload">刷新页面</button></div>
                ${d.samples?.length ? `<details class="dw-fold"><summary>${ic('chev', 'dw-chev')}查看跳过的文件</summary>
                    <div class="dw-stalled" style="margin:0 12px 12px">${d.samples.map(x => `<code>${esc(x)}</code>`).join('')}</div></details>` : ''}`;
        }
        if (!run.running) return '';
        return `<div class="dw-progress">
            <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>${run.note ? esc(run.note) : `正在${stages[run.stage] || stages[0]}…`}</span><span class="dw-sp"></span><span>${run.stage === 0 ? `${run.percent}%` : ''}</span></div>
            <div class="dw-stages">${stages.map((s, i) => `<div class="dw-stage${i < run.stage ? ' done' : i === run.stage ? (i === 0 ? ' now' : ' now indet') : ''}" style="--p:${i === run.stage && i === 0 ? run.percent : 0}%">${s}</div>`).join('')}</div>
        </div>`;
    }

    viewMigrate() {
        return `<div class="dw-options">
            ${this.option('migrateOut', 'upload', '迁出这台的数据')}
            ${this.option('migrateIn', 'download', '迁入数据到这台', 'blue')}
        </div>`;
    }

    expireText() {
        const left = this.f.migrate.expiresAt - Date.now();
        return left > 0 ? `${ic('clock')}${clock(left)} 后失效 · 只能用一次` : `${ic('clock')}已失效`;
    }

    viewMigrateOut() {
        const m = this.f.migrate;
        if (m.link) {
            const link = m.link(m.addr);
            return `
                <div class="dw-step"><i>${ic('check')}</i>迁移链接已生成</div>
                <div class="dw-step"><i>2</i>在新设备的「迁入数据到这台」里粘贴</div>
                ${m.addresses.length > 1 ? `
                    <label class="dw-field"><span>新设备通过哪个地址访问本机</span>
                        <select class="dw-inp" data-act-change="migrate-addr">${m.addresses.map(a => `<option value="${esc(a)}" ${a === m.addr ? 'selected' : ''}>${esc(a)}${isLoopback(a) ? '（仅本机）' : ''}</option>`).join('')}</select>
                    </label>` : ''}
                ${isLoopback(m.addr) ? `<div class="dw-banner warning">${ic('warn')}<span>这个地址只有本机能访问，新设备打不开</span></div>` : ''}
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(link)}">${ic('copy')}复制</button>
                    <button class="dw-btn icon" data-act="migrate-link" title="换一条新链接">${ic('sync')}</button>
                </div>
                <span class="dw-expire" data-region="expire">${this.expireText()}</span>
                ${this.foot('<button class="dw-btn big" data-act="back">完成</button>')}`;
        }
        return `
            ${this.backupCats('要迁移的内容')}
            ${this.foot(`<button class="dw-btn primary big${m.busy ? ' busy' : ''}" data-act="migrate-link" ${this.backupSel.size ? this.lockAttr(false) : 'disabled'}>${m.busy ? ic('sync', 'dw-spin') : ic('link')}生成迁移链接</button>`)}`;
    }

    viewMigrateIn() {
        const m = this.f.migrate;
        return `
            <label class="dw-field"><span>迁移链接</span><input class="dw-inp mono" data-model="migrate.inLink" value="${esc(m.inLink)}" placeholder="粘贴旧设备生成的链接" ${m.running ? 'disabled' : ''}></label>
            ${this.modeRadios('migrate', m.mode)}
            ${this.backupCats('要迁入的内容')}
            ${this.renderRun(m, MIGRATE_STAGES, '迁移完成')}
            ${m.done ? '' : this.foot(`<button class="dw-btn ${m.mode === 'replace' ? 'danger solid' : 'primary'} big${m.running ? ' busy' : ''}" data-act="migrate-go" ${this.backupSel.size ? this.lockAttr(m.running) : 'disabled'}>${ic('move')}开始迁移</button>`)}`;
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
            this.toast('请选择 .zip 格式的备份文件', true);
            return;
        }
        if (!file.size) {
            this.toast('这个文件是空的', true);
            return;
        }
        Object.assign(this.f.restore, { file, needsDb: null, uploaded: false, error: null, done: null, interrupted: null });
        this.rerender();
    }

    async onClick(e) {
        const el = e.target.closest('[data-act]');
        const act = el?.dataset.act;
        if (this.help && act !== 'help' && !e.target.closest('.dw-pop')) {
            this.help = false;
            this.root.querySelector('.dw-pop')?.remove();
            this.root.querySelector('[data-act="help"]')?.classList.remove('on');
        }
        if (this.themeMenu && act !== 'theme-menu' && act !== 'theme' && !e.target.closest('.dw-themes')) {
            this.themeMenu = false;
            this.root.querySelector('.dw-themes')?.remove();
            this.root.querySelector('[data-act="theme-menu"]')?.classList.remove('on');
        }
        if (this.menu && act !== 'menu' && !e.target.closest('.dw-menu')) {
            this.menu = null;
            this.refreshRegion('cards');
        }
        if (!el) return;
        const id = el.dataset.id;
        switch (act) {
            case 'close': return this.close?.();
            case 'tab':
                this.tab = el.dataset.tab;
                this.help = false;
                return this.render();
            case 'back': return this.pop();
            case 'push': return this.push(el.dataset.view);
            case 'help':
                this.help = !this.help;
                this.themeMenu = false;
                return this.render();
            case 'theme-menu':
                this.themeMenu = !this.themeMenu;
                this.help = false;
                return this.render();
            case 'theme':
                this.theme = el.dataset.theme;
                this.themeMenu = false;
                globalThis.localStorage?.setItem(THEME_KEY, this.theme);
                this.onTheme?.(this.theme);
                return this.render();
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
            case 'clear-auth': return this.backendAction(id, () => this.p.clearAuth(id), '已清除保存的账号');
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
            case 'eye': {
                const input = el.previousElementSibling;
                input.type = input.type === 'password' ? 'text' : 'password';
                return;
            }
            case 'copy': return this.copy(el.dataset.text);
            case 'pair-gen': return this.pairGen();
            case 'pair-accept': return this.pairAccept();
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
                Object.assign(this.f.restore, { interrupted: null, running: false });
                this.toast('已放弃这次上传');
                return this.rerender();
            case 'backup-go': return this.backupGo();
            case 'pick': return this.root.querySelector('[data-role="file"]')?.click();
            case 'file-x':
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
            this.toast('已复制');
        } catch {
            this.toast('复制失败，请手动选中复制', true);
        }
    }

    async backendAction(id, fn, okText) {
        if (this.pending.has(id)) return;
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
        if (this.pending.has(id)) return;
        this.flash = null;
        this.refreshRegion('top');
        this.pending.add(id);
        try {
            const r = await this.p.syncNow(id);
            if (r?.conflicts && r?.stalled) this.flash = { tone: 'warning', text: `已与「${b.label}」同步，${r.conflicts} 个文件需要你选版本，${r.stalled} 个文件保留了本机版本`, act: 'conflicts', actLabel: '去处理' };
            else if (r?.conflicts) this.flash = { tone: 'warning', text: `已与「${b.label}」同步，${r.conflicts} 个文件需要你选版本`, act: 'conflicts', actLabel: '去处理' };
            else if (r?.stalled) this.flash = { tone: 'warning', text: `已与「${b.label}」同步，${r.stalled} 个文件没能更新，保留了本机版本` };
            else this.flash = { tone: 'success', text: `已与「${b.label}」同步` };
        } catch (err) {
            console.error('[data-window] sync failed', err);
            this.flash = { tone: 'error', text: `「${b.label}」同步失败：${err.message}` };
        } finally {
            this.pending.delete(id);
            this.refreshLive();
        }
    }

    async undo(id) {
        const b = this.snap.backends.find(x => x.id === id);
        this.menu = null;
        this.refreshRegion('cards');
        if (!await this.confirm({ title: `撤销与「${b.label}」的上次同步？`, text: '撤销本身也会同步到其他设备。', ok: '撤销' })) return;
        if (this.pending.has(id)) return;
        this.pending.add(id);
        this.refreshRegion('cards');
        try {
            const r = await this.p.undo(id);
            this.flash = r?.kept?.length
                ? { tone: 'warning', text: `已撤销。下面 ${r.kept.length} 个文件在同步后又改过，保留了当前版本：`, files: r.kept }
                : { tone: 'success', text: `已撤销与「${b.label}」的上次同步` };
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
            ? { title: `取消与「${b.label}」的配对？`, text: '已经发出去的配对链接会失效。', ok: '取消配对', danger: true }
            : { title: `移除「${b.label}」？`, text: '本机的同步设置和同步历史会被删除，之前的同步也不能再撤销；存储桶和其他设备上的数据不受影响。', ok: '移除', danger: true });
        if (!ok) return;
        await this.backendAction(id, () => this.p.remove(id), pendingPair ? '已取消配对' : '已移除');
    }

    async saveLocal(btn) {
        const idle = Number(this.f.schedule.idle);
        const poll = Number(this.f.schedule.poll);
        if (!(idle > 0) || !(poll > 0)) {
            this.toast('时间要填大于 0 的数字', true);
            return;
        }
        btn.classList.add('busy');
        try {
            this.f.device.label = await this.p.saveDevice(this.f.device.label.trim());
            this.f.schedule = { ...await this.p.saveSchedule(idle, poll) };
            this.rerender();
            this.toast('已保存');
        } catch (err) {
            this.toast(err.code === 'INVALID_DEVICE_LABEL' ? '请输入有效的设备名' : err.message, true);
        } finally {
            btn.classList.remove('busy');
        }
    }

    async pairGen() {
        const t = this.top;
        if (!t.label.trim()) return this.formError('请填写对方设备名称');
        if (!t.cats.size) return this.formError('请至少选一项同步内容');
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            t.result = await this.p.createPairLink({ label: t.label.trim(), categories: [...t.cats] });
            t.addr = firstReachable(t.result.addresses);
        } catch (err) {
            t.error = err.message;
        } finally {
            t.busy = false;
            this.rerender();
        }
    }

    formError(text) {
        this.top.error = text;
        this.rerender();
        this.root.querySelector('.dw-err')?.scrollIntoView({ block: 'nearest' });
    }

    async pairAccept() {
        const t = this.top;
        const f = t.form;
        if (!f.url || !f.peerId) {
            t.manual = !f.link;
            return this.formError(f.link ? '这条配对链接看不懂，请让对方重新生成' : '请粘贴配对链接，或手动填写对方地址和设备 ID');
        }
        if (!t.cats.size) return this.formError('请至少选一项同步内容');
        const me = this.p.currentHandle();
        if (f.handle && f.handle !== me) return this.formError(`这条配对链接是给用户「${f.handle}」的，你现在登录的是「${me}」`);
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            const b = await this.p.acceptPair({ ...f, categories: [...t.cats] });
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: `已与「${b.label}」配对并完成同步${f.user ? '。对方的账号已保存在本机，可在设备菜单里清除' : ''}` };
            this.render();
        } catch (err) {
            t.busy = false;
            if (err.paired) {
                this.stack.sync = [{ view: 'list' }];
                this.flash = { tone: 'warning', text: `已配对，但第一次同步失败：${err.message}` };
                return this.render();
            }
            if (/^PEER_AUTH/.test(err.code || '')) {
                t.manual = true;
                t.error = err.message;
                this.rerender();
                return this.root.querySelector('[data-focus="user"]')?.focus();
            }
            Object.assign(f, { code: '', pass: '', link: '' });
            t.error = `${err.message}。配对码已失效，请让对方重新生成链接`;
            this.rerender();
        }
    }

    async s3Save() {
        const t = this.top;
        const f = t.form;
        const missing = [];
        if (!f.label.trim()) missing.push('名称');
        if (!f.endpoint.trim()) missing.push('Endpoint');
        if (!f.bucket.trim()) missing.push('桶');
        if (!t.id && !f.accessKey) missing.push('Access Key ID');
        if (!t.id && !f.secretKey) missing.push('Secret Access Key');
        if (!t.id && !f.passphrase) missing.push('加密口令');
        if (missing.length) return this.formError(`请填写${missing.join('、')}`);
        if (!f.cats.size) return this.formError('请至少选一项同步内容');
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            await this.p.saveS3({ ...f, region: f.region.trim() || 'us-east-1', categories: [...f.cats] }, t.id);
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: t.id ? `已保存「${f.label}」` : `已添加「${f.label}」` };
            this.render();
        } catch (err) {
            t.error = err.message;
            t.busy = false;
            this.rerender();
        }
    }

    async unlockSave() {
        const t = this.top;
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            await this.p.unlockS3(t.id, t.form.pass);
            this.pop();
            this.toast('已解锁');
        } catch (err) {
            t.error = err.message;
            t.busy = false;
            this.rerender();
        }
    }

    async lanSave() {
        const t = this.top;
        if (!t.label.trim()) return this.formError('请填写名称');
        if (!t.cats.size) return this.formError('请至少选一项同步内容');
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            await this.p.editLan(t.id, { label: t.label.trim(), categories: [...t.cats] });
            this.pop();
            this.toast('已保存');
        } catch (err) {
            t.busy = false;
            t.error = err.message;
            this.rerender();
        }
    }

    async applyChoices() {
        for (const c of this.snap.conflicts) {
            const pick = this.choices[c.key];
            if (c.stale && pick && pick !== 'current') {
                if (!await this.confirm({ title: `覆盖「${c.path.split('/').pop()}」？`, text: '冲突之后的修改会被覆盖，被覆盖的版本仍留在同步历史里。', ok: '覆盖', danger: true })) return;
            }
        }
        this.applying = true;
        this.rerender();
        try {
            const picks = Object.fromEntries(this.snap.conflicts.filter(c => this.choices[c.key]).map(c => [c.key, { version: this.choices[c.key], review: c.review }]));
            const r = await this.p.applyConflicts(picks);
            this.failedKeys = new Set(r.failed.map(x => x.key));
            for (const k of [...r.applied, ...r.alreadyResolved.map(x => x.key)]) delete this.choices[k];
            if (r.alreadyResolved.length) this.toast(`${r.alreadyResolved.length} 个文件已在其他设备处理过`);
            else if (!r.failed.length) this.toast('已应用');
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            this.applying = false;
            const s = this.snap;
            if (s.conflicts.length || s.notices.length || s.backends.some(b => b.stalled?.length)) this.rerender();
            else this.pop();
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
            this.toast(`有些通知没能关闭：${err.message}`, true);
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
                ? { title: '覆盖恢复？', text: '所选内容会先被清空，再写入备份里的数据。', ok: '覆盖并恢复', danger: true }
                : { title: '开始恢复？', text: '同路径的文件会被备份里的版本替换，其他文件不动。', ok: '开始恢复' });
            if (!ok) return;
        }
        if (r.needsDb && !(r.db.host && r.db.user)) {
            this.toast('请填写临时数据库的地址和用户名', true);
            return;
        }
        const resumeFrom = resume ? r.interrupted?.percent || 0 : 0;
        Object.assign(r, { running: true, stage: 0, percent: resumeFrom, note: '', error: null, done: null, interrupted: null });
        this.rerender();
        try {
            r.done = await this.p.restoreBackup({ file: r.file, mode: r.mode, categories: [...this.backupSel], tempDb: r.needsDb ? r.db : null, resumeFrom, handle: this.handle }, p => {
                Object.assign(r, p);
                if (p.stage > 0) r.uploaded = true;
                if (this.top.view === 'restore') this.rerender();
            });
            Object.assign(r, { file: null, needsDb: null, uploaded: false });
            if (!r.done.skipped && !r.done.rejected) setTimeout(() => this.f.restore.done && this.finish(), 3000);
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

    /** After a successful restore or migration the page reloads, like the old manager. */
    finish() {
        if (this.onDone) return this.onDone();
        this.toast('预览里不会真的刷新页面');
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
            this.toast('请先粘贴迁移链接', true);
            return;
        }
        const ok = await this.confirm(m.mode === 'replace'
            ? { title: '覆盖迁入？', text: '所选内容会先被清空，再写入旧设备的数据。', ok: '覆盖并迁入', danger: true }
            : { title: '开始迁入？', text: '同路径的文件会被旧设备的版本替换，其他文件不动。', ok: '开始迁移' });
        if (!ok) return;
        Object.assign(m, { running: true, stage: 0, percent: 0, error: null, done: null });
        this.rerender();
        try {
            m.done = await this.p.migrateFromLink({ link: m.inLink, mode: m.mode, categories: [...this.backupSel], handle: this.handle }, p => {
                Object.assign(m, p);
                if (this.top.view === 'migrateIn') this.rerender();
            });
            m.inLink = '';
            if (!m.done.skipped && !m.done.rejected) setTimeout(() => this.f.migrate.done && this.finish(), 3000);
        } catch (err) {
            m.error = err.message;
        } finally {
            m.running = false;
            if (this.top.view === 'migrateIn') this.rerender();
        }
    }
}

function makeDraggable(win, root) {
    root.addEventListener('pointerdown', event => {
        const bar = event.target.closest('.dw-titlebar');
        if (!bar || event.button !== 0 || event.target.closest('button, [data-act]') || globalThis.innerWidth <= 640) return;
        event.preventDefault();
        const rect = win.getBoundingClientRect();
        const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        bar.classList.add('is-dragging');
        bar.setPointerCapture?.(event.pointerId);
        const move = e => {
            const left = Math.min(Math.max(start.left + e.clientX - start.x, 120 - rect.width), globalThis.innerWidth - 120);
            const top = Math.min(Math.max(start.top + e.clientY - start.y, 0), globalThis.innerHeight - 46);
            Object.assign(win.style, { left: `${left}px`, top: `${top}px`, transform: 'none', animation: 'none' });
        };
        const end = () => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', end);
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', end);
    });
}

let openWindow = null;

/**
 * Opens the Data window, or brings the open one to the requested page.
 * @param {object} [options]
 * @param {'sync'|'backup'|'restore'|'migrate'|'settings'} [options.tab] Tab to show first
 * @param {'conflicts'} [options.view] Sub-page to open inside the tab
 * @param {string} [options.handle] User whose data backup/restore/migration acts on (admin panel)
 * @param {() => void} [options.onDone] Called after a successful restore or migration
 * @param {object} [options.provider] Data source; defaults to the preview mock
 * @returns {Promise<void>} Resolves when the window closes
 */
export function openDataWindow({ tab = 'sync', view, handle, onDone, provider } = {}) {
    if (openWindow) {
        openWindow.ui.navigate({ tab, view });
        openWindow.win.focus();
        return openWindow.closed;
    }
    const layer = document.createElement('div');
    layer.className = 'dw-layer';
    const scrim = document.createElement('div');
    scrim.className = 'dw-scrim';
    const win = document.createElement('section');
    win.className = 'dw-win';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', '数据');
    win.tabIndex = -1;
    const root = document.createElement('div');
    root.className = 'dw';
    win.append(root);
    layer.append(scrim, win);

    let resolveClosed;
    const closed = new Promise(resolve => resolveClosed = resolve);
    const ui = new DataWindow(root, provider || (shared.provider ??= createMockProvider()), { tab, view, handle, onDone });
    layer.dataset.theme = ui.theme;
    ui.onTheme = theme => layer.dataset.theme = theme;
    const onKey = e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (ui.modal) return ui.modal.querySelector('[data-r="0"]')?.click();
        if (ui.help || ui.menu || ui.themeMenu) {
            ui.help = false;
            ui.themeMenu = false;
            ui.menu = null;
            return ui.render();
        }
        requestClose();
    };
    // Long jobs keep running on the server; closing only hides their progress.
    async function requestClose() {
        const job = ui.busyJob;
        if (job && !await ui.confirm({ title: `${job}，确定关闭窗口？`, text: '任务会继续在服务器上进行，重新打开窗口可以看到进度。', ok: '关闭' })) return;
        close();
    }
    function close() {
        ui.destroy();
        document.removeEventListener('keydown', onKey, true);
        layer.remove();
        openWindow = null;
        resolveClosed();
    }
    ui.close = close;
    root.addEventListener('click', e => {
        if (e.target.closest('[data-act="close"]')) {
            e.stopImmediatePropagation();
            requestClose();
        }
    }, true);
    document.addEventListener('keydown', onKey, true);
    makeDraggable(win, root);
    document.body.append(layer);
    win.focus();
    openWindow = { win, ui, closed };
    return closed;
}
