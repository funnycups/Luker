// Preview-only data source for the Data window. Mirrors the shape of the real provider.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN = 60 * 1000;

const SYNC_CATEGORY_GROUPS = [
    ['角色与聊天', [['characters', '角色卡'], ['chats', '聊天与群组'], ['worlds', '世界书'], ['cardapps', '卡片应用'], ['skills', '技能']]],
    ['预设', [['openai', 'OpenAI'], ['novel', 'NovelAI'], ['kobold', 'KoboldAI'], ['textgen', '文本补全'], ['instruct', '指令模板'], ['context', '上下文模板'], ['sysprompt', '系统提示词'], ['reasoning', '推理模板']]],
    ['外观', [['themes', '主题'], ['movingui', '移动 UI'], ['quickreplies', '快速回复'], ['backgrounds', '背景'], ['avatars', '用户头像']]],
    ['文件', [['assets', '素材'], ['files', '上传文件'], ['comfy', 'ComfyUI 工作流'], ['images', '用户图片'], ['imagemeta', '图片元数据'], ['vectors', '向量缓存'], ['stats', '角色统计']]],
    ['系统', [['settings', '设置'], ['extensions', '扩展插件', true], ['secrets', 'API 密钥', true]]],
];

const BACKUP_CATEGORIES = [
    { id: 'settings', label: '设置', def: true },
    { id: 'secrets', label: 'API 密钥', def: true, sensitive: true },
    { id: 'characters', label: '角色与头像', def: true },
    { id: 'chats', label: '聊天与群组', def: true },
    { id: 'worlds', label: '世界书', def: true },
    { id: 'presets', label: '预设与界面布局', def: true },
    { id: 'assets', label: '素材与文件', def: true },
    { id: 'userExt', label: '用户扩展', def: true },
    { id: 'globalExt', label: '全局扩展', def: false, adminOnly: true },
    { id: 'vectors', label: '向量索引', def: false },
];

const allSync = () => SYNC_CATEGORY_GROUPS.flatMap(([, items]) => items.filter(i => !i[2]).map(i => i[0]));
const AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><rect width="120" height="160" fill="#c8b8e8"/><circle cx="60" cy="62" r="30" fill="#f4e3d3"/><rect x="22" y="104" width="76" height="56" rx="30" fill="#7a5fb0"/></svg>');
const AVATAR2 = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><rect width="120" height="160" fill="#a9d8cf"/><circle cx="60" cy="62" r="30" fill="#f4e3d3"/><rect x="22" y="104" width="76" height="56" rx="30" fill="#2f8f7c"/></svg>');

function stamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fail(message, code, extra = {}) {
    return Object.assign(new Error(message), { code }, extra);
}

export function createMockProvider() {
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());
    const now = Date.now();
    let applyRound = 0;

    const state = {
        available: true,
        unavailableReason: '',
        statusError: false,
        listError: false,
        isAdmin: true,
        handle: 'default-user',
        caps: { allowFullBackup: true, allowSecrets: true },
        device: { label: 'Desk', placeholder: 'xzhou-macbook' },
        schedule: { idle: 60, poll: 300 },
        syncCategories: SYNC_CATEGORY_GROUPS,
        backupCategories: BACKUP_CATEGORIES,
        backends: [
            { id: 'b1', kind: 's3', label: '共享归档', state: 'running', lastSync: now - 3 * MIN, startedAt: now - 12000, categories: allSync(), canUndo: true },
            { id: 'b2', kind: 'lan', label: '平板', state: 'ok', lastSync: now - 20000, categories: allSync(), canUndo: true, hasStoredCredentials: true },
            { id: 'b3', kind: 'lan', label: 'VPS', state: 'ok', lastSync: now - 62 * MIN, categories: allSync(), canUndo: true, stalled: ['chats/都市神壕之我爱装逼/2026-11-01.jsonl', 'worlds/星途重启.json'] },
            { id: 'b4', kind: 'lan', label: '办公室台式机', state: 'error', lastSync: now - 2 * 24 * 60 * MIN, categories: allSync(), canUndo: false, error: '连不上对方设备，请确认它开着、并且和本机在同一网络' },
            { id: 'b5', kind: 'lan', label: '手机', state: 'pending', lastSync: 0, categories: allSync(), canUndo: false },
        ],
        conflicts: [
            {
                key: 'c1', backendId: 'b2', path: 'worlds/Cascade Lore.json', kind: '世界书', stale: false, review: { opaque: true },
                versions: [
                    { id: 'theirs', from: '平板', inUse: true, preview: { kind: 'text', text: 'Stay beside the river until you hear the moonwell beneath the reeds.' } },
                    { id: 'ours', from: 'Desk', preview: { kind: 'text', text: 'Follow the birches north; the moonwell lies beyond the standing stones.' } },
                    { id: 'current', current: true, preview: { kind: 'text', text: 'Stay beside the river until you hear the moonwell beneath the reeds.' } },
                ],
            },
            {
                key: 'c2', backendId: 'b3', path: 'settings.json', kind: '设置', stale: true, review: { opaque: true },
                versions: [
                    { id: 'theirs', from: 'VPS', preview: { kind: 'text', text: '{\n  "main_api": "openai",\n  "amount_gen": 2048\n}' } },
                    { id: 'ours', from: 'Desk', preview: { kind: 'text', text: '{\n  "main_api": "openai",\n  "amount_gen": 4096\n}' } },
                    { id: 'current', current: true, preview: { kind: 'text', text: '{\n  "main_api": "openai",\n  "amount_gen": 8192\n}' } },
                ],
            },
            {
                key: 'c3', backendId: 'b2', path: 'characters/Seraphina.png', kind: '角色卡', stale: false, review: { opaque: true },
                versions: [
                    { id: 'theirs', from: '平板', preview: { kind: 'image', url: AVATAR2 } },
                    { id: 'ours', from: 'Desk', preview: { kind: 'deleted' } },
                    { id: 'current', current: true, inUse: true, preview: { kind: 'image', url: AVATAR } },
                ],
            },
        ],
        notices: [
            { id: 'n1', type: 'fork', title: '「Seraphina」的聊天出现了分支', detail: '平板和本机同时改了同一段聊天，平板的版本另存为分支', action: '打开分支' },
            { id: 'n2', type: 'restored', title: '恢复了群聊「月井旅团」', detail: 'VPS 删除了它，但本机还在编辑', action: '打开聊天' },
            { id: 'n3', type: 'fork', title: '群聊「旧日酒馆」的聊天出现了分支', detail: '来自 VPS', action: '打开分支', missingGroup: true },
        ],
    };

    const find = id => state.backends.find(b => b.id === id);

    // The running backend finishes on its own so the preview shows the transition.
    setTimeout(() => {
        const b = find('b1');
        if (b?.state === 'running') {
            Object.assign(b, { state: 'ok', lastSync: Date.now() });
            emit();
        }
    }, 9000);

    return {
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        snapshot() {
            return state;
        },
        async syncNow(id) {
            const b = find(id);
            Object.assign(b, { state: 'running', startedAt: Date.now(), error: null });
            emit();
            await wait(2600);
            if (b.id === 'b4') {
                Object.assign(b, { state: 'error', error: '连不上对方设备，请确认它开着、并且和本机在同一网络' });
                emit();
                throw fail('连不上对方设备，请确认它开着、并且和本机在同一网络', 'PEER_UNREACHABLE');
            }
            Object.assign(b, { state: 'ok', lastSync: Date.now(), canUndo: true });
            emit();
            return { conflicts: state.conflicts.filter(c => c.backendId === id).length, stalled: b.stalled?.length || 0 };
        },
        async undo(id) {
            await wait(900);
            const b = find(id);
            if (!b.canUndo) throw fail('没有可以撤销的同步', 'NOTHING_TO_UNDO');
            b.canUndo = false;
            emit();
            return { kept: id === 'b3' ? ['worlds/星途重启.json', 'chats/都市神壕之我爱装逼/2026-11-01.jsonl'] : [] };
        },
        async remove(id) {
            await wait(500);
            state.backends = state.backends.filter(b => b.id !== id);
            emit();
        },
        async clearAuth(id) {
            await wait(400);
            find(id).hasStoredCredentials = false;
            emit();
        },
        async saveDevice(label) {
            await wait(400);
            state.device.label = label.replace(/\s+/g, ' ').trim();
            emit();
            return state.device.label;
        },
        async saveSchedule(idle, poll) {
            await wait(400);
            state.schedule = { idle: Math.round(idle), poll: Math.round(poll) };
            emit();
            return state.schedule;
        },
        async createPairLink({ label, categories }) {
            await wait(700);
            const code = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
            const existing = state.backends.find(b => b.state === 'pending' && b.label === label);
            if (!existing) state.backends.push({ id: 'b' + Date.now(), kind: 'lan', label, state: 'pending', lastSync: 0, categories, canUndo: false });
            emit();
            const addresses = ['http://127.0.0.1:8000', 'http://192.168.1.20:8000', 'http://10.0.0.5:8000', 'http://[::1]:8000'];
            return { addresses, link: addr => `${addr}/sync/pair#peer=a8f3c2&code=${code}&handle=${state.handle}&label=${encodeURIComponent(label)}&cats=${categories.join(',')}` };
        },
        parsePairLink(link) {
            const m = /^(https?:\/\/[^/]+)\/sync\/pair#(.+)$/.exec(link.trim());
            if (!m) return null;
            const q = new URLSearchParams(m[2]);
            if (!q.get('peer') || !q.get('code')) return null;
            return { url: m[1], peerId: q.get('peer'), code: q.get('code'), handle: q.get('handle') || '', label: q.get('label') || '', categories: (q.get('cats') || '').split(',').filter(Boolean) };
        },
        currentHandle() {
            return state.handle;
        },
        async acceptPair({ url, label, user, categories }) {
            await wait(1600);
            if (/:8443/.test(url) && !user) throw fail('对方设置了登录密码，请填写对方的账号和密码', 'PEER_AUTH_REQUIRED');
            const b = { id: 'b' + Date.now(), kind: 'lan', label: label || '新设备', state: 'ok', lastSync: Date.now(), categories, canUndo: true, hasStoredCredentials: !!user };
            state.backends.push(b);
            emit();
            return b;
        },
        async saveS3(form, id) {
            await wait(1400);
            if (/fail/i.test(form.accessKey)) throw fail('连接失败：密钥不对（403 SignatureDoesNotMatch）', 'S3_AUTH');
            if (id) {
                Object.assign(find(id), { label: form.label, categories: form.categories });
            } else {
                state.backends.push({ id: 'b' + Date.now(), kind: 's3', label: form.label, state: 'ok', lastSync: Date.now(), categories: form.categories, canUndo: false, s3: { ...form, secretKey: '', accessKey: '', passphrase: '' } });
            }
            emit();
        },
        getS3(id) {
            return find(id).s3 || { endpoint: 'https://cos.ap-hongkong.myqcloud.com', region: 'ap-hongkong', bucket: 'luker-sync-1250000000', prefix: 'desk/', pathStyle: false };
        },
        async unlockS3(id, passphrase) {
            await wait(900);
            if (!passphrase) throw fail('请输入加密口令', 'EMPTY');
            find(id).state = 'ok';
            emit();
        },
        async editLan(id, { label, categories }) {
            await wait(500);
            Object.assign(find(id), { label, categories });
            emit();
        },
        async applyConflicts(choices) {
            await wait(900);
            applyRound++;
            const result = { applied: [], alreadyResolved: [], failed: [] };
            for (const c of state.conflicts) {
                if (!choices[c.key]) continue;
                if (c.key === 'c2' && applyRound === 1) result.failed.push({ key: c.key, path: c.path, reason: '文件正被其他操作占用，请稍后再试' });
                else if (c.key === 'c3' && applyRound === 1) result.alreadyResolved.push({ key: c.key, path: c.path });
                else result.applied.push(c.key);
            }
            const done = new Set([...result.applied, ...result.alreadyResolved.map(x => x.key)]);
            state.conflicts = state.conflicts.filter(c => !done.has(c.key));
            emit();
            return result;
        },
        async dismissNotice(id) {
            await wait(300);
            state.notices = state.notices.filter(n => n.id !== id);
            emit();
        },
        async openNotice(id) {
            await wait(300);
            const n = state.notices.find(x => x.id === id);
            if (n?.missingGroup) throw fail('找不到这个聊天所在的群', 'GROUP_MISSING');
        },
        async downloadBackup(categories, onProgress) {
            onProgress({ stage: 'pack' });
            await wait(1800);
            onProgress({ stage: 'download', percent: 0 });
            for (let p = 10; p <= 100; p += 15) {
                await wait(220);
                onProgress({ stage: 'download', percent: Math.min(p, 100) });
            }
            return { fileName: `${state.handle}-${stamp()}.zip`, size: 48.3 * 1024 * 1024 };
        },
        async restoreBackup({ file, tempDb, resumeFrom = 0 }, onProgress) {
            const engine = /postgres|pg/i.test(file.name) ? 'postgres' : /mysql/i.test(file.name) ? 'mysql' : null;
            for (let p = resumeFrom; p <= 100; p += 8) {
                onProgress({ stage: 0, percent: p, note: p >= 48 && p < 64 && /slow/i.test(file.name) ? '网络不稳定，正在重试 2/3' : '' });
                await wait(120);
                if (/fail/i.test(file.name) && p >= 40 && !resumeFrom) throw fail('上传在 40% 中断', 'upload-interrupted', { percent: 40 });
            }
            onProgress({ stage: 1 });
            await wait(900);
            onProgress({ stage: 2 });
            await wait(700);
            if (engine && !tempDb) throw fail('这个备份来自另一种数据库，需要一个临时数据库连接', 'needs-temp-db', { kind: engine, source: engine === 'postgres' ? 'PostgreSQL' : 'MySQL', target: 'SQLite' });
            onProgress({ stage: 3 });
            await wait(2200);
            return {
                restored: 1284, skipped: engine ? 3 : 0, rejected: 0, crossEngine: engine ? `${engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} → SQLite` : '',
                samples: engine ? ['extensions/third-party/old-plugin/index.js（不在所选内容里）', 'user/cache/thumbs/a.png（缓存文件不恢复）', 'user/cache/thumbs/b.png（缓存文件不恢复）'] : [],
            };
        },
        async createMigrationLink() {
            await wait(800);
            const token = Math.random().toString(36).slice(2, 14);
            return { addresses: ['http://127.0.0.1:8000', 'http://192.168.1.20:8000'], link: addr => `${addr}/api/backup/lan/pull?token=${token}`, expiresAt: Date.now() + 10 * MIN };
        },
        async migrateFromLink({ link }, onProgress) {
            if (!/^https?:\/\/.+token=/.test(link.trim())) throw fail('这不是有效的迁移链接', 'BAD_LINK');
            for (let p = 0; p <= 100; p += 6) {
                onProgress({ stage: 0, percent: p });
                await wait(130);
            }
            for (const stage of [1, 2]) {
                onProgress({ stage });
                await wait(1200);
            }
            return { restored: 2210, skipped: 0, rejected: 0, crossEngine: '', samples: [] };
        },
    };
}
