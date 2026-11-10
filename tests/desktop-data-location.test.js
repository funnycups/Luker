import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync,
    symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    POINTER_FILE, checkFreeSpace, classifyDataTarget, classifyRecoveryTarget, cleanupSourceDirectory,
    directoryIdentity, finishPendingCleanup, migrateDataDirectory, readLocationState, resolveLocation,
    validateWritableDirectory, writeLocationState,
} from '../desktop-app/data-location.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'luker-location-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const pointer = () => path.join(dir, POINTER_FILE);

test('missing pointer resolves to the default directory', () => {
    const r = resolveLocation({ defaultUserData: dir, envUserData: null });
    expect(r.activeUserData).toBe(dir);
    expect(r.locked).toBe(false);
    expect(r.state).toBeNull();
    expect(r.error).toBeNull();
});

test('a pointer selects the stored directory', () => {
    const target = path.join(dir, 'target');
    writeLocationState(pointer(), { version: 1, userData: target });
    const r = resolveLocation({ defaultUserData: dir, envUserData: null });
    expect(r.activeUserData).toBe(target);
    expect(r.error).toBeNull();
});

test('the environment override wins over the pointer and locks the setting', () => {
    writeLocationState(pointer(), { version: 1, userData: path.join(dir, 'stored') });
    const env = path.join(dir, 'env');
    const r = resolveLocation({ defaultUserData: dir, envUserData: env });
    expect(r.activeUserData).toBe(env);
    expect(r.locked).toBe(true);
    expect(r.state).toBeNull();
});

test('a malformed pointer is an error, not a fallback', () => {
    writeFileSync(pointer(), '{ not json');
    const r = resolveLocation({ defaultUserData: dir, envUserData: null });
    expect(r.activeUserData).toBe(dir);
    expect(r.error.code).toBe('pointer-invalid');
});

test('a relative userData is rejected', () => {
    writeFileSync(pointer(), JSON.stringify({ version: 1, userData: 'relative/dir' }));
    const r = resolveLocation({ defaultUserData: dir, envUserData: null });
    expect(r.error.code).toBe('pointer-invalid');
});

test('pending states cannot coexist or nest', () => {
    writeFileSync(pointer(), JSON.stringify({
        version: 1,
        userData: dir,
        pendingMoveTo: path.join(dir, 'target'),
        pendingMoveToIdentity: '1:1',
        pendingDeleteFrom: dir,
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
    writeFileSync(pointer(), JSON.stringify({
        version: 1,
        userData: dir,
        pendingMoveTo: path.join(dir, 'sub', 'target'),
        pendingMoveToIdentity: '1:1',
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
});

test('a pending move must carry the chosen folder identity', () => {
    writeFileSync(pointer(), JSON.stringify({
        version: 1, userData: dir, pendingMoveTo: path.join(dir, 'target'),
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
    writeFileSync(pointer(), JSON.stringify({
        version: 1, userData: dir, pendingMoveTo: path.join(dir, 'target'), pendingMoveToIdentity: 'not-an-identity',
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
    writeFileSync(pointer(), JSON.stringify({
        version: 1, userData: dir, pendingMoveToIdentity: '1:1',
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
});

test('a pending move with a folder identity is accepted', () => {
    const userData = path.join(dir, 'user-data');
    const target = path.join(dir, 'target');
    writeFileSync(pointer(), JSON.stringify({
        version: 1, userData, pendingMoveTo: target, pendingMoveToIdentity: '12:34',
    }));
    expect(readLocationState(pointer())).toEqual({
        state: {
            version: 1, userData, pendingMoveTo: target, pendingMoveToIdentity: '12:34',
        },
        error: null,
    });
});

test('path comparisons follow symbolic links', () => {
    if (process.platform === 'win32') return;
    const real = path.join(dir, 'real');
    mkdirSync(real);
    mkdirSync(path.join(real, 'inside'));
    symlinkSync(real, path.join(dir, 'alias'));
    expect(classifyDataTarget(path.join(dir, 'alias'), { source: real, defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'same' });
    expect(classifyDataTarget(path.join(dir, 'alias', 'inside'), { source: real, defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'nested' });
    const parent = path.join(dir, 'parent');
    const defaultDir = path.join(parent, 'Luker');
    mkdirSync(defaultDir, { recursive: true });
    symlinkSync(parent, path.join(dir, 'parent-alias'));
    expect(classifyDataTarget(path.join(dir, 'parent-alias'), { source: path.join(dir, 'src'), defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'default-ancestor' });
});

test('a pending path that aliases userData is invalid', () => {
    if (process.platform === 'win32') return;
    const real = path.join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, path.join(dir, 'alias'));
    writeFileSync(pointer(), JSON.stringify({
        version: 1, userData: real, pendingDeleteFrom: path.join(dir, 'alias'),
    }));
    expect(readLocationState(pointer()).error.code).toBe('pointer-invalid');
});

test('writeLocationState replaces the file and leaves no temp file', () => {
    writeLocationState(pointer(), { version: 1, userData: path.join(dir, 'one') });
    writeLocationState(pointer(), { version: 1, userData: path.join(dir, 'two') });
    const state = JSON.parse(readFileSync(pointer(), 'utf8'));
    expect(state.userData).toBe(path.join(dir, 'two'));
    expect(readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([]);
});

test('an empty directory and the pointer-only default directory are move targets', () => {
    const empty = path.join(dir, 'empty'); mkdirSync(empty);
    expect(classifyDataTarget(empty, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'move' });
    const pointerOnly = path.join(dir, 'pointer-only'); mkdirSync(pointerOnly);
    writeLocationState(path.join(pointerOnly, POINTER_FILE), { version: 1, userData: path.join(dir, 'other') });
    expect(classifyDataTarget(pointerOnly, { source: path.join(dir, 'src'), defaultUserData: pointerOnly }))
        .toEqual({ mode: 'move' });
    expect(classifyDataTarget(pointerOnly, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'unrecognized' });
});

test('config.yaml plus data is an existing Luker directory', () => {
    const target = path.join(dir, 'luker'); mkdirSync(target); mkdirSync(path.join(target, 'data'));
    writeFileSync(path.join(target, 'config.yaml'), 'storage: fs\n');
    expect(classifyDataTarget(target, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'adopt' });
});

test('unrelated contents, partial Luker trees, files, same paths and nesting are rejected', () => {
    const unrelated = path.join(dir, 'unrelated'); mkdirSync(unrelated); writeFileSync(path.join(unrelated, 'note.txt'), 'x');
    expect(classifyDataTarget(unrelated, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'unrecognized' });
    const partial = path.join(dir, 'partial'); mkdirSync(partial); mkdirSync(path.join(partial, 'plugins'));
    expect(classifyDataTarget(partial, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'unrecognized' });
    const file = path.join(dir, 'file'); writeFileSync(file, 'x');
    expect(classifyDataTarget(file, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'not-directory' });
    expect(classifyDataTarget(dir, { source: dir, defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'same' });
    const nested = path.join(dir, 'src', 'inside'); mkdirSync(path.dirname(nested), { recursive: true }); mkdirSync(nested);
    expect(classifyDataTarget(nested, { source: path.join(dir, 'src'), defaultUserData: path.join(dir, 'default') }))
        .toEqual({ mode: 'reject', reason: 'nested' });
    const defaultAncestor = path.join(dir, 'parent'); mkdirSync(defaultAncestor, { recursive: true });
    const defaultDir = path.join(defaultAncestor, 'Luker'); mkdirSync(defaultDir);
    expect(classifyDataTarget(defaultAncestor, { source: path.join(dir, 'src'), defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'default-ancestor' });
});

test('recovery rejects an ancestor of the default directory', () => {
    const parent = path.join(dir, 'parent');
    const defaultDir = path.join(parent, 'Luker');
    mkdirSync(defaultDir, { recursive: true });
    expect(classifyRecoveryTarget(parent, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'default-ancestor' });
});

test('recovery rejects a symlink alias of the default directory ancestor', () => {
    if (process.platform === 'win32') return;
    const parent = path.join(dir, 'parent');
    const defaultDir = path.join(parent, 'Luker');
    mkdirSync(defaultDir, { recursive: true });
    symlinkSync(parent, path.join(dir, 'parent-alias'));
    expect(classifyRecoveryTarget(path.join(dir, 'parent-alias'), { defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'default-ancestor' });
});

test('recovery classifies the default directory, existing data and unrelated folders', () => {
    const defaultDir = path.join(dir, 'Luker');
    mkdirSync(defaultDir, { recursive: true });
    expect(classifyRecoveryTarget(defaultDir, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'empty' });
    writeLocationState(path.join(defaultDir, POINTER_FILE), { version: 1, userData: path.join(dir, 'other') });
    expect(classifyRecoveryTarget(defaultDir, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'empty' });
    const inside = path.join(defaultDir, 'inside');
    mkdirSync(inside);
    expect(classifyRecoveryTarget(inside, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'empty' });
    const existing = path.join(dir, 'existing');
    mkdirSync(path.join(existing, 'data'), { recursive: true });
    writeFileSync(path.join(existing, 'config.yaml'), 'storage: fs\n');
    expect(classifyRecoveryTarget(existing, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'adopt' });
    const unrelated = path.join(dir, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, 'note.txt'), 'x');
    expect(classifyRecoveryTarget(unrelated, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'unrecognized' });
    const file = path.join(dir, 'file');
    writeFileSync(file, 'x');
    expect(classifyRecoveryTarget(file, { defaultUserData: defaultDir }))
        .toEqual({ mode: 'reject', reason: 'not-directory' });
});

test('an unwritable directory fails validation', () => {
    if (process.getuid?.() === 0) return;
    const target = path.join(dir, 'readonly'); mkdirSync(target);
    chmodSync(target, 0o500);
    try {
        expect(() => validateWritableDirectory(target)).toThrow();
    } finally {
        chmodSync(target, 0o700);
    }
});

test('free space covers the measured source entries', () => {
    const source = path.join(dir, 'source'); mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'file.bin'), Buffer.alloc(1024));
    const target = path.join(dir, 'target'); mkdirSync(target);
    const result = checkFreeSpace(source, target);
    expect(result.required).toBeGreaterThanOrEqual(1024);
    expect(result.enough).toBe(true);
});

test('migration copies only the whitelist and preserves the source', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    mkdirSync(path.join(source, 'plugins'), { recursive: true });
    mkdirSync(path.join(source, 'Cache'), { recursive: true });
    mkdirSync(path.join(source, 'updates'), { recursive: true });
    writeFileSync(path.join(source, 'config.yaml'), 'storage: fs\n');
    writeFileSync(path.join(source, 'http-auth.json'), '{}');
    writeFileSync(path.join(source, 'data', 'chat.jsonl'), 'hello');
    writeFileSync(path.join(source, 'plugins', 'plugin.js'), 'x');
    writeFileSync(path.join(source, 'Cache', 'cache.bin'), 'x');
    writeFileSync(path.join(source, 'updates', 'setup.exe'), 'x');
    writeLocationState(path.join(source, POINTER_FILE), { version: 1, userData: source });
    mkdirSync(target);

    const progress = [];
    const result = await migrateDataDirectory({ source, target, onProgress: p => progress.push(p) });

    expect(result.copiedBytes).toBeGreaterThan(0);
    expect(readFileSync(path.join(target, 'data', 'chat.jsonl'), 'utf8')).toBe('hello');
    expect(existsSync(path.join(target, 'plugins', 'plugin.js'))).toBe(true);
    expect(existsSync(path.join(target, 'http-auth.json'))).toBe(true);
    expect(existsSync(path.join(target, 'Cache'))).toBe(false);
    expect(existsSync(path.join(target, 'updates'))).toBe(false);
    expect(existsSync(path.join(target, POINTER_FILE))).toBe(false);
    expect(existsSync(path.join(source, 'data', 'chat.jsonl'))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
});

test('migration clears target entries left by a previous attempt', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.jsonl'), 'new');
    mkdirSync(path.join(target, 'data'), { recursive: true });
    writeFileSync(path.join(target, 'data', 'chat.jsonl'), 'old');
    await migrateDataDirectory({ source, target });
    expect(readFileSync(path.join(target, 'data', 'chat.jsonl'), 'utf8')).toBe('new');
});

test('a failed migration leaves the source intact and removes target partials', async () => {
    const source = path.join(dir, 'source');
    const targetFile = path.join(dir, 'target-file');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.jsonl'), 'hello');
    writeFileSync(targetFile, 'not a directory');
    await expect(migrateDataDirectory({ source, target: targetFile })).rejects.toThrow();
    expect(readFileSync(path.join(source, 'data', 'chat.jsonl'), 'utf8')).toBe('hello');
});

test('cleanup keeps the pointer in the default directory and removes everything else', async () => {
    const source = path.join(dir, 'default');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    mkdirSync(path.join(source, 'Cache'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.jsonl'), 'x');
    writeLocationState(path.join(source, POINTER_FILE), { version: 1, userData: path.join(dir, 'target') });
    await cleanupSourceDirectory({ source, defaultUserData: source });
    expect(readdirSync(source)).toEqual([POINTER_FILE]);
});

test('cleanup removes a non-default source directory', async () => {
    const source = path.join(dir, 'old');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    await cleanupSourceDirectory({ source, defaultUserData: path.join(dir, 'default') });
    expect(existsSync(source)).toBe(false);
});

test('cleanup treats a missing source as success', async () => {
    await expect(cleanupSourceDirectory({
        source: path.join(dir, 'missing'),
        defaultUserData: path.join(dir, 'default'),
    })).resolves.toBeUndefined();
});

test('finishing a pending cleanup writes the normal pointer', async () => {
    const defaultDir = path.join(dir, 'default');
    const oldDir = path.join(dir, 'old');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    const pointer = path.join(defaultDir, POINTER_FILE);
    const state = { version: 1, userData: path.join(dir, 'target'), pendingDeleteFrom: oldDir };
    writeLocationState(pointer, state);
    const next = await finishPendingCleanup({ pointerPath: pointer, state, defaultUserData: defaultDir });
    expect(next).toEqual({ version: 1, userData: path.join(dir, 'target') });
    expect(existsSync(oldDir)).toBe(false);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual(next);
});

test('a failed cleanup leaves the pointer pending', async () => {
    if (process.getuid?.() === 0) return;
    const defaultDir = path.join(dir, 'default');
    const parent = path.join(dir, 'parent');
    const oldDir = path.join(parent, 'old');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(path.join(oldDir, 'file'), 'x');
    chmodSync(parent, 0o500);
    const pointer = path.join(defaultDir, POINTER_FILE);
    const state = { version: 1, userData: path.join(dir, 'target'), pendingDeleteFrom: oldDir };
    writeLocationState(pointer, state);
    try {
        await expect(finishPendingCleanup({ pointerPath: pointer, state, defaultUserData: defaultDir })).rejects.toThrow();
        expect(JSON.parse(readFileSync(pointer, 'utf8')).pendingDeleteFrom).toBe(oldDir);
    } finally {
        chmodSync(parent, 0o700);
    }
});

test('migration refuses a link that reaches outside the moved items', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    mkdirSync(path.join(source, 'actual'), { recursive: true });
    writeFileSync(path.join(source, 'actual', 'chat.txt'), 'hello');
    symlinkSync('../actual', path.join(source, 'data', 'linked'));
    mkdirSync(target);
    await expect(migrateDataDirectory({ source, target })).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(source, 'actual', 'chat.txt'), 'utf8')).toBe('hello');
    expect(existsSync(path.join(target, 'data'))).toBe(false);
});

test('migration refuses an absolute link back into the old folder', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    const shared = path.join(source, 'data', 'shared');
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, 'chat.txt'), 'hello');
    symlinkSync(shared, path.join(source, 'data', 'absolute-link'));
    mkdirSync(target);
    await expect(migrateDataDirectory({ source, target })).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(shared, 'chat.txt'), 'utf8')).toBe('hello');
    expect(existsSync(path.join(target, 'data'))).toBe(false);
});

test('migration preserves a link inside a moved item', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data', 'shared'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'shared', 'chat.txt'), 'hello');
    symlinkSync('shared', path.join(source, 'data', 'linked'));
    mkdirSync(target);
    await migrateDataDirectory({ source, target });
    expect(readFileSync(path.join(target, 'data', 'shared', 'chat.txt'), 'utf8')).toBe('hello');
    expect(readlinkSync(path.join(target, 'data', 'linked'))).toBe('shared');
});

test('migration preserves symbolic links, including broken ones', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'real.txt'), 'real');
    symlinkSync('real.txt', path.join(source, 'data', 'link.txt'));
    symlinkSync('missing.txt', path.join(source, 'data', 'broken.txt'));
    mkdirSync(target);
    await migrateDataDirectory({ source, target });
    expect(readFileSync(path.join(target, 'data', 'real.txt'), 'utf8')).toBe('real');
    expect(readlinkSync(path.join(target, 'data', 'link.txt'))).toBe('real.txt');
    expect(readlinkSync(path.join(target, 'data', 'broken.txt'))).toBe('missing.txt');
});

test('migration preserves a broken top-level symbolic link', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(source);
    symlinkSync(path.join(dir, 'missing-plugins'), path.join(source, 'plugins'));
    mkdirSync(target);
    await migrateDataDirectory({ source, target });
    expect(readlinkSync(path.join(target, 'plugins'))).toBe(path.join(dir, 'missing-plugins'));
});

test('migration yields to the event loop while copying', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    for (let index = 0; index < 300; index += 1) {
        writeFileSync(path.join(source, 'data', `file-${index}.txt`), 'x'.repeat(4096));
    }
    mkdirSync(target);
    let settled = false;
    const migration = migrateDataDirectory({ source, target }).then(() => {
        settled = true;
    });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
    expect(settled).toBe(false);
    await migration;
    expect(settled).toBe(true);
});

test('migration refuses a target that is not there', async () => {
    const source = path.join(dir, 'source');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.txt'), 'hello');
    const target = path.join(dir, 'missing-target');
    await expect(migrateDataDirectory({ source, target })).rejects.toThrow(/not available/);
    expect(readFileSync(path.join(source, 'data', 'chat.txt'), 'utf8')).toBe('hello');
    expect(existsSync(target)).toBe(false);
});

test('migration refuses a target that was replaced after the choice', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.txt'), 'hello');
    mkdirSync(target);
    const identity = directoryIdentity(target);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target);
    await expect(migrateDataDirectory({ source, target, targetIdentity: identity }))
        .rejects.toThrow(/no longer the chosen folder/);
    expect(readFileSync(path.join(source, 'data', 'chat.txt'), 'utf8')).toBe('hello');
});

test('migration accepts the chosen folder identity', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data', 'chat.txt'), 'hello');
    mkdirSync(target);
    await migrateDataDirectory({ source, target, targetIdentity: directoryIdentity(target) });
    expect(readFileSync(path.join(target, 'data', 'chat.txt'), 'utf8')).toBe('hello');
});
