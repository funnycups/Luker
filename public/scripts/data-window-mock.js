// Preview-only data source for the Data window. Mirrors the shape of the real provider.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN = 60 * 1000;

export const SYNC_CATEGORY_GROUPS = [
    ['角色与聊天', [['characters', '角色卡'], ['chats', '聊天与群组'], ['worlds', '世界书'], ['cardapps', '卡片应用'], ['skills', '技能']]],
    ['预设', [['openai', 'OpenAI'], ['novel', 'NovelAI'], ['kobold', 'KoboldAI'], ['textgen', '文本补全'], ['instruct', '指令模板'], ['context', '上下文模板'], ['sysprompt', '系统提示词'], ['reasoning', '推理模板']]],
    ['外观', [['themes', '主题'], ['movingui', '移动 UI'], ['quickreplies', '快速回复'], ['backgrounds', '背景'], ['avatars', '用户头像']]],
    ['文件', [['assets', '素材'], ['files', '上传文件'], ['comfy', 'ComfyUI 工作流'], ['images', '用户图片'], ['imagemeta', '图片元数据'], ['vectors', '向量缓存'], ['stats', '角色统计']]],
    ['系统', [['settings', '设置'], ['extensions', '扩展插件', true], ['secrets', 'API 密钥', true]]],
];

export const BACKUP_CATEGORIES = [
    { id: 'settings', label: '设置', def: true },
    { id: 'secrets', label: 'API 密钥', def: false, sensitive: true },
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

export function createMockProvider() {
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());
    const now = Date.now();

    const state = {
        isAdmin: true,
        device: { label: 'Desk', placeholder: 'xzhou-macbook' },
        schedule: { idle: 60, poll: 300 },
        backends: [
            { id: 'b1', kind: 's3', label: '共享归档', state: 'running', lastSync: now - 3 * MIN, startedAt: now - 12000, categories: allSync(), canUndo: true },
            { id: 'b2', kind: 'lan', label: '平板', state: 'ok', lastSync: now - 20000, categories: allSync(), canUndo: true, hasStoredCredentials: true },
            { id: 'b3', kind: 'lan', label: 'VPS', state: 'attention', lastSync: now - 62 * MIN, categories: allSync(), canUndo: true, stalled: ['chats/都市神壕之我爱装逼/2026-11-01.jsonl', 'worlds/星途重启.json'] },
            { id: 'b4', kind: 'lan', label: '办公室台式机', state: 'error', lastSync: now - 2 * 24 * 60 * MIN, categories: allSync(), canUndo: false, error: '连不上对方设备' },
        ],
        conflicts: [
            {
                key: 'c1', path: 'worlds/Cascade Lore.json', kind: '世界书', stale: false,
                versions: [
                    { id: 'theirs', from: '平板', inUse: true, preview: 'Stay beside the river until you hear the moonwell beneath the reeds.' },
                    { id: 'ours', from: 'Desk', preview: 'Follow the birches north; the moonwell lies beyond the standing stones.' },
                    { id: 'current', current: true, preview: 'Stay beside the river until you hear the moonwell beneath the reeds.' },
                ],
            },
            {
                key: 'c2', path: 'settings.json', kind: '设置', stale: true,
                versions: [
                    { id: 'theirs', from: 'VPS', preview: '{ "main_api": "openai", "amount_gen": 2048, … }' },
                    { id: 'ours', from: 'Desk', inUse: false, preview: '{ "main_api": "openai", "amount_gen": 4096, … }' },
                    { id: 'current', current: true, preview: '{ "main_api": "openai", "amount_gen": 8192, … }' },
                ],
            },
        ],
        notices: [
            { id: 'n1', type: 'fork', title: '「Seraphina」的聊天出现了分支', detail: '平板和本机同时改了同一段聊天，平板的版本另存为分支', action: '打开分支' },
            { id: 'n2', type: 'restored', title: '恢复了群聊「月井旅团」', detail: 'VPS 删除了它，但本机还在编辑', action: '打开聊天' },
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
                Object.assign(b, { state: 'error', error: '连不上对方设备' });
                emit();
                throw new Error('连不上对方设备（http://192.168.1.88:8000）');
            }
            Object.assign(b, { state: b.stalled?.length ? 'attention' : 'ok', lastSync: Date.now(), canUndo: true });
            emit();
            return { label: b.label };
        },
        async undo(id) {
            await wait(900);
            find(id).canUndo = false;
            emit();
            return { kept: id === 'b3' ? ['worlds/星途重启.json'] : [] };
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
            state.device.label = label;
            emit();
        },
        async saveSchedule(idle, poll) {
            await wait(400);
            state.schedule = { idle, poll };
            emit();
        },
        async createPairLink({ label }) {
            await wait(700);
            const code = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
            const addresses = ['http://192.168.1.20:8000', 'http://10.0.0.5:8000', 'http://127.0.0.1:8000'];
            return { addresses, link: addr => `${addr}/sync/pair#peer=a8f3c2&code=${code}&label=${encodeURIComponent(label)}` };
        },
        parsePairLink(link) {
            const m = /^(https?:\/\/[^/]+)\/sync\/pair#peer=([^&]+)&code=[^&]+&label=([^&]*)/.exec(link.trim());
            return m ? { url: m[1], peerId: m[2], label: decodeURIComponent(m[3]) } : null;
        },
        async acceptPair({ label, categories }) {
            await wait(1600);
            const b = { id: 'b' + Date.now(), kind: 'lan', label: label || '新设备', state: 'ok', lastSync: Date.now(), categories, canUndo: true };
            state.backends.push(b);
            emit();
            return b;
        },
        async saveS3(form, id) {
            await wait(1400);
            if (!form.endpoint || !form.bucket) throw new Error('请填写 Endpoint 和桶');
            if (/fail/i.test(form.accessKey)) throw new Error('连接失败：403 SignatureDoesNotMatch，请检查密钥');
            if (id) {
                Object.assign(find(id), { label: form.label, categories: form.categories });
            } else {
                state.backends.push({ id: 'b' + Date.now(), kind: 's3', label: form.label || 'S3', state: 'ok', lastSync: Date.now(), categories: form.categories, canUndo: false, s3: { ...form, secretKey: '', accessKey: '', passphrase: '' } });
            }
            emit();
        },
        getS3(id) {
            return find(id).s3 || { endpoint: 'https://cos.ap-hongkong.myqcloud.com', region: 'ap-hongkong', bucket: 'luker-sync-1250000000', prefix: 'desk/', pathStyle: false };
        },
        async unlockS3(id, passphrase) {
            await wait(900);
            if (!passphrase) throw new Error('请输入加密口令');
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
            state.conflicts = state.conflicts.filter(c => !choices[c.key]);
            emit();
        },
        async dismissNotice(id) {
            await wait(300);
            state.notices = state.notices.filter(n => n.id !== id);
            emit();
        },
        async openNotice(id) {
            await wait(300);
            state.notices = state.notices.filter(n => n.id !== id);
            emit();
        },
        async downloadBackup(categories, onProgress) {
            onProgress({ stage: 'pack' });
            await wait(1800);
            onProgress({ stage: 'download', percent: 0 });
            for (let p = 10; p <= 100; p += 15) {
                await wait(220);
                onProgress({ stage: 'download', percent: Math.min(p, 100) });
            }
            return { fileName: `luker-backup-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`, size: 48.3 * 1024 * 1024 };
        },
        async restoreBackup({ file, tempDb }, onProgress) {
            const needsDb = /mysql|postgres|pg/i.test(file.name);
            if (needsDb && !tempDb) {
                const err = new Error('这个备份来自另一种数据库，需要一个临时数据库连接');
                err.code = 'needs-temp-db';
                throw err;
            }
            for (let p = 0; p <= 100; p += 8) {
                onProgress({ stage: 0, percent: p });
                await wait(120);
            }
            for (const stage of [1, 2, 3]) {
                onProgress({ stage });
                await wait(stage === 3 ? 2200 : 900);
            }
            return { warnings: [] };
        },
        async createMigrationLink() {
            await wait(800);
            return { link: 'http://192.168.1.20:8000/api/backup/lan/pull?token=Q7mK2xV9pL4s', expiresAt: Date.now() + 10 * MIN, loopback: false };
        },
        async migrateFromLink({ link }, onProgress) {
            if (!/^https?:\/\//.test(link.trim())) throw new Error('这不是有效的迁移链接');
            for (let p = 0; p <= 100; p += 6) {
                onProgress({ stage: 0, percent: p });
                await wait(130);
            }
            for (const stage of [1, 2]) {
                onProgress({ stage });
                await wait(1200);
            }
            return { warnings: [] };
        },
    };
}
