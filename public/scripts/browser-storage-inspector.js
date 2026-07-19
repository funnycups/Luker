/**
 * V2 Browser Storage Inspector · 浏览器侧 5 大存储 API 的 provider + mutator.
 * 与 V1 服务端 REST inspector 共享同一 UI 外观(见 storage-inspector.js).
 */
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { createStorageInspector } from './storage-inspector.js';
import { t, translate } from './i18n.js';

// 5 大 category 元数据 · 与 storage-inspector.js CATEGORY_META 保持一致.
const BROWSER_CATEGORIES = [
    { key: 'localStorage',   label: 'localStorage'   },
    { key: 'sessionStorage', label: 'sessionStorage' },
    { key: 'indexeddb',      label: 'IndexedDB'      },
    { key: 'cachestorage',   label: 'Cache Storage'  },
    { key: 'quota',          label: 'Storage Quota'  },
];

// UI icon 走 CATEGORY_META(在 storage-inspector.js 里 export);browser 类别的
// icon/colorVar 由 storage-inspector.js 的扩展条目提供,provider 只发 key.

/**
 * V2 provider · 浏览器 API 枚举.
 * canMutate = true(配合 BrowserMutator 用).
 */
export class BrowserProvider {
    constructor() {
        this.id = 'browser';
        this.canMutate = true;
        this.dataSource = null;  // browser 只有一个 origin,无 dataSource
    }

    async fetch(pathArr) {
        const quota = await estimateQuota();
        if (pathArr.length === 0) {
            return this._fetchRoot(quota);
        }
        const [cat, ...rest] = pathArr;
        switch (cat) {
            case 'localStorage':   return this._fetchStorageKeys(quota, 'localStorage',   rest);
            case 'sessionStorage': return this._fetchStorageKeys(quota, 'sessionStorage', rest);
            case 'indexeddb':      return this._fetchIndexedDb(quota, rest);
            case 'cachestorage':   return this._fetchCacheStorage(quota, rest);
            case 'quota':          return this._fetchQuotaLeaf(quota);
            default:               throw makeErr('E_INVALID_PATH', `Unknown category: ${cat}`);
        }
    }

    async _fetchRoot(quota) {
        const entries = [];
        for (const cat of BROWSER_CATEGORIES) {
            let sizeBytes = null;
            let childCount = 0;
            let labelSuffix = '';
            let canDrill = true;
            let canDelete = false;  // 单 category 行不可删

            if (cat.key === 'localStorage' || cat.key === 'sessionStorage') {
                const stg = window[cat.key];
                childCount = stg.length;
                let bytes = 0;
                for (let i = 0; i < stg.length; i++) {
                    const k = stg.key(i);
                    const v = stg.getItem(k) ?? '';
                    bytes += estimateEntryBytes(k, v);
                }
                sizeBytes = bytes;
                labelSuffix = ` (${childCount})`;
                canDrill = childCount > 0;
            } else if (cat.key === 'indexeddb') {
                const dbs = await safeListDatabases();
                childCount = dbs.length;
                labelSuffix = ` (${childCount})`;
                canDrill = childCount > 0;
            } else if (cat.key === 'cachestorage') {
                const cacheNames = await safeCacheKeys();
                childCount = cacheNames.length;
                labelSuffix = ` (${childCount})`;
                canDrill = childCount > 0;
            } else if (cat.key === 'quota') {
                sizeBytes = quota.usedBytes;
                canDrill = false;
            }

            entries.push({
                key: cat.key,
                label: cat.label,
                labelSuffix,
                icon: iconForBrowserCategory(cat.key),
                kind: 'category',
                sizeBytes,
                mtimeMs: null,
                childCount,
                canDrill,
                canDelete,
                note: null,
            });
        }

        return {
            target: { type: 'browser' },
            quota,
            path: [],
            breadcrumbs: [{ label: t`Browser Storage`, path: [] }],
            isLeaf: false,
            canMutate: true,
            entries,
        };
    }

    async _fetchStorageKeys(quota, kind, rest) {
        if (rest.length !== 0) {
            throw makeErr('E_INVALID_PATH', `${kind} has no drilldown beyond L2`);
        }
        const stg = window[kind];
        const entries = [];
        for (let i = 0; i < stg.length; i++) {
            const k = stg.key(i);
            const v = stg.getItem(k) ?? '';
            entries.push({
                key: k,
                label: k,  // 用户 key 名,translate 会 no-op
                icon: 'key',
                kind: 'storage-key',
                sizeBytes: estimateEntryBytes(k, v),
                mtimeMs: null,
                canDrill: false,
                canDelete: true,
                note: null,
            });
        }
        // 按 size desc 排序 · 大的在前
        entries.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

        return {
            target: { type: 'browser' },
            quota,
            path: [kind],
            breadcrumbs: [
                { label: t`Browser Storage`, path: [] },
                { label: kind, path: [kind] },
            ],
            isLeaf: true,
            canMutate: true,
            entries,
        };
    }

    async _fetchIndexedDb(quota, rest) {
        if (rest.length === 0) {
            // L2: DB 列表
            const dbs = await safeListDatabases();
            const entries = [];
            for (const info of dbs) {
                if (!info.name) continue;  // 无名 DB skip
                let storeCount = 0;
                try {
                    const db = await openReadOnly(info.name);
                    storeCount = db.objectStoreNames.length;
                    db.close();
                } catch { /* leave storeCount = 0 */ }
                entries.push({
                    key: info.name,
                    label: info.name,
                    labelSuffix: ` (${storeCount} ${translate('stores')})`,
                    icon: 'database',
                    kind: 'idb-db',
                    sizeBytes: null,
                    mtimeMs: null,
                    childCount: storeCount,
                    canDrill: storeCount > 0,
                    canDelete: true,  // 整 DB 可删
                    note: null,
                });
            }
            return {
                target: { type: 'browser' },
                quota,
                path: ['indexeddb'],
                breadcrumbs: [
                    { label: t`Browser Storage`, path: [] },
                    { label: 'IndexedDB', path: ['indexeddb'] },
                ],
                isLeaf: false,
                canMutate: true,
                entries,
            };
        }
        // L3: store 列表 within a DB
        const [dbName, ...rest2] = rest;
        if (rest2.length !== 0) {
            throw makeErr('E_INVALID_PATH', 'IndexedDB has no drilldown beyond L3');
        }
        const db = await openReadOnly(dbName);
        const storeNames = Array.from(db.objectStoreNames);
        const entries = [];
        for (const sn of storeNames) {
            let count = 0;
            try {
                count = await countStore(db, sn);
            } catch { /* leave 0 */ }
            entries.push({
                key: sn,
                label: sn,
                labelSuffix: ` (${count} ${translate('records')})`,
                icon: 'table',
                kind: 'idb-store',
                sizeBytes: null,
                mtimeMs: null,
                childCount: count,
                canDrill: false,
                canDelete: true,
                note: null,
            });
        }
        db.close();

        return {
            target: { type: 'browser' },
            quota,
            path: ['indexeddb', dbName],
            breadcrumbs: [
                { label: t`Browser Storage`, path: [] },
                { label: 'IndexedDB', path: ['indexeddb'] },
                { label: dbName, path: ['indexeddb', dbName] },
            ],
            isLeaf: true,
            canMutate: true,
            entries,
        };
    }

    async _fetchCacheStorage(quota, rest) {
        if (rest.length !== 0) {
            throw makeErr('E_INVALID_PATH', 'Cache Storage has no drilldown beyond L2');
        }
        const names = await safeCacheKeys();
        const entries = [];
        for (const name of names) {
            let requestCount = 0;
            try {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                requestCount = keys.length;
            } catch { /* leave 0 */ }
            entries.push({
                key: name,
                label: name,
                labelSuffix: ` (${requestCount} ${translate('requests')})`,
                icon: 'file-lines',
                kind: 'cache',
                sizeBytes: null,
                mtimeMs: null,
                childCount: requestCount,
                canDrill: false,
                canDelete: true,
                note: null,
            });
        }
        return {
            target: { type: 'browser' },
            quota,
            path: ['cachestorage'],
            breadcrumbs: [
                { label: t`Browser Storage`, path: [] },
                { label: 'Cache Storage', path: ['cachestorage'] },
            ],
            isLeaf: true,
            canMutate: true,
            entries,
        };
    }

    async _fetchQuotaLeaf(quota) {
        const used = quota.usedBytes;
        const q = quota.quotaBytes;
        const note = q == null
            ? t`Browser did not report a quota.`
            : `${((used / q) * 100).toFixed(1)}% used`;
        return {
            target: { type: 'browser' },
            quota,
            path: ['quota'],
            breadcrumbs: [
                { label: t`Browser Storage`, path: [] },
                { label: 'Storage Quota', path: ['quota'] },
            ],
            isLeaf: true,
            canMutate: true,
            entries: [{
                key: 'quota',
                label: 'Storage Quota',
                icon: 'chart-pie',
                kind: 'quota-leaf',
                sizeBytes: used,
                mtimeMs: null,
                canDrill: false,
                canDelete: false,  // quota 不可删
                note,
            }],
        };
    }
}

/**
 * UTF-16 approximation · key.length + value.length 每字符 2 字节.
 * BMP 外字符(surrogate pair)可能低估 · 误差 < 5% 可接受.
 * 这是估算,不是 cap;上游没有硬约束数字上限.
 */
export function estimateEntryBytes(key, value) {
    return ((key ?? '').length + (value ?? '').length) * 2;
}

async function estimateQuota() {
    try {
        if (!navigator.storage?.estimate) return { usedBytes: 0, quotaBytes: null, over: false };
        const { usage = 0, quota = null } = await navigator.storage.estimate();
        return { usedBytes: usage, quotaBytes: quota, over: quota != null && usage > quota };
    } catch {
        return { usedBytes: 0, quotaBytes: null, over: false };
    }
}

async function safeListDatabases() {
    try {
        if (!indexedDB.databases) return [];  // 旧 Safari
        return await indexedDB.databases();
    } catch {
        return [];
    }
}

async function safeCacheKeys() {
    try {
        if (!('caches' in window)) return [];
        return await caches.keys();
    } catch {
        return [];
    }
}

function iconForBrowserCategory(key) {
    switch (key) {
        case 'localStorage':   return 'hard-drive';
        case 'sessionStorage': return 'clock';
        case 'indexeddb':      return 'database';
        case 'cachestorage':   return 'layer-group';
        case 'quota':          return 'chart-pie';
        default:               return 'file';
    }
}

function openReadOnly(dbName) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(makeErr('E_DB_OPEN_FAILED', `Cannot open ${dbName}: ${req.error?.message ?? 'unknown'}`));
        // onupgradeneeded: 有些 vendor DB 不在 databases() 返回值里但 open 会触发 upgrade;
        // 我们不 upgrade,直接 abort 事务并 resolve empty view.
        req.onupgradeneeded = () => { req.transaction?.abort(); };
    });
}

function countStore(db, storeName) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) {
            reject(e);
        }
    });
}

function makeErr(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * V2 mutator · 5 种 path 形状 dispatch 到对应删除操作.
 * 失败时 throw Error(带 .code):E_INVALID_PATH / E_DB_LOCKED / E_STORAGE_UNAVAILABLE / E_UNKNOWN.
 */
export class BrowserMutator {
    async deleteAtPath(pathArr) {
        if (!Array.isArray(pathArr) || pathArr.length < 2) {
            throw makeErr('E_INVALID_PATH', `Path must have at least [category, key]: got ${JSON.stringify(pathArr)}`);
        }
        const [cat, ...rest] = pathArr;
        switch (cat) {
            case 'localStorage':
                if (rest.length !== 1) throw makeErr('E_INVALID_PATH', 'localStorage path must be [localStorage, key]');
                localStorage.removeItem(rest[0]);
                return;
            case 'sessionStorage':
                if (rest.length !== 1) throw makeErr('E_INVALID_PATH', 'sessionStorage path must be [sessionStorage, key]');
                sessionStorage.removeItem(rest[0]);
                return;
            case 'indexeddb':
                if (rest.length === 1) return this._deleteIdbDatabase(rest[0]);
                if (rest.length === 2) return this._clearIdbStore(rest[0], rest[1]);
                throw makeErr('E_INVALID_PATH', `IndexedDB path depth ${rest.length} invalid`);
            case 'cachestorage':
                if (rest.length !== 1) throw makeErr('E_INVALID_PATH', 'Cache Storage path must be [cachestorage, name]');
                await caches.delete(rest[0]);
                return;
            case 'quota':
                throw makeErr('E_NOT_INSPECTABLE', 'Storage Quota is not deletable');
            default:
                throw makeErr('E_INVALID_PATH', `Unknown category: ${cat}`);
        }
    }

    /**
     * IDB deleteDatabase 会在有开着的连接时触发 `blocked` 事件挂起.
     * 5 秒后仍未 success · 视为 lock · 抛可读错误.
     * 5s 是 UX-driven 阈值:vendor lib 通常在 tab 切换后几百 ms 内关闭 IDB
     * 连接;超过 5s 说明用户还开着其他 tab / worker 持有连接,继续等无意义.
     */
    _deleteIdbDatabase(dbName) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(dbName);
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                reject(makeErr('E_DB_LOCKED', `Database "${dbName}" is locked by another connection. Try closing other Luker tabs and retry.`));
            }, 5000);
            req.onsuccess = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve();
            };
            req.onerror = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(makeErr('E_UNKNOWN', `Delete failed: ${req.error?.message ?? 'unknown'}`));
            };
            // blocked 时不立刻 reject,让 timeout 触发(给持连接方一个关闭机会)
        });
    }

    async _clearIdbStore(dbName, storeName) {
        const db = await openReadOnly(dbName);
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const req = store.clear();
                req.onsuccess = () => resolve();
                req.onerror = () => reject(makeErr('E_UNKNOWN', `Store clear failed: ${req.error?.message ?? 'unknown'}`));
                tx.onerror = () => reject(makeErr('E_UNKNOWN', `Transaction failed: ${tx.error?.message ?? 'unknown'}`));
            });
        } finally {
            db.close();
        }
    }
}

/**
 * Public entry point · User Profile 按钮点击时调用.
 * 打开 popup · 内嵌 UI shell + BrowserProvider + BrowserMutator.
 */
export async function openBrowserStorageInspector() {
    const container = document.createElement('div');
    container.classList.add('storageInspectorContainerWrapper');
    const inspector = createStorageInspector({
        provider: new BrowserProvider(),
        mutator: new BrowserMutator(),
        container,
    });
    await inspector.init();
    return callGenericPopup(container, POPUP_TYPE.DISPLAY, '', {
        wide: true, wider: true, large: true,
        allowVerticalScrolling: true,
        okButton: t`Close`,
    });
}
