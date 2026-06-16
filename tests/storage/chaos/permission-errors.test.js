// Chaos: file-permission failures should bubble up as readable errors rather
// than crash the engine, return null, or silently no-op. Both branches use
// chmod, so the suite is Linux/macOS-only — `process.platform === 'win32'`
// skips because Windows ACLs don't behave like POSIX modes.
//
// `afterEach` restores any mode we set, then removes the tmp dir. The cleanup
// walks before-the-fact in case a test fails mid-flight and leaves the tree
// half-locked; otherwise jest's recursive cleanup would itself fail with EACCES.
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';

const [{ make: makeFs }] = CONTRACT_HARNESSES;
const platformSpecific = process.platform === 'win32' ? test.skip : test;

function restorePermissionsRecursive(root) {
    if (!fs.existsSync(root)) return;
    // Walk top-down: bump the dir's mode so we can read/traverse it, then recurse.
    let stat;
    try { stat = fs.statSync(root); } catch { return; }
    if (stat.isDirectory()) {
        try { fs.chmodSync(root, 0o755); } catch { /* may already be permissive */ }
        let entries = [];
        try { entries = fs.readdirSync(root); } catch { return; }
        for (const entry of entries) {
            restorePermissionsRecursive(path.join(root, entry));
        }
    } else {
        try { fs.chmodSync(root, 0o644); } catch { /* nothing to do */ }
    }
}

describe('Permission errors', () => {
    let h;
    beforeEach(async () => { h = await makeFs(); });
    afterEach(() => {
        try { restorePermissionsRecursive(h.dirs.root); } catch { /* best-effort */ }
        h.cleanup();
    });

    platformSpecific('SettingsRepo.get surfaces EACCES when settings.json is unreadable', async () => {
        const repo = new SettingsRepo({ engine: h.engine });
        await repo.save(h.handle, { x: 1 });
        const fp = path.join(h.dirs.root, 'settings.json');
        fs.chmodSync(fp, 0o000);
        await expect(repo.get(h.handle)).rejects.toThrow(/EACCES|permission/i);
    });

    platformSpecific('ChatRepo.save surfaces EACCES when the chat dir is unwritable', async () => {
        const repo = new ChatRepo({ engine: h.engine });
        // The handler will mkdirSync recursive (no-op on an existing dir),
        // then writeFileAtomic which creates a `<file>.<pid>.<ts>.tmp` next
        // to the target. A 0o555 (r-xr-xr-x) dir allows traversal but blocks
        // creating new entries — exactly what we want.
        const charDir = path.join(h.dirs.chats, 'TestChar');
        fs.mkdirSync(charDir, { recursive: true });
        fs.chmodSync(charDir, 0o555);
        await expect(repo.save(
            h.handle, 'TestChar', 'chat1',
            { chat_metadata: {}, user_name: 'U' },
            [],
            null,
        )).rejects.toThrow(/EACCES|permission/i);
    });
});
