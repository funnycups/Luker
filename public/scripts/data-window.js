// Data window: sync, backup, restore and migration in one floating window.
import { createMockProvider, SYNC_CATEGORY_GROUPS, BACKUP_CATEGORIES } from './data-window-mock.js';

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
    settings: ['本机名称会出现在其他设备的版本记录里，留空就用主机名。', '编辑停下后等一段时间再同步；另外按检查间隔定期去其他设备看看有没有更新。'],
    add: ['局域网：两台设备要能互相访问。在一台上生成链接，到另一台粘贴。', 'S3：多台设备填同一个存储桶、前缀和加密口令即可。'],
    pairNew: ['链接只能用一次，里面带着对方的名字和要同步的内容。', '对方要能用这里选的地址访问到本机。'],
    pairExist: ['粘贴链接后，地址和设备 ID 会自动填好。', '对方开了登录密码才需要填账号；配对后保存在本机，可以随时在设备菜单里清除。'],
    s3: ['同一个桶、前缀、加密口令的设备会互相同步。', '桶和前缀保存后不能改。'],
    s3Edit: ['密钥和口令留空表示保留原来的值；桶和前缀保存后不能改。'],
    unlock: ['服务端重启后需要重新输入加密口令，才能继续读写这个存储桶。'],
    lanEdit: ['只改本机这一侧的名字和同步内容。'],
    conflicts: ['两台设备改了同一个文件、又合并不了时，会在这里等你选用哪个版本。', '选的不是「当前版本」时，会覆盖掉冲突之后的修改；被覆盖的版本仍留在同步历史里。'],
    backup: ['把选中的数据打包成一个 ZIP 下载到本地。', 'API 密钥默认不打包。备份、恢复、迁移共用同一组内容选择。'],
    restore: ['增量恢复：只写入备份里的文件，其他不动。', '覆盖恢复：先清空所选内容，再写入备份。', '备份来自另一种数据库时，会要求填一个临时数据库连接用于中转。'],
    migrate: ['一次性把数据搬到另一台设备。多台设备长期使用，请用「同步」。'],
    migrateOut: ['链接很快失效，而且只能用一次。'],
    migrateIn: ['在旧设备上生成链接，粘贴到这里。'],
};

const RESTORE_STAGES = ['上传', '整理', '检查', '恢复'];
const MIGRATE_STAGES = ['下载', '整理', '恢复'];
const STATE_TAG = { ok: ['is-ok', '已同步'], running: ['is-ok', '同步中'], attention: ['is-warn', '需留意'], error: ['is-bad', '失败'] };

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

const defaultSyncCats = () => new Set(SYNC_CATEGORY_GROUPS.flatMap(([, items]) => items.filter(i => !i[2]).map(i => i[0])));
const allSyncCats = () => SYNC_CATEGORY_GROUPS.flatMap(([, items]) => items.map(i => i[0]));

class DataWindow {
    constructor(root, provider, tab) {
        this.root = root;
        this.p = provider;
        this.tab = tab;
        this.stack = { sync: [{ view: 'list' }], backup: [{ view: 'backup' }], restore: [{ view: 'restore' }], migrate: [{ view: 'migrate' }], settings: [{ view: 'settings' }] };
        this.pending = new Set();
        this.menu = null;
        this.flash = null;
        this.help = false;
        this.choices = {};
        this.backupSel = new Set(BACKUP_CATEGORIES.filter(c => c.def).map(c => c.id));
        const s = this.p.snapshot();
        this.f = {
            device: { label: s.device.label },
            schedule: { ...s.schedule },
            backup: { running: false, stage: null, percent: 0, done: null },
            restore: { file: null, mode: 'merge', needsDb: false, db: { host: '', port: '3306', user: '', pass: '', name: '' }, running: false, stage: -1, percent: 0, done: false },
            migrate: { link: null, expiresAt: 0, inLink: '', mode: 'merge', running: false, stage: -1, percent: 0, done: false, busy: false },
        };

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
            ${this.help ? `<div class="dw-pop">${(HELP[this.viewKey] || HELP.list).map(l => `<p>${esc(l)}</p>`).join('')}</div>` : ''}`;
        this.renderStatus();
    }

    renderPage() {
        const deep = this.stack[this.tab].length > 1;
        const head = `<div class="dw-pagehead">
            ${deep ? `<button class="dw-ibtn" data-act="back" title="返回">${ic('back')}</button>` : ''}
            <h2 class="dw-h2">${esc(TITLES[this.viewKey])}</h2>
            <span class="dw-sp"></span>
            ${this.top.view === 'list' && this.snap.backends.length ? `<button class="dw-btn primary sm" data-act="push" data-view="add">${ic('plus')}添加</button>` : ''}
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
        const { backends, conflicts, notices } = this.snap;
        const running = backends.find(b => b.state === 'running');
        if (running) return { tone: 'running', text: `正在同步 ${running.label} · ${clock(Date.now() - running.startedAt)}` };
        if (conflicts.length) return { tone: 'attention', text: `${conflicts.length} 个冲突待处理`, act: 'conflicts' };
        if (notices.length) return { tone: 'attention', text: `${notices.length} 条同步通知`, act: 'conflicts' };
        const failed = backends.find(b => b.state === 'error');
        if (failed) return { tone: 'error', text: `${failed.label} 同步失败` };
        const stalled = backends.find(b => b.state === 'attention');
        if (stalled) return { tone: 'attention', text: `${stalled.label} 有文件没能更新` };
        if (!backends.length) return null;
        return { tone: 'ok', text: `已同步 · ${ago(Math.max(...backends.map(b => b.lastSync || 0)))}` };
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
            <div class="dw-sec-title">同步内容<span class="dw-sp"></span><span class="dw-count">已选 ${set.size} / ${allSyncCats().length}</span></div>
            <div class="dw-cats">${SYNC_CATEGORY_GROUPS.map(([group, items], gi) => `
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
        const cats = BACKUP_CATEGORIES.filter(c => !c.adminOnly || this.snap.isAdmin);
        const n = cats.filter(c => this.backupSel.has(c.id)).length;
        return `<section class="dw-sec">
            <div class="dw-sec-title">${title}<span class="dw-count">${n} / ${cats.length}</span><span class="dw-sp"></span>
                <button class="dw-link" data-act="bsel" data-mode="all">全选</button>
                <button class="dw-link" data-act="bsel" data-mode="def">默认</button>
                <button class="dw-link" data-act="bsel" data-mode="none">清空</button>
            </div>
            <div class="dw-cats"><div class="dw-chips">${cats.map(c => `
                <button class="dw-chip${this.backupSel.has(c.id) ? ' on' : ''}${c.sensitive || c.adminOnly ? ' opt' : ''}" data-act="bcat" data-id="${c.id}">${c.sensitive ? ic('lock') : ''}${esc(c.label)}</button>`).join('')}
            </div></div>
        </section>
        ${this.backupSel.has('secrets') ? `<div class="dw-banner warning">${ic('key')}<span>会包含 API 密钥，请妥善保管文件</span></div>` : ''}`;
    }

    catSet(key) {
        return key === 's3' ? this.top.form.cats : this.top.cats;
    }

    // ---------- sync: list ----------

    viewList() {
        return `
            <div data-region="summary" style="display:contents">${this.renderSummary()}</div>
            <div data-region="top" style="display:contents">${this.renderTop()}</div>
            <div class="dw-cards" data-region="cards">${this.renderCards()}</div>`;
    }

    renderSummary() {
        const { backends } = this.snap;
        if (!backends.length) return '';
        const count = state => backends.filter(b => b.state === state).length;
        const parts = [`<span><b>${backends.length}</b> 个同步对象</span>`];
        if (count('error')) parts.push(`<span class="bad"><b>${count('error')}</b> 个失败</span>`);
        if (count('attention')) parts.push(`<span class="warn"><b>${count('attention')}</b> 个需留意</span>`);
        parts.push(`<span>本机 <b>${esc(this.snap.device.label || this.snap.device.placeholder)}</b></span>`);
        return `<div class="dw-summary">${parts.join('')}</div>`;
    }

    renderTop() {
        const { conflicts, notices } = this.snap;
        let html = '';
        if (conflicts.length || notices.length) {
            const text = conflicts.length ? `${conflicts.length} 个文件需要你选版本${notices.length ? `，另有 ${notices.length} 条通知` : ''}` : `${notices.length} 条同步通知`;
            html += `<div class="dw-banner warning">${ic('warn')}<span>${text}</span><button class="dw-btn sm" data-act="conflicts">去处理</button></div>`;
        }
        if (this.flash) {
            html += `<div class="dw-banner ${this.flash.tone}">${ic(this.flash.tone === 'error' ? 'x' : 'check')}<span>${esc(this.flash.text)}</span><button class="dw-ibtn" data-act="flash-x" style="width:24px;height:24px">${ic('x')}</button></div>`;
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
            attention: `${b.stalled?.length || 0} 个文件没能更新 · ${ago(b.lastSync)}`,
            error: `${b.error || '未知错误'} · ${ago(b.lastSync)}`,
        }[b.state] || ago(b.lastSync);
        const running = b.state === 'running';
        const main = running
            ? `<button class="dw-btn" disabled>${ic('sync', 'dw-spin')}同步中</button>`
            : `<button class="dw-btn" data-act="sync-now" data-id="${b.id}">${ic('sync')}${b.state === 'error' ? '重试' : '立即同步'}</button>`;
        const menu = this.menu === b.id ? `
            <div class="dw-menu" role="menu">
                ${b.canUndo ? `<button data-act="undo" data-id="${b.id}">${ic('undo')}撤销上次同步</button>` : ''}
                <button data-act="edit" data-id="${b.id}">${ic('edit')}编辑</button>
                ${b.kind === 's3' ? `<button data-act="unlock" data-id="${b.id}">${ic('key')}解锁</button>` : ''}
                ${b.kind === 'lan' && b.hasStoredCredentials ? `<button data-act="clear-auth" data-id="${b.id}">${ic('key')}清除保存的账号</button>` : ''}
                <hr>
                <button class="danger" data-act="remove" data-id="${b.id}">${ic('trash')}移除</button>
            </div>` : '';
        const stalled = b.state === 'attention' && b.stalled?.length
            ? `<div class="dw-stalled">本机保留了这些文件的当前版本${b.stalled.map(p => `<code>${esc(p)}</code>`).join('')}</div>`
            : '';
        return `
            <div class="dw-card${this.pending.has(b.id) ? ' locked' : ''}" data-state="${b.state}">
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
                ${stalled}
            </div>`;
    }

    // ---------- settings ----------

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
        t.cats ??= defaultSyncCats();
        t.label ??= '';
        if (t.result) {
            const link = t.result.link(t.addr);
            const loopback = /127\.0\.0\.1|localhost/.test(t.addr);
            return `
                <div class="dw-step"><i>${ic('check')}</i>链接已生成</div>
                <div class="dw-step"><i>2</i>在「${esc(t.label || '新设备')}」上粘贴这条链接</div>
                ${t.result.addresses.length > 1 ? `
                    <label class="dw-field"><span>对方通过哪个地址访问本机</span>
                        <select class="dw-inp" data-act-change="pair-addr">${t.result.addresses.map(a => `<option value="${esc(a)}" ${a === t.addr ? 'selected' : ''}>${esc(a)}${/127\.0\.0\.1|localhost/.test(a) ? '（仅本机）' : ''}</option>`).join('')}</select>
                    </label>` : ''}
                ${loopback ? `<div class="dw-banner warning">${ic('warn')}<span>这个地址只有本机能访问，其他设备连不上</span></div>` : ''}
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(link)}">${ic('copy')}复制</button>
                    <button class="dw-btn icon" data-act="pair-gen" title="重新生成">${ic('sync')}</button>
                </div>
                ${this.foot('<button class="dw-btn big" data-act="back">完成</button>')}`;
        }
        return `
            <label class="dw-field"><span>对方设备名称</span><input class="dw-inp" data-model="top.label" value="${esc(t.label)}" placeholder="例如：手机、笔记本"></label>
            ${this.syncCats('pairNew', t.cats)}
            ${this.foot(`<button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="pair-gen">${t.busy ? ic('sync', 'dw-spin') : ic('qr')}生成配对链接</button>`)}`;
    }

    viewPairExist() {
        const t = this.top;
        t.cats ??= defaultSyncCats();
        t.form ??= { link: '', url: '', peerId: '', label: '', user: '', pass: '' };
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
                    <label class="dw-field"><span>对方设备名称</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="例如：手机"></label>
                    <div class="dw-grid2">
                        <label class="dw-field"><span>对方的登录账号</span><input class="dw-inp" data-model="top.form.user" value="${esc(f.user)}" autocomplete="off"></label>
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
            t.form = { label: b?.label || '', ...base, accessKey: '', secretKey: '', passphrase: '', cats: new Set(b?.categories || defaultSyncCats()) };
        }
        const f = t.form;
        const keep = editing ? '留空则保留原值' : '';
        return `
            <label class="dw-field"><span>名称</span><input class="dw-inp" data-model="top.form.label" value="${esc(f.label)}" placeholder="例如：共享归档"></label>
            <div class="dw-group">
                <div class="dw-sec-title">存储位置<span class="dw-sp"></span><span class="dw-lockhint">${ic('lock')}桶和前缀保存后不能改</span></div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>Endpoint</span><input class="dw-inp" data-model="top.form.endpoint" value="${esc(f.endpoint)}" placeholder="https://s3.example.com"></label>
                    <label class="dw-field"><span>区域</span><input class="dw-inp" data-model="top.form.region" value="${esc(f.region)}" placeholder="us-east-1"></label>
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
        t.cats ??= new Set(b?.categories || defaultSyncCats());
        return `
            <label class="dw-field"><span>名称</span><input class="dw-inp" data-model="top.label" value="${esc(t.label)}"></label>
            ${this.syncCats('lanEdit', t.cats)}
            ${this.foot(`<button class="dw-btn big" data-act="back">取消</button>
                <button class="dw-btn primary big${t.busy ? ' busy' : ''}" data-act="lan-save">${t.busy ? ic('sync', 'dw-spin') : ic('check')}保存</button>`)}`;
    }

    // ---------- sync: conflicts ----------

    viewConflicts() {
        const { conflicts, notices } = this.snap;
        if (!conflicts.length && !notices.length) {
            return `<div class="dw-empty"><span class="dw-card-icon">${ic('check')}</span><b>没有待处理的同步问题</b><button class="dw-btn" data-act="back">返回</button></div>`;
        }
        const chosen = Object.keys(this.choices).filter(k => conflicts.some(c => c.key === k)).length;
        const conflictHtml = conflicts.map(c => `
            <div class="dw-conflict">
                <div class="dw-conflict-head"><span class="dw-pilltag is-warn">${esc(c.kind)}</span><b title="${esc(c.path)}">${esc(c.path)}</b></div>
                ${c.stale ? `<div class="dw-banner warning">${ic('clock')}<span>冲突之后这个文件又改过，选其他版本会覆盖这些修改</span></div>` : ''}
                <div class="dw-versions">${c.versions.map(v => `
                    <button class="dw-version${this.choices[c.key] === v.id ? ' on' : ''}" data-act="choose" data-key="${c.key}" data-v="${v.id}">
                        <span class="dw-version-head"><span class="dw-ring"></span><span>${v.current ? '当前版本' : `来自 ${esc(v.from)}`}</span>${v.inUse ? '<span class="dw-pilltag is-ok">正在使用</span>' : ''}</span>
                        <span class="dw-preview">${esc(v.preview)}</span>
                    </button>`).join('')}
                </div>
            </div>`).join('');
        const noticeHtml = notices.map(n => `
            <div class="dw-notice">
                <span class="dw-card-icon">${ic(n.type === 'fork' ? 'branch' : 'chat')}</span>
                <div style="min-width:0"><b>${esc(n.title)}</b><small>${esc(n.detail)}</small></div>
                <div class="dw-notice-act">
                    <button class="dw-btn sm" data-act="notice-open" data-id="${n.id}">${esc(n.action)}</button>
                    <button class="dw-btn sm ghost" data-act="notice-x" data-id="${n.id}">关闭</button>
                </div>
            </div>`).join('');
        return `
            ${conflicts.length ? `<section class="dw-sec"><div class="dw-sec-title">选择要保留的版本<span class="dw-sp"></span><span class="dw-count">已选 ${chosen} / ${conflicts.length}</span></div><div class="dw-cards">${conflictHtml}</div></section>` : ''}
            ${notices.length ? `<section class="dw-sec"><div class="dw-sec-title">通知</div><div class="dw-cards">${noticeHtml}</div></section>` : ''}
            ${conflicts.length ? this.foot(`<button class="dw-btn primary big${this.applying ? ' busy' : ''}" data-act="apply" ${chosen ? '' : 'disabled'}>${this.applying ? ic('sync', 'dw-spin') : ic('check')}应用选择</button>`) : ''}`;
    }

    // ---------- backup ----------

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
        return `
            ${this.backupCats('要备份的内容')}
            ${status}
            ${this.foot(`<button class="dw-btn primary big${b.running ? ' busy' : ''}" data-act="backup-go" ${this.backupSel.size ? '' : 'disabled'}>${ic('download')}下载备份</button>`)}`;
    }

    // ---------- restore ----------

    viewRestore() {
        const r = this.f.restore;
        const file = r.file
            ? `<div class="dw-file"><span class="dw-card-icon">${ic('zip')}</span><div style="min-width:0"><b>${esc(r.file.name)}</b><small>${size(r.file.size)}</small></div>
                ${r.running ? '' : `<button class="dw-ibtn" data-act="file-x" title="移除">${ic('x')}</button>`}</div>`
            : `<div class="dw-drop" data-act="pick" role="button"><span class="dw-card-icon">${ic('upload')}</span><div>选择备份 ZIP，或拖到这里</div></div>`;
        const db = r.needsDb ? `
            <div class="dw-group">
                <div class="dw-sec-title">${ic('db')}临时数据库连接</div>
                <div class="dw-grid-ep">
                    <label class="dw-field"><span>地址</span><input class="dw-inp" data-model="restore.db.host" value="${esc(r.db.host)}" placeholder="127.0.0.1"></label>
                    <label class="dw-field"><span>端口</span><input class="dw-inp" data-model="restore.db.port" value="${esc(r.db.port)}"></label>
                </div>
                <div class="dw-grid2">
                    <label class="dw-field"><span>用户名</span><input class="dw-inp" data-model="restore.db.user" value="${esc(r.db.user)}" autocomplete="off"></label>
                    <label class="dw-field"><span>密码</span>${this.pw('restore.db.pass', r.db.pass)}</label>
                </div>
                <label class="dw-field"><span>数据库名</span><input class="dw-inp" data-model="restore.db.name" value="${esc(r.db.name)}"></label>
            </div>` : '';
        return `
            ${file}
            <input type="file" accept=".zip,application/zip" data-role="file" hidden>
            ${this.modeRadios('restore', r.mode)}
            ${this.backupCats('要恢复的内容')}
            ${db}
            ${this.renderRun(r, RESTORE_STAGES, '恢复完成，页面即将刷新')}
            ${r.done ? '' : this.foot(`<button class="dw-btn ${r.mode === 'replace' ? 'danger solid' : 'primary'} big${r.running ? ' busy' : ''}" data-act="restore-go" ${r.file && this.backupSel.size ? '' : 'disabled'}>${ic('restore')}${r.mode === 'replace' ? '覆盖并恢复' : '开始恢复'}</button>`)}`;
    }

    modeRadios(set, mode) {
        return `<section class="dw-sec"><div class="dw-sec-title">恢复方式</div>
            <div class="dw-radios">
                <button class="dw-radio${mode === 'merge' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="merge"><span class="dw-ring"></span><span>增量恢复</span></button>
                <button class="dw-radio danger${mode === 'replace' ? ' on' : ''}" data-act="mode" data-set="${set}" data-mode="replace"><span class="dw-ring"></span><span>覆盖恢复</span></button>
            </div></section>`;
    }

    renderRun(run, stages, doneText) {
        if (run.error) return `<div class="dw-banner error">${ic('x')}<span>${esc(run.error)}</span></div>`;
        if (run.done) return `<div class="dw-banner">${ic('check')}<span>${doneText}</span><button class="dw-btn sm" data-act="reload">立即刷新</button></div>`;
        if (!run.running) return '';
        return `<div class="dw-progress">
            <div class="dw-progress-line">${ic('sync', 'dw-spin')}<span>正在${stages[run.stage] || stages[0]}…</span><span class="dw-sp"></span><span>${run.stage === 0 ? `${run.percent}%` : ''}</span></div>
            <div class="dw-stages">${stages.map((s, i) => `<div class="dw-stage${i < run.stage ? ' done' : i === run.stage ? (i === 0 ? ' now' : ' now indet') : ''}" style="--p:${i === run.stage && i === 0 ? run.percent : 0}%">${s}</div>`).join('')}</div>
        </div>`;
    }

    // ---------- migrate ----------

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
            return `
                <div class="dw-step"><i>${ic('check')}</i>迁移链接已生成</div>
                <div class="dw-step"><i>2</i>在新设备的「迁入数据到这台」里粘贴</div>
                <div class="dw-linkbox">
                    <input class="dw-inp mono" readonly value="${esc(m.link)}">
                    <button class="dw-btn primary" data-act="copy" data-text="${esc(m.link)}">${ic('copy')}复制</button>
                    <button class="dw-btn icon" data-act="migrate-link" title="重新生成">${ic('sync')}</button>
                </div>
                <span class="dw-expire" data-region="expire">${this.expireText()}</span>
                ${this.foot('<button class="dw-btn big" data-act="back">完成</button>')}`;
        }
        return `
            ${this.backupCats('要迁移的内容')}
            ${this.foot(`<button class="dw-btn primary big${m.busy ? ' busy' : ''}" data-act="migrate-link" ${this.backupSel.size ? '' : 'disabled'}>${m.busy ? ic('sync', 'dw-spin') : ic('link')}生成迁移链接</button>`)}`;
    }

    viewMigrateIn() {
        const m = this.f.migrate;
        return `
            <label class="dw-field"><span>迁移链接</span><input class="dw-inp mono" data-model="migrate.inLink" value="${esc(m.inLink)}" placeholder="粘贴旧设备生成的链接"></label>
            ${this.modeRadios('migrate', m.mode)}
            ${this.backupCats('要迁入的内容')}
            ${this.renderRun(m, MIGRATE_STAGES, '迁移完成，页面即将刷新')}
            ${m.done ? '' : this.foot(`<button class="dw-btn ${m.mode === 'replace' ? 'danger solid' : 'primary'} big${m.running ? ' busy' : ''}" data-act="migrate-go">${ic('move')}开始迁移</button>`)}`;
    }

    // ---------- events ----------

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
            if (parsed) {
                Object.assign(this.top.form, parsed);
                for (const [k, v] of Object.entries(parsed)) {
                    const input = this.root.querySelector(`[data-model="top.form.${k}"]`);
                    if (input) input.value = v;
                }
            }
        }
    }

    onChange(e) {
        const el = e.target;
        if (el.dataset.actChange === 'pair-addr') {
            this.top.addr = el.value;
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
        Object.assign(this.f.restore, { file, needsDb: false, error: null, done: false });
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
                this.backupSel.has(id) ? this.backupSel.delete(id) : this.backupSel.add(id);
                return this.rerender();
            case 'bsel': {
                const cats = BACKUP_CATEGORIES.filter(c => !c.adminOnly || this.snap.isAdmin);
                const mode = el.dataset.mode;
                this.backupSel = new Set(mode === 'all' ? cats.map(c => c.id) : mode === 'def' ? cats.filter(c => c.def).map(c => c.id) : []);
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
            case 'notice-open': return this.p.openNotice(id).then(() => this.toast('已打开'));
            case 'notice-x': return this.p.dismissNotice(id);
            case 'backup-go': return this.backupGo();
            case 'pick': return this.root.querySelector('[data-role="file"]')?.click();
            case 'file-x':
                Object.assign(this.f.restore, { file: null, needsDb: false, error: null });
                return this.rerender();
            case 'mode':
                this.f[el.dataset.set].mode = el.dataset.mode;
                return this.rerender();
            case 'restore-go': return this.restoreGo();
            case 'migrate-link': return this.migrateLink();
            case 'migrate-go': return this.migrateGo();
            case 'reload': return this.toast('预览里不会真的刷新');
        }
    }

    toggleCat(el) {
        const set = this.catSet(el.dataset.set);
        if (el.dataset.act === 'cat') {
            set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id);
        } else {
            const ids = SYNC_CATEGORY_GROUPS[Number(el.dataset.g)][1].map(i => i[0]);
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
            await this.p.syncNow(id);
            this.flash = { tone: 'success', text: `已与「${b.label}」同步` };
        } catch (err) {
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
        await this.backendAction(id, () => this.p.undo(id), r => r?.kept?.length ? `已撤销，${r.kept.length} 个文件之后改过，保留了当前版本` : '已撤销上次同步');
    }

    async remove(id) {
        const b = this.snap.backends.find(x => x.id === id);
        this.menu = null;
        this.refreshRegion('cards');
        if (!await this.confirm({ title: `移除「${b.label}」？`, text: '只是不再同步，两边已有的数据都会保留。', ok: '移除', danger: true })) return;
        await this.backendAction(id, () => this.p.remove(id), '已移除');
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
            await this.p.saveDevice(this.f.device.label.trim());
            await this.p.saveSchedule(idle, poll);
            this.toast('已保存');
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            btn.classList.remove('busy');
        }
    }

    async pairGen() {
        const t = this.top;
        t.busy = true;
        this.rerender();
        try {
            t.result = await this.p.createPairLink({ label: t.label || '新设备', categories: [...t.cats] });
            t.addr = t.result.addresses[0];
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            t.busy = false;
            this.rerender();
        }
    }

    async pairAccept() {
        const t = this.top;
        const f = t.form;
        if (!f.url || !f.peerId) {
            t.error = '请粘贴配对链接，或手动填写对方地址和设备 ID';
            t.manual = !f.link;
            return this.rerender();
        }
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            const b = await this.p.acceptPair({ ...f, categories: [...t.cats] });
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: `已与「${b.label}」配对并完成同步` };
            this.render();
        } catch (err) {
            t.error = err.message;
            t.busy = false;
            this.rerender();
        }
    }

    async s3Save() {
        const t = this.top;
        t.busy = true;
        t.error = null;
        this.rerender();
        try {
            await this.p.saveS3({ ...t.form, categories: [...t.form.cats] }, t.id);
            const label = t.form.label || 'S3';
            this.stack.sync = [{ view: 'list' }];
            this.flash = { tone: 'success', text: t.id ? `已保存「${label}」` : `已添加「${label}」` };
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
        t.busy = true;
        this.rerender();
        await this.p.editLan(t.id, { label: t.label, categories: [...t.cats] });
        this.pop();
        this.toast('已保存');
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
            await this.p.applyConflicts({ ...this.choices });
            this.choices = {};
            this.toast('已应用');
        } catch (err) {
            this.toast(err.message, true);
        } finally {
            this.applying = false;
            if (this.snap.conflicts.length || this.snap.notices.length) this.rerender();
            else this.pop();
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

    async restoreGo() {
        const r = this.f.restore;
        if (r.mode === 'replace' && !await this.confirm({ title: '覆盖恢复？', text: '所选内容会先被清空，再写入备份里的数据。', ok: '覆盖并恢复', danger: true })) return;
        Object.assign(r, { running: true, stage: 0, percent: 0, error: null, done: false });
        this.rerender();
        try {
            await this.p.restoreBackup({ file: r.file, mode: r.mode, categories: [...this.backupSel], tempDb: r.needsDb ? r.db : null }, p => {
                Object.assign(r, p);
                if (this.top.view === 'restore') this.rerender();
            });
            r.done = true;
        } catch (err) {
            if (err.code === 'needs-temp-db') {
                r.needsDb = true;
                this.toast('这个备份来自另一种数据库，请填写临时数据库连接', true);
            } else {
                r.error = err.message;
            }
        } finally {
            r.running = false;
            if (this.top.view === 'restore') this.rerender();
        }
    }

    async migrateLink() {
        const m = this.f.migrate;
        m.busy = true;
        this.rerender();
        try {
            const res = await this.p.createMigrationLink([...this.backupSel]);
            Object.assign(m, { link: res.link, expiresAt: res.expiresAt });
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
        if (m.mode === 'replace' && !await this.confirm({ title: '覆盖迁入？', text: '所选内容会先被清空，再写入旧设备的数据。', ok: '覆盖并迁入', danger: true })) return;
        Object.assign(m, { running: true, stage: 0, percent: 0, error: null, done: false });
        this.rerender();
        try {
            await this.p.migrateFromLink({ link: m.inLink, mode: m.mode, categories: [...this.backupSel] }, p => {
                Object.assign(m, p);
                if (this.top.view === 'migrateIn') this.rerender();
            });
            m.done = true;
        } catch (err) {
            m.error = err.message;
        } finally {
            m.running = false;
            if (this.top.view === 'migrateIn') this.rerender();
        }
    }
}

function pickTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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
 * Opens the Data window, or focuses it when it is already open.
 * @param {object} [options]
 * @param {'sync'|'backup'|'restore'|'migrate'|'settings'} [options.tab] Tab to show first
 * @param {object} [options.provider] Data source; defaults to the preview mock
 * @returns {Promise<void>} Resolves when the window closes
 */
export function openDataWindow({ tab = 'sync', provider = createMockProvider() } = {}) {
    if (openWindow) {
        openWindow.win.focus();
        return openWindow.closed;
    }
    const layer = document.createElement('div');
    layer.className = 'dw-layer';
    layer.dataset.theme = pickTheme();
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
    const ui = new DataWindow(root, provider, tab);
    const onKey = e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (ui.modal) return ui.modal.querySelector('[data-r="0"]')?.click();
        if (ui.help || ui.menu) {
            ui.help = false;
            ui.menu = null;
            return ui.render();
        }
        close();
    };
    function close() {
        ui.destroy();
        document.removeEventListener('keydown', onKey, true);
        layer.remove();
        openWindow = null;
        resolveClosed();
    }
    ui.close = close;
    scrim.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    makeDraggable(win, root);
    document.body.append(layer);
    win.focus();
    openWindow = { win, closed };
    return closed;
}
