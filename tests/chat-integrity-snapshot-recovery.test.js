import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import lodash from 'lodash';

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const groupChatsSource = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');

function between(source, start, end) {
    const startAt = source.indexOf(start);
    if (startAt < 0) throw new Error(`Missing start boundary: ${start}`);
    const endAt = source.indexOf(end, startAt + start.length);
    if (endAt < 0) throw new Error(`Missing end boundary: ${end}`);
    return source.slice(startAt, endAt);
}

function stripExport(code) {
    return code.replace(/^export\s+/gm, '');
}

const scriptRuntimeSlices = [
    between(scriptSource, 'export function resolveChatStateTarget(', '\nconst chatStateRequestCache = new Map();'),
    between(scriptSource, 'function getChatStateTargetKey(', '\nfunction getChatStateRequestKey('),
    between(scriptSource, 'function isPlainObject(', '\nexport { cloneAsJsonWire'),
    between(scriptSource, 'function getChatMetadataSnapshotKey(', '\nlet objectPatchWorker = null;'),
    between(scriptSource, 'function normalizeChatMetadataForPatch(', '\n/**\n * Builds lightweight mutation metadata'),
    between(scriptSource, 'export function invalidateChatWriteSnapshot(', '\n/**\n * Processes the avatar image'),
    'let chatTransitionInProgress = false;',
    between(scriptSource, 'function endChatTransition()', '\nasync function getChatResult()'),
].map(stripExport).join('\n\n');

const groupRuntimeSlices = [
    between(groupChatsSource, 'export async function loadGroupChat(', '\n/**\n * Validates a group'),
    between(groupChatsSource, 'export async function getGroupChat(', '\n    if (group && Array.isArray(group.members) && freshChat) {')
        + '\n    return { metadata, freshChat, data };\n}',
    between(groupChatsSource, 'async function saveGroupChatInternal(', '\n/**\n * Renames a group member'),
].map(stripExport).join('\n\n');

function cloneAsJsonWire(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function makeResponse({ status = 200, statusText = '', json = undefined, jsonError = null } = {}) {
    const ok = status >= 200 && status < 300;
    return {
        ok,
        status,
        statusText: statusText || (ok ? 'OK' : 'Error'),
        async json() {
            if (jsonError) {
                throw jsonError;
            }
            return cloneAsJsonWire(json);
        },
        clone() {
            return makeResponse({ status, statusText, json, jsonError });
        },
    };
}

function createHost({
    fetchImpl,
    selectedGroup = null,
    chat = [{ name: 'Alice', is_user: false, mes: 'hello' }],
    chatMetadata = { integrity: 'tok-1' },
    characters = [{ name: 'Alice', avatar: 'Alice.png', chat: 'chat-1' }],
    groups = [{ id: 'grp-1', chat_id: 'gchat-1', members: ['Alice.png'], chats: ['gchat-1'] }],
} = {}) {
    const requests = [];
    const toasts = { error: [], warning: [], info: [] };
    const events = [];
    let uuidSeq = 0;

    const context = vm.createContext({
        Map,
        Set,
        Array,
        Object,
        Number,
        String,
        Boolean,
        Error,
        SyntaxError,
        TypeError,
        Date,
        Promise,
        JSON,
        structuredClone,
        lodash,
        console: {
            log() {},
            debug() {},
            warn() {},
            error() {},
        },
        t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (i < values.length ? values[i] : ''), ''),
        toastr: {
            error: (msg, title) => toasts.error.push({ msg: String(msg), title: String(title || '') }),
            warning: (msg, title) => toasts.warning.push({ msg: String(msg), title: String(title || '') }),
            info: (msg, title) => toasts.info.push({ msg: String(msg), title: String(title || '') }),
        },
        event_types: {
            CHAT_WRITE_CONFLICT: 'chat_write_conflict',
            CHAT_LOADED: 'chat_loaded',
        },
        eventSource: {
            emit: (type, payload) => events.push({ type, payload }),
        },
        // 供 public/script.js 与 group-chats.js 共享的模块级状态
        chat: cloneAsJsonWire(chat),
        chat_metadata: cloneAsJsonWire(chatMetadata),
        characters: cloneAsJsonWire(characters),
        this_chid: '0',
        selected_group: selectedGroup,
        groups: cloneAsJsonWire(groups),
        name2: 'Alice',
        neutralCharacterName: 'Assistant',
        isChatSaving: false,
        groupChatLoadSequence: 0,
        debounce_timeout: { short: 0, extended: 100 },
        chatMessageSnapshotCache: new Map(),
        chatMetadataSnapshotCache: new Map(),
        cloneAsJsonWire,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getCharacterName: (ch) => ch?.name || '',
        getCurrentChatId: () => (context.selected_group
            ? (context.groups.find(g => g.id === context.selected_group)?.chat_id || '')
            : (context.characters[context.this_chid]?.chat || '')),
        getLastLukerGenerationIdForApi: () => '',
        summarizeLukerGenerationIdsForMessages: () => [],
        ensureMessageMediaIsArray: () => {},
        uuidv4: () => `minted-${++uuidSeq}`,
        unshallowCharacter: async () => {},
        unshallowGroupMembers: async () => {},
        validateGroup: async () => {},
        loadItemizedPrompts: async () => {},
        maybeApplyCharacterBoundPreset: async () => {},
        getChatResult: async () => {},
        saveTokenCacheDebounced: () => {},
        saveItemizedPromptsDebounced: () => {},
        editGroup: async () => {},
        delay: () => Promise.resolve(),
        $: () => ({ is: () => true, trigger: () => ({ trigger: () => {} }) }),
        document: { activeElement: null },
        updateChatMetadata: (newValues, reset) => {
            context.chat_metadata = reset ? { ...newValues } : { ...context.chat_metadata, ...newValues };
        },
        buildChatMessagePatchOperations: async (previousMessages, nextMessages) => {
            if (lodash.isEqual(previousMessages, nextMessages)) {
                return [];
            }
            const ops = [];
            const maxLen = Math.max(previousMessages.length, nextMessages.length);
            for (let i = 0; i < maxLen; i++) {
                if (!lodash.isEqual(previousMessages[i], nextMessages[i])) {
                    if (i >= previousMessages.length) {
                        ops.push({ op: 'add', path: `/${i}`, value: cloneAsJsonWire(nextMessages[i]) });
                    } else if (i >= nextMessages.length) {
                        ops.push({ op: 'remove', path: `/${i}` });
                    } else {
                        ops.push({ op: 'replace', path: `/${i}`, value: cloneAsJsonWire(nextMessages[i]) });
                    }
                }
            }
            return ops;
        },
        buildObjectPatchOperations: (prev, next) => {
            if (lodash.isEqual(prev, next)) return [];
            const ops = [];
            for (const key of new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])) {
                if (!lodash.isEqual(prev?.[key], next?.[key])) {
                    if (!(key in (next || {}))) {
                        ops.push({ op: 'remove', path: `/${key}` });
                    } else if (!(key in (prev || {}))) {
                        ops.push({ op: 'add', path: `/${key}`, value: cloneAsJsonWire(next[key]) });
                    } else {
                        ops.push({ op: 'replace', path: `/${key}`, value: cloneAsJsonWire(next[key]) });
                    }
                }
            }
            return ops;
        },
        buildObjectPatchOperationsAsync: async (prev, next) => context.buildObjectPatchOperations(prev, next),
        attachChatMessagePatchTests: (_previousMessages, operations) => operations,
        applyJsonPatch: (doc, operations) => {
            const next = cloneAsJsonWire(doc);
            for (const op of operations) {
                const idx = Number(String(op.path || '').slice(1));
                if (op.op === 'replace' && Number.isInteger(idx)) {
                    next[idx] = cloneAsJsonWire(op.value);
                } else if (op.op === 'add' && Number.isInteger(idx)) {
                    next.splice(idx, 0, cloneAsJsonWire(op.value));
                } else if (op.op === 'remove' && Number.isInteger(idx)) {
                    next.splice(idx, 1);
                }
            }
            return { newDocument: next };
        },
        fetch: async (url, init = {}) => {
            const body = init?.body ? JSON.parse(init.body) : null;
            requests.push({ url, body });
            return await fetchImpl(url, body, requests);
        },
    });

    vm.runInContext(`${scriptRuntimeSlices}\n\n${groupRuntimeSlices}`, context);

    const helpers = vm.runInContext(`({
        getPendingForce: (target) => pendingForceOverwriteTargets.get(getChatStateTargetKey(target)),
        getChatMetadata: () => chat_metadata,
        setChatMetadata: (v) => { chat_metadata = v; },
        getChat: () => chat,
        setChat: (v) => { chat = v; },
    })`, context);

    return { context, requests, toasts, events, helpers };
}

describe('聊天快照完整性与 409 冲突恢复防护', () => {
    const soloTarget = { is_group: false, avatar_url: 'Alice.png', file_name: 'chat-1', char_name: 'Alice' };
    const groupTarget = { is_group: true, id: 'gchat-1' };

    test('生产事故回归：单聊 patch 409 后 /api/chats/get 响应流截断时，只拉取 1 次、不删 integrity、不污染缓存且降级全量保存成功', async () => {
        const initialMsg = { name: 'Alice', is_user: false, mes: '楼层 1' };
        const editedMsg = { name: 'Alice', is_user: false, mes: '楼层 1（已编辑）' };
        const host = createHost({
            chat: [editedMsg],
            chatMetadata: { integrity: 'tok-1', note_prompt: 'keep' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    return makeResponse({
                        status: 409,
                        json: { error: 'integrity', current_integrity: 'tok-2' },
                    });
                }
                if (url === '/api/chats/get') {
                    // 模拟响应流中途断开导致 JSON 截断解析失败
                    return makeResponse({
                        status: 200,
                        jsonError: new SyntaxError('Unexpected end of JSON input'),
                    });
                }
                if (url === '/api/chats/save') {
                    return makeResponse({
                        status: 200,
                        json: { ok: true, integrity: 'tok-3' },
                    });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });

        host.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1', note_prompt: 'keep' });
        host.context.seedChatMessageSnapshot(soloTarget, [initialMsg]);

        await host.context.saveChatInternal({});

        // 严格只发 1 次 /api/chats/get，彻底消除连续两次全量拉取
        expect(host.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(host.requests.map(r => r.url)).toEqual([
            '/api/chats/patch',
            '/api/chats/get',
            '/api/chats/save',
        ]);
        const fallbackSave = host.requests.find(r => r.url === '/api/chats/save');
        expect(fallbackSave.body.chat[0].chat_metadata.integrity).toBe('tok-2');
        expect(fallbackSave.body.force).toBe(false);
        // 内存 integrity 绝不被删空，且轮换到最新服务端令牌
        expect(host.helpers.getChatMetadata().integrity).toBe('tok-3');
        // 绝不弹出“拒绝保存：聊天尚未完全加载”
        expect(host.toasts.error.filter(t => t.title.includes('Chat save aborted'))).toEqual([]);
        expect(host.context.getChatMessageSnapshot(soloTarget)).toEqual([editedMsg]);
    });

    test.each([
        ['JSON 截断报错', makeResponse({ status: 200, jsonError: new SyntaxError('Unexpected end of JSON input') })],
        ['HTTP 200 corrupted 标记', makeResponse({ status: 200, json: { corrupted: true } })],
        ['HTTP 200 空数组 []', makeResponse({ status: 200, json: [] })],
        ['HTTP 200 未知对象 { error: true }', makeResponse({ status: 200, json: { error: true } })],
        ['HTTP 200 非法首元素 [null]', makeResponse({ status: 200, json: [null] })],
        ['HTTP 500 服务端报错', makeResponse({ status: 500, json: { corrupted: true } })],
    ])('refreshChatWriteSnapshotsFromServer 遇到 %s 时返回 null，保留原 integrity 与原快照缓存', async (_label, mockResponse) => {
        const originalMsgs = [{ name: 'Alice', is_user: false, mes: '原消息' }];
        const host = createHost({
            chat: originalMsgs,
            chatMetadata: { integrity: 'tok-keep' },
            fetchImpl: async () => mockResponse,
        });
        host.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-keep', foo: 'bar' });
        host.context.seedChatMessageSnapshot(soloTarget, originalMsgs);

        const refreshed = await host.context.refreshChatWriteSnapshotsFromServer(soloTarget);

        expect(refreshed).toBeNull();
        expect(host.helpers.getChatMetadata().integrity).toBe('tok-keep');
        expect(host.context.getChatMessageSnapshot(soloTarget)).toEqual(originalMsgs);
        expect(host.context.getChatMetadataSnapshot(soloTarget)).toEqual({ integrity: 'tok-keep', foo: 'bar' });
    });

    test('refreshChatWriteSnapshotsFromServer 遇到显式未落盘聊天（单聊 new_chat / 群聊 []）或无 integrity 旧聊天时，绝不删除内存 integrity 且不污染为 []', async () => {
        const originalMsgs = [{ name: 'Alice', is_user: false, mes: '本地消息' }];

        // 1) 单聊 { new_chat: true }
        const hostNew = createHost({
            chat: originalMsgs,
            chatMetadata: { integrity: 'tok-local' },
            fetchImpl: async () => makeResponse({ status: 200, json: { new_chat: true } }),
        });
        hostNew.context.seedChatMessageSnapshot(soloTarget, originalMsgs);
        const newSnap = await hostNew.context.refreshChatWriteSnapshotsFromServer(soloTarget);
        expect(newSnap?.existsOnServer).toBe(false);
        expect(hostNew.helpers.getChatMetadata().integrity).toBe('tok-local');
        expect(hostNew.context.getChatMessageSnapshot(soloTarget)).toBeNull();

        // 2) 群聊 []（未落盘新群聊）
        const hostGroupEmpty = createHost({
            selectedGroup: 'grp-1',
            chat: originalMsgs,
            chatMetadata: { integrity: 'gtok-local' },
            fetchImpl: async () => makeResponse({ status: 200, json: [] }),
        });
        hostGroupEmpty.context.seedChatMessageSnapshot(groupTarget, originalMsgs);
        const groupEmptySnap = await hostGroupEmpty.context.refreshChatWriteSnapshotsFromServer(groupTarget);
        expect(groupEmptySnap?.existsOnServer).toBe(false);
        expect(hostGroupEmpty.helpers.getChatMetadata().integrity).toBe('gtok-local');
        expect(hostGroupEmpty.context.getChatMessageSnapshot(groupTarget)).toBeNull();

        // 3) 旧格式无 integrity 的服务端文件：保留内存 integrity，不删除
        const legacyServerMsgs = [{ name: 'Alice', is_user: false, mes: '服务端旧消息' }];
        const hostLegacy = createHost({
            chat: legacyServerMsgs,
            chatMetadata: { integrity: 'tok-local' },
            fetchImpl: async () => makeResponse({
                status: 200,
                json: [{ user_name: 'U', character_name: 'Alice', chat_metadata: {} }, ...legacyServerMsgs],
            }),
        });
        const legacySnap = await hostLegacy.context.refreshChatWriteSnapshotsFromServer(soloTarget);
        expect(legacySnap?.existsOnServer).toBe(true);
        expect(hostLegacy.helpers.getChatMetadata().integrity).toBe('tok-local');
        expect(hostLegacy.context.getChatMessageSnapshot(soloTarget)).toEqual(legacyServerMsgs);
    });

    test('单聊半开失败态（chat_metadata 无 integrity）与队列令牌保护：迟到响应不得重新授权，活动空令牌不得剥离队列已捕获令牌', () => {
        const host = createHost({
            chatMetadata: {},
            fetchImpl: async () => makeResponse({ status: 200, json: { ok: true } }),
        });

        // 迟到的写入回包不得给已清空/加载失败的单聊重新授写权限
        host.context.applyIntegrityFromWritePayloadToTarget({ integrity: 'tok-late' }, soloTarget, null);
        expect(host.helpers.getChatMetadata().integrity).toBeUndefined();

        // 排队写入已捕获的 integrity 不得被 refreshSnapshotIntegrityFromActiveLive 删除
        const queuedMeta = { integrity: 'tok-captured', note: 'queued' };
        host.context.refreshSnapshotIntegrityFromActiveLive(soloTarget, queuedMeta);
        expect(queuedMeta.integrity).toBe('tok-captured');
    });

    test('409 冲突恢复单次快照复用：单聊 patch integrity/snapshot 409、save 409 及非活动分支目标均最多只拉取 1 次 /api/chats/get', async () => {
        const serverMsg = { name: 'Alice', is_user: false, mes: '服务端并发编辑' };
        const localMsg = { name: 'Alice', is_user: false, mes: '前端最新编辑' };

        // 1) patch 409 integrity（快照读取成功 → 只拉 1 次并走增量 patch 重试成功）
        let patchCalls = 0;
        const hostIntegrity = createHost({
            chat: [localMsg],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    patchCalls++;
                    return patchCalls === 1
                        ? makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'tok-2' } })
                        : makeResponse({ status: 200, json: { ok: true, integrity: 'tok-3' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'tok-2' } }, serverMsg],
                    });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostIntegrity.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1' });
        hostIntegrity.context.seedChatMessageSnapshot(soloTarget, [{ name: 'Alice', is_user: false, mes: '初始' }]);
        await hostIntegrity.context.saveChatInternal({});
        expect(hostIntegrity.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(hostIntegrity.requests.map(r => r.url)).toEqual([
            '/api/chats/patch',
            '/api/chats/get',
            '/api/chats/patch',
        ]);
        expect(hostIntegrity.requests[2].body.integrity).toBe('tok-2');
        expect(hostIntegrity.helpers.getChatMetadata().integrity).toBe('tok-3');

        // 2) patch 409 snapshot（只拉 1 次诊断，不重复拉第 2 次，重试带 force:true 全量保存成功）
        const hostSnapshot = createHost({
            chat: [localMsg],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 409, json: { error: 'Chat patch conflict.' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'tok-1' } }, serverMsg],
                    });
                }
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'tok-2' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostSnapshot.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1' });
        hostSnapshot.context.seedChatMessageSnapshot(soloTarget, [{ name: 'Alice', is_user: false, mes: '初始' }]);
        await hostSnapshot.context.saveChatInternal({});
        expect(hostSnapshot.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(hostSnapshot.requests.find(r => r.url === '/api/chats/save').body.force).toBe(true);
        expect(hostSnapshot.helpers.getPendingForce(soloTarget)).toBeUndefined();
        expect(hostSnapshot.helpers.getChatMetadata().integrity).toBe('tok-2');

        // 3) full save 409 integrity（只拉 1 次，重试成功）
        const hostFull = createHost({
            chat: [localMsg],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'tok-2' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'tok-2' } }, serverMsg],
                    });
                }
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'tok-3' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        await hostFull.context.saveChatInternal({});
        expect(hostFull.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(hostFull.requests.find(r => r.url === '/api/chats/patch').body.integrity).toBe('tok-2');
        expect(hostFull.helpers.getChatMetadata().integrity).toBe('tok-3');

        // 4) 非活动分支目标保存 409：只同步分支目标的 integrity，不覆盖当前活动聊天 chat_metadata.integrity
        let branchSaveCalls = 0;
        const hostBranch = createHost({
            chat: [localMsg],
            chatMetadata: { integrity: 'active-tok' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/save') {
                    branchSaveCalls++;
                    return branchSaveCalls === 1
                        ? makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'branch-tok-2' } })
                        : makeResponse({ status: 200, json: { ok: true, integrity: 'branch-tok-3' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'branch-tok-2' } }, serverMsg],
                    });
                }
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'branch-tok-3' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        await hostBranch.context.saveChatInternal({ chatName: 'branch-2' });
        expect(hostBranch.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(hostBranch.requests.find(r => r.url === '/api/chats/patch').body.integrity).toBe('branch-tok-2');
        expect(hostBranch.helpers.getChatMetadata().integrity).toBe('active-tok');
    });

    test('群聊 409 冲突恢复：成功时只拉 1 次 /api/chats/group/get；读取失败时只拉 1 次并复抛中止重试，不覆盖并发数据且清理 force 标记', async () => {
        const msg1 = { name: 'Alice', is_user: false, mes: '群消息 1' };
        const msgServer = { name: 'Alice', is_user: false, mes: '群并发修改' };

        // 成功路径：group/save 409 → 只拉 1 次 /group/get → 重试成功
        let groupSaveCalls = 0;
        const hostOk = createHost({
            selectedGroup: 'grp-1',
            chat: [msg1],
            chatMetadata: { integrity: 'gtok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/group/save') {
                    groupSaveCalls++;
                    return groupSaveCalls === 1
                        ? makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'gtok-2' } })
                        : makeResponse({ status: 200, json: { ok: true, integrity: 'gtok-3' } });
                }
                if (url === '/api/chats/group/patch') {
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'gtok-3' } });
                }
                if (url === '/api/chats/group/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'gtok-2' } }, msgServer],
                    });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        const ok = await hostOk.context.saveGroupChat('grp-1', false);
        expect(ok).toBe(true);
        expect(hostOk.requests.filter(r => r.url === '/api/chats/group/get')).toHaveLength(1);
        expect(hostOk.requests.find(r => r.url === '/api/chats/group/patch').body.integrity).toBe('gtok-2');
        expect(hostOk.helpers.getChatMetadata().integrity).toBe('gtok-3');

        // 失败路径（契约对齐 E2E 138:532）：/group/get 失败 → 只拉 1 次，中止重试不发第 2 次 /group/save，清理快照与 force 标记
        const hostFail = createHost({
            selectedGroup: 'grp-1',
            chat: [msg1],
            chatMetadata: { integrity: 'gtok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/group/save') {
                    return makeResponse({ status: 409, json: { error: 'Chat patch conflict.' } });
                }
                if (url === '/api/chats/group/get') {
                    throw new TypeError('Failed to fetch');
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        const failed = await hostFail.context.saveGroupChat('grp-1', false);
        expect(failed).toBe(false);
        expect(hostFail.requests.filter(r => r.url === '/api/chats/group/get')).toHaveLength(1);
        expect(hostFail.requests.filter(r => r.url === '/api/chats/group/save')).toHaveLength(1);
        expect(hostFail.context.getChatMessageSnapshot(groupTarget)).toBeNull();
        expect(hostFail.helpers.getPendingForce(groupTarget)).toBeUndefined();
        expect(hostFail.toasts.error.some(t => t.title.includes('Group Chat could not be saved'))).toBe(true);
        expect(hostFail.toasts.error.some(t => t.msg.includes('gchat-1'))).toBe(true);
    });

    test('单聊/群聊 saveChatMetadataInternal 409 冲突恢复均只拉 1 次快照，且群聊读取失败时弹含 chatId 错误并回退返回 false', async () => {
        // 单聊 meta/patch 409
        let soloMetaCalls = 0;
        const hostSolo = createHost({
            chatMetadata: { integrity: 'tok-1', note_prompt: 'new' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/meta/patch') {
                    soloMetaCalls++;
                    return soloMetaCalls === 1
                        ? makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'tok-2' } })
                        : makeResponse({ status: 200, json: { ok: true, integrity: 'tok-3' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({
                        status: 200,
                        json: [{ chat_metadata: { integrity: 'tok-2', note_prompt: 'old' } }, { mes: 'hi' }],
                    });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostSolo.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1', note_prompt: 'old' });
        hostSolo.context.seedChatMessageSnapshot(soloTarget, [{ mes: 'hi' }]);
        expect(await hostSolo.context.saveChatMetadataInternal()).toBe(true);
        expect(hostSolo.requests.filter(r => r.url === '/api/chats/get')).toHaveLength(1);
        expect(hostSolo.requests.filter(r => r.url === '/api/chats/meta/patch')[1].body.integrity).toBe('tok-2');
        expect(hostSolo.helpers.getChatMetadata().integrity).toBe('tok-3');

        // 群聊 group/meta/patch 409 且 /group/get 失败：只拉 1 次，弹含 chatId toast 并返回 false 给上层回退完整保存
        const hostGroupFail = createHost({
            selectedGroup: 'grp-1',
            chatMetadata: { integrity: 'gtok-1', note_prompt: 'new' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/group/meta/patch') {
                    return makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'gtok-2' } });
                }
                if (url === '/api/chats/group/get') {
                    return makeResponse({ status: 500, json: { corrupted: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostGroupFail.context.seedChatMetadataSnapshot(groupTarget, { integrity: 'gtok-1', note_prompt: 'old' });
        hostGroupFail.context.seedChatMessageSnapshot(groupTarget, [{ mes: 'hi' }]);
        const metaResult = await hostGroupFail.context.saveChatMetadataInternal(undefined, 0, {
            kind: 'group',
            target: groupTarget,
            groupId: 'grp-1',
            metadataSnapshot: { integrity: 'gtok-1', note_prompt: 'new' },
            messagesSnapshot: [{ mes: 'hi' }],
        });
        expect(metaResult).toBe(false);
        expect(hostGroupFail.requests.filter(r => r.url === '/api/chats/group/get')).toHaveLength(1);
        expect(hostGroupFail.toasts.error.some(t => t.msg.includes('gchat-1'))).toBe(true);
        expect(hostGroupFail.helpers.getChatMetadata().integrity).toBe('gtok-2');
    });

    test('appendChatMessagesInternal（单聊与群聊）：200 响应截断不误触发全量拉取；真实去重但刷新失败清空幽灵乐观快照', async () => {
        const msg0 = { name: 'Alice', is_user: false, mes: '旧消息' };
        const msg1 = { name: 'User', is_user: true, mes: '新消息' };

        // 1) 单聊 200 OK 响应体截断：不触发 /api/chats/get，清空乐观快照，保留 integrity，返回 false
        const hostTrunc = createHost({
            chat: [msg0, msg1],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/append') {
                    return makeResponse({ status: 200, jsonError: new SyntaxError('Unexpected end of JSON input') });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostTrunc.context.seedChatMessageSnapshot(soloTarget, [msg0]);
        expect(await hostTrunc.context.appendChatMessagesInternal([msg1])).toBe(false);
        expect(hostTrunc.requests.map(r => r.url)).toEqual(['/api/chats/append']);
        expect(hostTrunc.context.getChatMessageSnapshot(soloTarget)).toBeNull();
        expect(hostTrunc.helpers.getChatMetadata().integrity).toBe('tok-1');

        // 2) 群聊 200 OK 响应体截断：不触发 /api/chats/group/get、不弹 loadGroupChat 错误 toast、清空乐观快照
        const hostGroupTrunc = createHost({
            selectedGroup: 'grp-1',
            chat: [msg0, msg1],
            chatMetadata: { integrity: 'gtok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/group/append') {
                    return makeResponse({ status: 200, jsonError: new SyntaxError('Unexpected end of JSON input') });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostGroupTrunc.context.seedChatMessageSnapshot(groupTarget, [msg0]);
        expect(await hostGroupTrunc.context.appendChatMessagesInternal([msg1], 0, {
            kind: 'group',
            target: groupTarget,
            groupId: 'grp-1',
            metadataSnapshot: { integrity: 'gtok-1' },
            messagesSnapshot: [msg0, msg1],
        })).toBe(false);
        expect(hostGroupTrunc.requests.map(r => r.url)).toEqual(['/api/chats/group/append']);
        expect(hostGroupTrunc.toasts.error).toEqual([]);
        expect(hostGroupTrunc.context.getChatMessageSnapshot(groupTarget)).toBeNull();
        expect(hostGroupTrunc.helpers.getChatMetadata().integrity).toBe('gtok-1');

        // 3) 单聊真实 dedup（appended: 0）但随后的 /api/chats/get 截断失败：必须清空幽灵快照，绝不残留 [msg0, msg1]
        const hostDedupFail = createHost({
            chat: [msg0, msg1],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/append') {
                    return makeResponse({ status: 200, json: { ok: true, appended: 0, skipped: 1, integrity: 'tok-1' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({ status: 200, jsonError: new SyntaxError('truncated') });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostDedupFail.context.seedChatMessageSnapshot(soloTarget, [msg0]);
        expect(await hostDedupFail.context.appendChatMessagesInternal([msg1])).toBe(false);
        expect(hostDedupFail.context.getChatMessageSnapshot(soloTarget)).toBeNull();
        expect(hostDedupFail.helpers.getChatMetadata().integrity).toBe('tok-1');
    });

    test('patchChatMessagesInternal 与 saveChatInternal：200 响应体截断或缺少 integrity 时失效快照且不删除内存 integrity', async () => {
        const msg0 = { name: 'Alice', is_user: false, mes: '原始' };
        const msgEdited = { name: 'Alice', is_user: false, mes: '已改' };

        const hostPatch = createHost({
            chat: [msgEdited],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 200, jsonError: new SyntaxError('truncated') });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostPatch.context.seedChatMessageSnapshot(soloTarget, [msg0]);
        expect(await hostPatch.context.patchChatMessagesInternal([{ op: 'replace', path: '/0', value: msgEdited }])).toBe(false);
        expect(hostPatch.context.getChatMessageSnapshot(soloTarget)).toBeNull();
        expect(hostPatch.helpers.getChatMetadata().integrity).toBe('tok-1');

        const hostSave = createHost({
            chat: [msgEdited],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 200, json: { ok: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        await hostSave.context.saveChatInternal({});
        expect(hostSave.context.getChatMessageSnapshot(soloTarget)).toBeNull();
        expect(hostSave.helpers.getChatMetadata().integrity).toBe('tok-1');
        expect(hostSave.toasts.error.some(t => t.title.includes('Chat could not be saved'))).toBe(true);
    });

    test('边缘回归：群聊元数据 snapshot 409 读失败回退 saveGroupChat 不带 force、loadGroupChat 拒非对象首元素、saveChatInternal 早退清 force', async () => {
        const msg0 = { name: 'Alice', is_user: false, mes: '群聊首条' };

        // 1) 群聊 saveChatMetadataForContext 遇 snapshot 409 且 /api/chats/group/get 失败：
        //    saveChatMetadataInternal 必须清掉 pendingForceOverwriteTargets，回退到 saveGroupChat 时不得带 force:true
        const groupSaveBodies = [];
        const hostGroupMeta409 = createHost({
            selectedGroup: 'grp-1',
            chat: [msg0],
            chatMetadata: { integrity: 'gtok-1', note: 'changed' },
            fetchImpl: async (url, body) => {
                if (url === '/api/chats/group/meta/patch') {
                    return makeResponse({ status: 409, json: { error: 'snapshot' } });
                }
                if (url === '/api/chats/group/get') {
                    return makeResponse({ status: 500, json: { error: 'disk error' } });
                }
                if (url === '/api/chats/group/save') {
                    groupSaveBodies.push(body);
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'gtok-2' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostGroupMeta409.context.seedChatMessageSnapshot(groupTarget, [msg0]);
        hostGroupMeta409.context.seedChatMetadataSnapshot(groupTarget, { integrity: 'gtok-1', note: 'old' });
        const metaSaved = await hostGroupMeta409.context.saveChatMetadata({ note: 'changed' });
        expect(metaSaved).toBe(true);
        expect(groupSaveBodies).toHaveLength(1);
        expect(groupSaveBodies[0].force).toBe(false);
        expect(hostGroupMeta409.helpers.getPendingForce(groupTarget)).toBeUndefined();

        // 2) loadGroupChat() 收到非空数组首元素非普通对象（[null] / ['bad'] / [[]]）必须抛错
        for (const badPayload of [[null], ['bad'], [[]]]) {
            const hostBadGroup = createHost({
                selectedGroup: 'grp-1',
                fetchImpl: async () => makeResponse({ status: 200, json: badPayload }),
            });
            await expect(hostBadGroup.context.loadGroupChat('group-chat-1')).rejects.toThrow('Expected a chat message array');
            expect(hostBadGroup.toasts.error.some(t => t.title.includes('Chat load failed'))).toBe(true);
        }

        // 3) saveChatInternal 早退（如 fileName 为空或缺少角色身份）时清理残留 pendingForceOverwriteTargets
        const hostEarlyExit = createHost({
            chat: [msg0],
            chatMetadata: { integrity: 'tok-1' },
            characters: [{ name: '', avatar: '', chat: '' }],
            fetchImpl: async () => {
                throw new Error('Should not fetch on early exit');
            },
        });
        hostEarlyExit.context.markTargetForForceOverwriteOnNextSave(soloTarget, 'stale-409');
        expect(hostEarlyExit.helpers.getPendingForce(soloTarget)).toBe('stale-409');
        await hostEarlyExit.context.saveChatInternal({
            _context: { target: soloTarget, fileName: '', charName: '', avatarUrl: '', metadataSnapshot: { integrity: 'tok-1' } },
        });
        expect(hostEarlyExit.helpers.getPendingForce(soloTarget)).toBeUndefined();
    });

    test('getChat() 拒绝非预期 200 payload 避免覆盖服务端数据，且正常加载单聊/群聊时清理残留 pendingForceOverwriteTargets', async () => {
        // 1) 非预期对象 { error: true } 不能当新聊天铸造 integrity
        const hostBad = createHost({
            chat: [],
            chatMetadata: {},
            fetchImpl: async () => makeResponse({ status: 200, json: { error: true } }),
        });
        await hostBad.context.getChat();
        expect(hostBad.helpers.getChatMetadata().integrity).toBeUndefined();
        expect(hostBad.toasts.error.some(t => t.title.includes('Chat load failed'))).toBe(true);

        // 2) 首元素非对象 [null] 不能当合法聊天
        const hostBadHead = createHost({
            chat: [],
            chatMetadata: {},
            fetchImpl: async () => makeResponse({ status: 200, json: [null] }),
        });
        await hostBadHead.context.getChat();
        expect(hostBadHead.helpers.getChatMetadata().integrity).toBeUndefined();
        expect(hostBadHead.toasts.error.some(t => t.title.includes('Chat load failed'))).toBe(true);

        // 3) 正常加载单聊后，残留的 pendingForceOverwriteTargets 必须被清理
        const hostGood = createHost({
            chat: [],
            chatMetadata: {},
            fetchImpl: async () => makeResponse({
                status: 200,
                json: [{ chat_metadata: { integrity: 'tok-fresh' } }, { name: 'Alice', mes: 'ok' }],
            }),
        });
        hostGood.context.markTargetForForceOverwriteOnNextSave(soloTarget, 'stale-409');
        expect(hostGood.helpers.getPendingForce(soloTarget)).toBe('stale-409');
        await hostGood.context.getChat();
        expect(hostGood.helpers.getChatMetadata().integrity).toBe('tok-fresh');
        expect(hostGood.helpers.getPendingForce(soloTarget)).toBeUndefined();

        // 4) 正常加载群聊后，残留的 pendingForceOverwriteTargets 也必须被清理
        const hostGroupGood = createHost({
            selectedGroup: 'grp-1',
            chat: [],
            chatMetadata: {},
            fetchImpl: async () => makeResponse({
                status: 200,
                json: [{ chat_metadata: { integrity: 'gtok-fresh' } }, { name: 'Alice', mes: 'hi group' }],
            }),
        });
        hostGroupGood.context.markTargetForForceOverwriteOnNextSave(groupTarget, 'stale-group-409');
        expect(hostGroupGood.helpers.getPendingForce(groupTarget)).toBe('stale-group-409');
        await hostGroupGood.context.getGroupChat('grp-1');
        expect(hostGroupGood.helpers.getChatMetadata().integrity).toBe('gtok-fresh');
        expect(hostGroupGood.helpers.getPendingForce(groupTarget)).toBeUndefined();
    });

    test('单聊 409 冲突恢复遇到 corrupted 或 snapshot 读失败时绝不 force 覆盖，并清理 pendingForceOverwriteTargets', async () => {
        const initialMsg = { name: 'Alice', is_user: false, mes: '原消息' };
        const editedMsg = { name: 'Alice', is_user: false, mes: '已编辑消息' };

        // 1) 单聊 patch snapshot 409 + /api/chats/get 返回 { corrupted: true }：中止重试、绝不发 /api/chats/save、不残留 force
        const hostCorrupted = createHost({
            chat: [editedMsg],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 409, json: { error: 'Chat patch conflict.' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({ status: 200, json: { corrupted: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostCorrupted.context.seedChatMessageSnapshot(soloTarget, [initialMsg]);
        await hostCorrupted.context.saveChatInternal({});
        expect(hostCorrupted.requests.map(r => r.url)).toEqual(['/api/chats/patch', '/api/chats/get']);
        expect(hostCorrupted.helpers.getPendingForce(soloTarget)).toBeUndefined();
        expect(hostCorrupted.helpers.getChatMetadata().integrity).toBe('tok-1');
        expect(hostCorrupted.toasts.error.some(t => t.msg.includes('Chat data is corrupted'))).toBe(true);

        // 2) 单聊 save integrity 409（空 current_integrity）+ /api/chats/get 截断：绝不盲目 force:true 强写
        const hostEmptyCurrent = createHost({
            chat: [editedMsg],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 409, json: { error: 'integrity', current_integrity: '' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({ status: 200, jsonError: new SyntaxError('Unexpected end of JSON input') });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        await hostEmptyCurrent.context.saveChatInternal({});
        expect(hostEmptyCurrent.requests.map(r => r.url)).toEqual(['/api/chats/save', '/api/chats/get']);
        expect(hostEmptyCurrent.helpers.getPendingForce(soloTarget)).toBeUndefined();
        expect(hostEmptyCurrent.helpers.getChatMetadata().integrity).toBe('tok-1');
        expect(hostEmptyCurrent.toasts.error.some(t => t.msg.includes('Check the server connection'))).toBe(true);

        // 3) 单聊 meta/patch snapshot 409 + /api/chats/get 500：清理 force 并返回 false，绝不携带 force:true 重试
        const hostSoloMetaFail = createHost({
            chat: [initialMsg],
            chatMetadata: { integrity: 'tok-1', note: 'v2' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/meta/patch') {
                    return makeResponse({ status: 409, json: { error: 'Chat metadata patch conflict.' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({ status: 500, json: { corrupted: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostSoloMetaFail.context.seedChatMessageSnapshot(soloTarget, [initialMsg]);
        hostSoloMetaFail.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1', note: 'v1' });
        expect(await hostSoloMetaFail.context.saveChatMetadataInternal()).toBe(false);
        expect(hostSoloMetaFail.requests.map(r => r.url)).toEqual(['/api/chats/meta/patch', '/api/chats/get']);
        expect(hostSoloMetaFail.helpers.getPendingForce(soloTarget)).toBeUndefined();
    });

    test('saveChatMetadataInternal 在 409 后发现服务端尚未建档（existsOnServer=false）时返回 false 回退全量保存，不递归建空聊天', async () => {
        const msg0 = { name: 'Alice', is_user: false, mes: '本地消息' };

        // 1) 单聊：meta/patch 409 → /api/chats/get 返回 { new_chat: true } → 不二次发 meta/patch，返回 false
        const hostSoloNew = createHost({
            chat: [msg0],
            chatMetadata: { integrity: 'tok-1', note: 'v2' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/meta/patch') {
                    return makeResponse({ status: 409, json: { error: 'integrity', current_integrity: 'tok-2' } });
                }
                if (url === '/api/chats/get') {
                    return makeResponse({ status: 200, json: { new_chat: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostSoloNew.context.seedChatMessageSnapshot(soloTarget, [msg0]);
        hostSoloNew.context.seedChatMetadataSnapshot(soloTarget, { integrity: 'tok-1', note: 'v1' });
        expect(await hostSoloNew.context.saveChatMetadataInternal()).toBe(false);
        expect(hostSoloNew.requests.map(r => r.url)).toEqual(['/api/chats/meta/patch', '/api/chats/get']);
        expect(hostSoloNew.helpers.getPendingForce(soloTarget)).toBeUndefined();

        // 2) 群聊：group/meta/patch 409 → /api/chats/group/get 返回 [] → 不二次发 group/meta/patch，回退全量 saveGroupChat
        const groupSaveBodies = [];
        const hostGroupNew = createHost({
            selectedGroup: 'grp-1',
            chat: [msg0],
            chatMetadata: { integrity: 'gtok-1', note: 'v2' },
            fetchImpl: async (url, body) => {
                if (url === '/api/chats/group/meta/patch') {
                    return makeResponse({ status: 409, json: { error: 'snapshot' } });
                }
                if (url === '/api/chats/group/get') {
                    return makeResponse({ status: 200, json: [] });
                }
                if (url === '/api/chats/group/save') {
                    groupSaveBodies.push(body);
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'gtok-2' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostGroupNew.context.seedChatMessageSnapshot(groupTarget, [msg0]);
        hostGroupNew.context.seedChatMetadataSnapshot(groupTarget, { integrity: 'gtok-1', note: 'v1' });
        expect(await hostGroupNew.context.saveChatMetadata({ note: 'v2' })).toBe(true);
        expect(hostGroupNew.requests.map(r => r.url)).toEqual([
            '/api/chats/group/meta/patch',
            '/api/chats/group/get',
            '/api/chats/group/save',
        ]);
        expect(groupSaveBodies).toHaveLength(1);
        expect(groupSaveBodies[0].force).toBe(false);
        expect(groupSaveBodies[0].chat.slice(1)).toEqual([msg0]);
    });

    test('saveChatInternal patch 200 缺 integrity 降级全量保存、save 200 异常不暴露未翻译内部文案、各早退路径精准清理 force 标记', async () => {
        const msg0 = { name: 'Alice', is_user: false, mes: '原消息' };
        const msgEdited = { name: 'Alice', is_user: false, mes: '已改' };

        // 1) /api/chats/patch 返回 200 但 integrity 为空（例如无 integrity 旧聊天的 no-op patch）→ 降级 /api/chats/save 成功
        const hostPatchFallback = createHost({
            chat: [msgEdited],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/patch') {
                    return makeResponse({ status: 200, json: { ok: true, applied: 0, total_messages: 0, integrity: '' } });
                }
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 200, json: { ok: true, integrity: 'tok-2' } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        hostPatchFallback.context.seedChatMessageSnapshot(soloTarget, [msg0]);
        await hostPatchFallback.context.saveChatInternal({});
        expect(hostPatchFallback.requests.map(r => r.url)).toEqual(['/api/chats/patch', '/api/chats/save']);
        expect(hostPatchFallback.helpers.getChatMetadata().integrity).toBe('tok-2');
        expect(hostPatchFallback.toasts.error).toEqual([]);

        // 2) /api/chats/save 返回 200 缺 integrity → 使用本地化通用提示，不把英文内部异常文案直接弹给用户
        const hostSaveAck = createHost({
            chat: [msgEdited],
            chatMetadata: { integrity: 'tok-1' },
            fetchImpl: async (url) => {
                if (url === '/api/chats/save') {
                    return makeResponse({ status: 200, json: { ok: true } });
                }
                throw new Error(`Unexpected url: ${url}`);
            },
        });
        await hostSaveAck.context.saveChatInternal({});
        expect(hostSaveAck.toasts.error.some(t => t.msg.includes('Check the server connection'))).toBe(true);
        expect(hostSaveAck.toasts.error.some(t => t.msg.includes('Invalid chat write acknowledgement'))).toBe(false);

        // 3) saveChatInternal({ chatName: 'branch-2' }) 在无 integrity 早退时只清 branch-2，不误清当前活动聊天 chat-1
        const branchTarget = { ...soloTarget, file_name: 'branch-2' };
        const hostBranchGuard = createHost({
            chat: [msg0],
            chatMetadata: {},
            fetchImpl: async () => {
                throw new Error('Should not fetch when integrity is missing');
            },
        });
        hostBranchGuard.context.markTargetForForceOverwriteOnNextSave(soloTarget, 'active-force');
        hostBranchGuard.context.markTargetForForceOverwriteOnNextSave(branchTarget, 'branch-force');
        await hostBranchGuard.context.saveChatInternal({ chatName: 'branch-2' });
        expect(hostBranchGuard.helpers.getPendingForce(branchTarget)).toBeUndefined();
        expect(hostBranchGuard.helpers.getPendingForce(soloTarget)).toBe('active-force');

        // 4) saveGroupChatInternal 在无 integrity 早退时同样清理 pendingForceOverwriteTargets
        const hostGroupGuard = createHost({
            selectedGroup: 'grp-1',
            chat: [msg0],
            chatMetadata: {},
            fetchImpl: async () => {
                throw new Error('Should not fetch when group integrity is missing');
            },
        });
        hostGroupGuard.context.markTargetForForceOverwriteOnNextSave(groupTarget, 'stale-group-force');
        expect(await hostGroupGuard.context.saveGroupChat('grp-1', false)).toBe(false);
        expect(hostGroupGuard.helpers.getPendingForce(groupTarget)).toBeUndefined();
    });
});
