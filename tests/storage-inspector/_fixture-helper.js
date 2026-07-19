import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

/**
 * 造一个 tmpdir · 模拟 data/<handle>/ 的用户目录结构。
 * 返回 { userRoot, cleanup } · cleanup 递归删。
 *
 * 每个 opts 布尔控制是否写入该类别的最小样本文件。类别之间独立,
 * 未启用则该子树完全缺失(测试 walker 对缺失目录的容错)。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.chats]        — 造 chats/<char>/*.jsonl + sidecar
 * @param {boolean} [opts.characters]   — 造 characters/*.png + sprites/ + state sidecar
 * @param {boolean} [opts.worlds]       — 造 worlds/*.json
 * @param {boolean} [opts.images]       — 造 backgrounds + user/images + User Avatars
 * @param {boolean} [opts.attachments]  — 造 user/files + user/workflows
 * @param {boolean} [opts.presets]      — 造 OpenAI Settings + settings.json + backup
 * @param {boolean} [opts.extensions]   — 造 extensions/foo/*
 * @param {boolean} [opts.vectors]      — 造 vectors/*
 * @param {boolean} [opts.backups]      — 造 backups/chat_*.jsonl 与 settings_*.json
 * @param {boolean} [opts.other]        — 造 groups/ · card-apps/ · thumbnails/ · secrets.json 等
 * @param {boolean} [opts.chatsRich]    — 造 2 char · 每 char 2 chat · 每 chat 2 sidecar + 1 group chat(用于 chats enumerator 精细测)
 * @param {boolean} [opts.charactersRich] — 造 2 char · 一带 sprites + 2 sidecar · 一只 plain PNG(用于 characters enumerator 精细测)
 * @param {boolean} [opts.otherRich]    — 造 groups + card-apps + thumbnails + secrets.json + 其它杂项(用于 other enumerator 精细测)
 * @returns {Promise<{userRoot: string, cleanup: () => Promise<void>}>}
 */
export async function makeFixtureUser(opts = {}) {
    const userRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'storage-inspector-fixture-'));

    const write = async (rel, content) => {
        const abs = path.join(userRoot, rel);
        await fsPromises.mkdir(path.dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content);
    };

    if (opts.chats) {
        await write('chats/default_Seraphina/Chat 2024-01-15.jsonl',
            JSON.stringify({ chat_metadata: { variables: { foo: 'bar' } } }) + '\n' +
            JSON.stringify({ name: 'User', mes: 'hi' }) + '\n' +
            JSON.stringify({ name: 'Sera', mes: 'hello' }) + '\n');
        await write('chats/default_Seraphina/Chat 2024-01-15.luker-state.memory_graph__floor_log.json',
            JSON.stringify({ nodes: [] }));
        await write('chats/default_Seraphina/Chat 2024-01-15.luker-state.luker_orchestrator_anchors__floor_log.json',
            JSON.stringify({ anchors: [] }));
        await write('group chats/group_abc123.jsonl',
            JSON.stringify({ chat_metadata: {} }) + '\n');
    }
    if (opts.characters) {
        // PNG 内容用 fake bytes;walker 只看 size,不解 PNG。
        await write('characters/default_Seraphina.png', Buffer.alloc(50_000, 0xff));
        await write('characters/default_Seraphina/happy.png', Buffer.alloc(10_000, 0xff));
        await write('characters/default_Seraphina/sad.png', Buffer.alloc(10_000, 0xff));
        await write('characters/default_Seraphina.state.cardapp_studio_sessions_v2.json',
            JSON.stringify({ sessions: [] }));
    }
    if (opts.worlds) {
        await write('worlds/lorebook_a.json', JSON.stringify({ entries: {} }));
        await write('worlds/lorebook_b.json', JSON.stringify({ entries: {} }));
    }
    if (opts.images) {
        await write('backgrounds/city.jpg', Buffer.alloc(20_000));
        await write('user/images/screenshot.png', Buffer.alloc(5_000));
        await write('User Avatars/persona-1.png', Buffer.alloc(3_000));
    }
    if (opts.attachments) {
        await write('user/files/doc.pdf', Buffer.alloc(30_000));
        await write('user/workflows/wf.json', JSON.stringify({ nodes: [] }));
    }
    if (opts.presets) {
        await write('OpenAI Settings/preset-a.json', JSON.stringify({ name: 'A' }));
        await write('OpenAI Settings/preset-b.json', JSON.stringify({ name: 'B' }));
        await write('settings.json', JSON.stringify({ power_user: {} }));
        await write('settings.json.backup-20260101-120000', JSON.stringify({ power_user: {} }));
    }
    if (opts.extensions) {
        await write('extensions/foo/index.js', 'console.log("foo");');
        await write('extensions/foo/manifest.json', JSON.stringify({ name: 'foo' }));
    }
    if (opts.vectors) {
        await write('vectors/index_a/data.bin', Buffer.alloc(100_000));
    }
    if (opts.backups) {
        await write('backups/chat_Seraphina_20260101.jsonl', 'line\n');
        await write('backups/settings_20260101.json', '{}');
    }
    if (opts.other) {
        await write('groups/g1.json', JSON.stringify({ id: 'g1' }));
        await write('card-apps/app.json', JSON.stringify({ name: 'app' }));
        await write('thumbnails/bg/city.jpg', Buffer.alloc(2_000));
        await write('secrets.json', JSON.stringify({ api_key_openai: 'sk-FAKE' }));
        await write('stats.json', JSON.stringify({ messages: 0 }));
    }
    if (opts.chatsRich) {
        // 2 chars · 每 char 2 chat · 每 chat 2 sidecar · 加 1 个 group chat(flat)
        for (const char of ['default_Seraphina', 'default_Coding']) {
            for (const day of ['2024-01-15', '2024-02-20']) {
                const chatName = `Chat ${day}`;
                const meta = { chat_metadata: { variables: { greeting: 'hi' } } };
                const msgs = Array.from({ length: 5 }, (_, i) =>
                    JSON.stringify({ name: i % 2 ? 'Bot' : 'User', mes: 'x'.repeat(200) }),
                ).join('\n');
                const body = JSON.stringify(meta) + '\n' + msgs + '\n';
                await write(`chats/${char}/${chatName}.jsonl`, body);
                await write(`chats/${char}/${chatName}.luker-state.memory_graph__floor_log.json`,
                    JSON.stringify({ nodes: Array.from({ length: 10 }, (_, i) => ({ id: i })) }));
                await write(`chats/${char}/${chatName}.luker-state.luker_orchestrator_anchors__floor_log.json`,
                    JSON.stringify({ anchors: Array.from({ length: 20 }, (_, i) => ({ id: i })) }));
            }
        }
        await write('group chats/group_abc.jsonl',
            JSON.stringify({ chat_metadata: {} }) + '\n' +
            JSON.stringify({ mes: 'hi' }) + '\n');
    }
    if (opts.charactersRich) {
        // 2 char · 一个带 sprites + sidecar · 一个 plain
        await write('characters/default_Seraphina.png', Buffer.alloc(60_000, 0xff));
        await write('characters/default_Seraphina/happy.png', Buffer.alloc(20_000, 0xff));
        await write('characters/default_Seraphina/sad.png', Buffer.alloc(20_000, 0xff));
        await write('characters/default_Seraphina/neutral.png', Buffer.alloc(20_000, 0xff));
        await write('characters/default_Seraphina.state.cardapp_studio_sessions_v2.json',
            JSON.stringify({ sessions: Array.from({ length: 5 }, (_, i) => ({ id: i })) }));
        await write('characters/default_Seraphina.state.character_editor_assistant_iter_sessions.json',
            JSON.stringify({ sessions: [] }));
        // Coding: 只有 PNG · 无 sprites · 无 sidecar
        await write('characters/default_Coding.png', Buffer.alloc(40_000, 0xff));
    }
    if (opts.otherRich) {
        await write('groups/g1.json', JSON.stringify({ id: 'g1', name: 'Team' }));
        await write('groups/g2.json', JSON.stringify({ id: 'g2' }));
        await write('card-apps/app1.json', JSON.stringify({ name: 'App1' }));
        await write('thumbnails/bg/city.jpg', Buffer.alloc(2_000));
        await write('thumbnails/avatar/x.jpg', Buffer.alloc(1_000));
        await write('secrets.json', JSON.stringify({
            api_key_openai: 'sk-FAKE',
            api_key_anthropic: 'sk-ant-FAKE',
        }));
        await write('stats.json', JSON.stringify({ chats: 5 }));
        await write('image-metadata.json', JSON.stringify({}));
        await write('content.log', 'log line\n');
    }

    const cleanup = async () => {
        await fsPromises.rm(userRoot, { recursive: true, force: true });
    };
    return { userRoot, cleanup };
}
