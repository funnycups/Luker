// Storage Inspector e2e fixtures — populate a target user's data dir with
// enough content to exercise every top-level category (chats + sidecars,
// worldbooks, backgrounds image, secrets.json, backups, vectors) while
// staying in-character: chat filenames read as dated user chat history,
// character names are stock Luker demo names, worldbooks are named after
// the existing `bryn-headland` demo fixture so screenshots don't read as
// scaffolding.
//
// Runs against a real dataRoot the harness gave us — no APIs, just fs
// writes. The Inspector walks the same disk on the next request, so any
// change here is immediately visible via a real UI drill.

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

/**
 * Seed a plausible-looking user data corpus under `dataRoot/<handle>/`.
 * Each category populated so that the L1 stacked bar has visible
 * segments for chats + worlds + images + other + backups + vectors.
 *
 * @param {string} dataRoot  absolute path to the server's dataRoot
 * @param {string} handle    user handle (subdir under dataRoot)
 */
export async function seedFixtureUser(dataRoot, handle) {
    const root = path.join(dataRoot, handle);
    /**
     * Write `content` to `<root>/<rel>`, creating parent dirs as needed.
     */
    const w = async (rel, content) => {
        const abs = path.join(root, rel);
        await fsPromises.mkdir(path.dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content);
    };

    // chats: 3 characters × 2 dated chats each, each chat carrying a
    // metadata line + 8 message lines, plus two sidecar files per chat
    // (memory graph + orchestrator anchors — Luker's most common sidecars).
    for (const char of ['default_Seraphina', 'default_Coding', 'default_Alice']) {
        for (const day of ['2024-01-15', '2024-02-20']) {
            const chatName = `Chat ${day}`;
            const meta = { chat_metadata: { variables: { greeting: 'hi' } } };
            const msgs = Array.from({ length: 8 }, (_, i) =>
                JSON.stringify({ name: i % 2 ? 'Bot' : 'User', mes: 'x'.repeat(500) }),
            ).join('\n');
            await w(`chats/${char}/${chatName}.jsonl`,
                JSON.stringify(meta) + '\n' + msgs + '\n');
            await w(`chats/${char}/${chatName}.luker-state.memory_graph__floor_log.json`,
                JSON.stringify({ nodes: Array.from({ length: 15 }) }));
            await w(`chats/${char}/${chatName}.luker-state.luker_orchestrator_anchors__floor_log.json`,
                JSON.stringify({ anchors: Array.from({ length: 50 }) }));
        }
    }

    // Worldbooks — named after the existing Bryn Headland demo fixture so
    // the screenshots read as real lore, not test scaffolding.
    await w('worlds/Bryn Headland.json', JSON.stringify({ entries: {} }));
    await w('worlds/Aetherpost Reference.json', JSON.stringify({ entries: {} }));

    // A background image (mostly zero bytes — just enough to register a
    // real file size for the Images category).
    // non-trivial size for L1 bar visibility
    await w('backgrounds/city.jpg', Buffer.alloc(20_000));

    // Secrets file — the Other category will show it as a sensitive blob
    // with a lock icon (drill blocked at both API and UI).
    await w('secrets.json', JSON.stringify({ api_key_openai: 'sk-FAKE' }));

    // A chat backup line — populates the Backups L2.
    await w('backups/chat_Seraphina_20260101.jsonl', 'line\n');

    // Vector store blob — 50 KB placeholder for the Vectors category.
    // non-trivial size for L1 bar visibility
    await w('vectors/idx_a/data.bin', Buffer.alloc(50_000));
}
