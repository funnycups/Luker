import { getRequestHeaders } from '../script.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { humanFileSize } from './utils.js';
import { t, translate } from './i18n.js';

/**
 * 10 类 category 图标映射(fa-solid <X>)· CSS var 映射(--storage-cat-<X>).
 * 与 src/storage/inspector.js 的 CATEGORIES 保持一致.
 */
const CATEGORY_META = {
    // V1 · 服务端 10 类
    chats:      { icon: 'comment',            colorVar: '--storage-cat-chats'      },
    characters: { icon: 'user',                colorVar: '--storage-cat-characters' },
    worlds:     { icon: 'book',                colorVar: '--storage-cat-worlds'     },
    images:     { icon: 'image',               colorVar: '--storage-cat-images'     },
    attachments:{ icon: 'paperclip',           colorVar: '--storage-cat-attach'     },
    presets:    { icon: 'sliders',             colorVar: '--storage-cat-presets'    },
    extensions: { icon: 'puzzle-piece',        colorVar: '--storage-cat-ext'        },
    vectors:    { icon: 'brain',               colorVar: '--storage-cat-vectors'    },
    backups:    { icon: 'clock-rotate-left',   colorVar: '--storage-cat-backups'    },
    other:      { icon: 'box',                 colorVar: '--storage-cat-other'      },
    // V2 · 浏览器侧 5 类
    localStorage:   { icon: 'hard-drive',  colorVar: '--storage-cat-localstorage'   },
    sessionStorage: { icon: 'clock',       colorVar: '--storage-cat-sessionstorage' },
    indexeddb:      { icon: 'database',    colorVar: '--storage-cat-indexeddb'      },
    cachestorage:   { icon: 'layer-group', colorVar: '--storage-cat-cachestorage'   },
    quota:          { icon: 'chart-pie',   colorVar: '--storage-cat-quota'          },
};

/**
 * Fetch InspectorResponse for given dataSource + path.
 */
async function fetchInspector(dataSource, pathArr) {
    const endpoint = dataSource.kind === 'self'
        ? '/api/users/storage/inspect'
        : '/api/users/storage/inspect-any';
    const body = dataSource.kind === 'self'
        ? { path: pathArr }
        : { target: dataSource.target, path: pathArr };
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const msg = errBody?.error?.message ?? res.statusText;
        const code = errBody?.error?.code ?? 'E_UNKNOWN';
        const err = new Error(msg);
        err.code = code;
        err.status = res.status;
        throw err;
    }
    return await res.json();
}

/**
 * V1 provider · 通过 REST endpoint 拿 InspectorResponse.
 * 只读(canMutate=false).
 */
export class RestProvider {
    constructor(dataSource) {
        this.id = 'rest';
        this.canMutate = false;
        this.dataSource = dataSource;  // {kind:'self'} | {kind:'any', target}
    }

    async fetch(pathArr) {
        const resp = await fetchInspector(this.dataSource, pathArr);
        // 补 canDelete 默认值(V1 backend 不发)
        for (const e of resp.entries ?? []) {
            e.canDelete = e.canDelete ?? false;
        }
        return resp;
    }
}

/**
 * 只读 mutator · 任何删除请求都 throw.
 */
export class ThrowingMutator {
    async deleteAtPath(_pathArr) {
        const err = new Error(t`This inspector is read-only.`);
        err.code = 'E_READ_ONLY';
        throw err;
    }
}

class StorageInspector {
    /**
     * @param {{provider: StorageProvider, mutator: StorageMutator, container: HTMLElement}} opts
     */
    constructor({ provider, mutator, container }) {
        this.provider = provider;
        this.mutator = mutator;
        this.container = container;
        this.pathStack = [];
        this.cache = new Map();  // key = _cacheKey(path) → InspectorResponse
    }

    async init() {
        await this._renderShell();
        await this.navigateTo([]);
    }

    async _renderShell() {
        const tpl = await renderTemplateAsync('storageInspector');
        this.container.innerHTML = tpl;

        this.container.querySelector('.storageInspectorRefreshButton')
            .addEventListener('click', () => this.refresh());
        this.container.querySelector('.storageInspectorRetryButton')
            .addEventListener('click', () => this.navigateTo(this.pathStack));
    }

    _cacheKey(pathArr) {
        return JSON.stringify({
            pid: this.provider.id,
            ds: this.provider.dataSource ?? null,
            p: pathArr,
        });
    }

    async navigateTo(pathArr) {
        this.pathStack = pathArr;
        const key = this._cacheKey(pathArr);
        this._showLoading();
        try {
            let resp = this.cache.get(key);
            if (!resp) {
                resp = await this.provider.fetch(pathArr);
                this.cache.set(key, resp);
            }
            // aggregate depth-3 redirect(仅 V1 REST provider 会产生;V2 provider 不发 redirect,undefined 时自然 skip)
            if (resp.redirect) {
                this.provider.dataSource = { kind: 'any', target: resp.redirect.target };
                this.pathStack = resp.redirect.path;
                this.cache.clear();  // 换 target,cache 失效
                return this.navigateTo(this.pathStack);
            }
            this._renderResponse(resp);
        } catch (err) {
            this._showError(err);
        }
    }

    async refresh() {
        this.cache.clear();
        return this.navigateTo(this.pathStack);
    }

    _renderResponse(resp) {
        this._hideLoading();
        this._renderQuota(resp.quota);
        this._renderStackedBar(resp);
        this._renderLegend(resp);
        this._renderBreadcrumbs(resp);
        this._renderList(resp);
    }

    _renderQuota(quota) {
        const used = this.container.querySelector('.storageInspectorQuotaUsed');
        const total = this.container.querySelector('.storageInspectorQuotaTotal');
        used.textContent = humanFileSize(quota?.usedBytes ?? 0);
        if (quota?.quotaBytes === null || quota?.quotaBytes === undefined) {
            total.textContent = t`Unlimited`;
        } else {
            total.textContent = humanFileSize(quota.quotaBytes);
        }
        used.classList.toggle('storageInspectorQuotaOver', !!quota?.over);
    }

    _renderStackedBar(resp) {
        const bar = this.container.querySelector('.storageInspectorStackedBar');
        bar.innerHTML = '';
        const total = resp.entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0) || 1;
        for (const e of resp.entries) {
            if (!e.sizeBytes) continue;
            const seg = document.createElement('div');
            seg.className = 'storageInspectorBarSegment';
            seg.style.width = `${(e.sizeBytes / total * 100).toFixed(2)}%`;
            seg.style.background = this._colorFor(e);
            seg.title = `${translate(e.label)}: ${humanFileSize(e.sizeBytes)}`;
            seg.addEventListener('click', () => {
                if (e.canDrill) this.navigateTo([...this.pathStack, e.key]);
            });
            bar.appendChild(seg);
        }
    }

    _renderLegend(resp) {
        const legend = this.container.querySelector('.storageInspectorLegend');
        legend.innerHTML = '';
        for (const e of resp.entries) {
            if (!e.sizeBytes) continue;
            const item = document.createElement('span');
            item.className = 'storageInspectorLegendItem';
            const swatch = document.createElement('span');
            swatch.className = 'storageInspectorLegendSwatch';
            swatch.style.background = this._colorFor(e);
            const label = document.createElement('span');
            label.textContent = `${translate(e.label)} · ${humanFileSize(e.sizeBytes)}`;
            item.append(swatch, label);
            legend.appendChild(item);
        }
    }

    _renderBreadcrumbs(resp) {
        const nav = this.container.querySelector('.storageInspectorBreadcrumbs');
        nav.innerHTML = '';
        const crumbs = resp.breadcrumbs ?? [];
        crumbs.forEach((c, i) => {
            const isLast = i === crumbs.length - 1;
            const el = document.createElement(isLast ? 'span' : 'a');
            el.textContent = translate(c.label);
            el.className = isLast
                ? 'storageInspectorBreadcrumbCurrent'
                : 'storageInspectorBreadcrumbCrumb';
            if (!isLast) {
                el.href = '#';
                el.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    this.navigateTo(c.path);
                });
            }
            nav.appendChild(el);
            if (!isLast) {
                const sep = document.createElement('span');
                sep.className = 'storageInspectorBreadcrumbSep';
                sep.textContent = '›';
                nav.appendChild(sep);
            }
        });
    }

    _renderList(resp) {
        const list = this.container.querySelector('.storageInspectorList');
        list.innerHTML = '';
        if (resp.entries.length === 0) {
            this.container.querySelector('.storageInspectorEmpty').classList.remove('displayNone');
            return;
        }
        this.container.querySelector('.storageInspectorEmpty').classList.add('displayNone');

        // 计算最大 size 用于 dots 相对填充
        const maxSize = Math.max(...resp.entries.map(e => e.sizeBytes ?? 0), 1);

        for (const e of resp.entries) {
            list.appendChild(this._renderEntry(e, maxSize));
        }
    }

    _renderEntry(entry, maxSize) {
        const row = document.createElement('div');
        row.className = 'storageInspectorEntry';
        if (entry.canDrill) row.classList.add('storageInspectorEntryDrillable');
        if (entry.kind === 'sensitive-blob') row.classList.add('storageInspectorSensitiveBlob');
        row.dataset.kind = entry.kind;
        row.dataset.key = entry.key;

        const icon = document.createElement('span');
        icon.className = 'storageInspectorEntryIcon';
        const iconName = /^[a-z0-9-]+$/.test(entry.icon ?? '') ? entry.icon : 'file';
        const iconEl = document.createElement('i');
        iconEl.classList.add('fa-fw', 'fa-solid', `fa-${iconName}`);
        icon.replaceChildren(iconEl);
        icon.style.color = this._colorFor(entry);

        const label = document.createElement('span');
        label.className = 'storageInspectorEntryLabel';
        label.textContent = translate(entry.label) + (entry.labelSuffix ?? '');
        if (entry.note) label.title = translate(entry.note);

        const dots = document.createElement('span');
        dots.className = 'storageInspectorEntryDots';
        dots.style.color = this._colorFor(entry);
        const filled = Math.round(((entry.sizeBytes ?? 0) / maxSize) * 8);
        for (let i = 0; i < 8; i++) {
            const d = document.createElement('span');
            d.className = 'storageInspectorEntryDot';
            if (i < filled) d.classList.add('storageInspectorEntryDotFilled');
            dots.appendChild(d);
        }

        const size = document.createElement('span');
        size.className = 'storageInspectorEntrySize';
        size.textContent = entry.sizeBytes == null ? '?' : humanFileSize(entry.sizeBytes);

        row.append(icon, label, dots, size);

        // 删除按钮 · provider 与 entry 均声明支持时才 render
        if (this.provider.canMutate && entry.canDelete) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'storageInspectorEntryDeleteButton menu_button menu_button_icon';
            del.title = translate('Delete');
            del.setAttribute('data-i18n', '[title]Delete');
            const delIcon = document.createElement('i');
            delIcon.classList.add('fa-fw', 'fa-solid', 'fa-trash');
            del.appendChild(delIcon);
            del.addEventListener('click', async (ev) => {
                ev.stopPropagation();  // 别触发 drill
                if (del.disabled) return;
                del.disabled = true;
                try {
                    await this._confirmAndDelete(entry);
                } finally {
                    // refresh() 后 del 可能已被 detach,只在还挂在 DOM 上时才恢复.
                    if (del.isConnected) del.disabled = false;
                }
            });
            row.appendChild(del);
        }

        if (entry.canDrill) {
            const chev = document.createElement('span');
            chev.className = 'storageInspectorEntryChevron';
            const chevIcon = document.createElement('i');
            chevIcon.classList.add('fa-fw', 'fa-solid', 'fa-chevron-right');
            chev.replaceChildren(chevIcon);
            row.appendChild(chev);
            row.addEventListener('click', () => this.navigateTo([...this.pathStack, entry.key]));
        }

        return row;
    }

    /**
     * 弹二次确认 · 用户确认后调 mutator.deleteAtPath,成功 refresh.
     */
    async _confirmAndDelete(entry) {
        const label = translate(entry.label) + (entry.labelSuffix ?? '');
        const body = translate('This will permanently remove %s from your browser. This action cannot be undone.').replace('%s', label);
        // Also expose 'Delete %s?' to the i18n string harvester for Task 4 (popup has no title slot yet).
        void translate('Delete %s?');
        const confirmed = await callGenericPopup(body, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Cancel`, wide: false });
        if (!confirmed) return;
        try {
            await this.mutator.deleteAtPath([...this.pathStack, entry.key]);
            await this.refresh();
        } catch (err) {
            this._showError(err);
        }
    }

    _colorFor(entry) {
        // 优先 category color · 叶子 entry 用父类别 color(pathStack 的第 0 层)
        const catKey = entry.kind === 'category'
            ? entry.key
            : (this.pathStack[0] ?? 'other');
        const meta = CATEGORY_META[catKey] ?? CATEGORY_META.other;
        return `var(${meta.colorVar})`;
    }

    _showLoading() {
        this.container.querySelector('.storageInspectorLoading').classList.remove('displayNone');
        this.container.querySelector('.storageInspectorError').classList.add('displayNone');
    }

    _hideLoading() {
        this.container.querySelector('.storageInspectorLoading').classList.add('displayNone');
    }

    _showError(err) {
        this._hideLoading();
        const box = this.container.querySelector('.storageInspectorError');
        const msg = this.container.querySelector('.storageInspectorErrorMessage');
        msg.textContent = `${err.code ?? 'ERROR'}: ${err.message}`;
        box.classList.remove('displayNone');
    }
}

/**
 * Public entry point · 供 User Profile 按钮和 Admin panel tab 调.
 * @param {{kind:'self'} | {kind:'any', target:string}} dataSource
 */
export async function openStorageInspector(dataSource) {
    const container = document.createElement('div');
    container.classList.add('storageInspectorContainerWrapper');
    const inspector = new StorageInspector({
        provider: new RestProvider(dataSource),
        mutator: new ThrowingMutator(),
        container,
    });
    await inspector.init();
    return callGenericPopup(container, POPUP_TYPE.DISPLAY, '', {
        wide: true, wider: true, large: true,
        allowVerticalScrolling: true,
        okButton: t`Close`,
    });
}

/**
 * Mount Inspector 到已有 container(用于 Admin panel tab 内直接 embed).
 * @param {{kind:'self'} | {kind:'any', target:string}} dataSource
 * @param {HTMLElement} container
 */
export async function mountStorageInspector(dataSource, container) {
    const inspector = new StorageInspector({
        provider: new RestProvider(dataSource),
        mutator: new ThrowingMutator(),
        container,
    });
    await inspector.init();
    return inspector;
}

/**
 * V2 使用 · 传入自定义 provider + mutator 构造 Inspector.
 * @param {{provider, mutator, container: HTMLElement}} opts
 */
export function createStorageInspector(opts) {
    return new StorageInspector(opts);
}
