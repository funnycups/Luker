import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { failureGroup } from './errors.js';

function present(expected) {
    let actual;
    try { actual = fs.lstatSync(expected.path); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino || fs.realpathSync(expected.path) !== expected.path) throw new Error(`Owned removal directory changed: ${expected.path}`);
    return true;
}

function entries(receipt) {
    for (const directory of [receipt.root, receipt.parent]) if (!directory || typeof directory.path !== 'string' || path.resolve(directory.path) !== directory.path || !Number.isSafeInteger(directory.dev) || directory.dev < 0 || !Number.isSafeInteger(directory.ino) || directory.ino < 0) throw new Error('Owned removal has no registered directory identity');
    if (receipt.parent.path !== path.dirname(receipt.root.path)) throw new Error(`Owned removal has an unregistered parent: ${receipt.root.path}`);
    const found = new Map();
    for (const [kind, values] of [['directory', receipt.directories], ['file', receipt.files]]) for (const item of values) {
        if (typeof item.name !== 'string' || item.name.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) || found.has(item.name) || !Number.isSafeInteger(item.dev) || !Number.isSafeInteger(item.ino)) throw new Error(`Invalid owned removal entry: ${item.name}`);
        if (kind === 'file' && (!Number.isSafeInteger(item.length) || item.length < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error(`Invalid owned removal file integrity: ${item.name}`);
        found.set(item.name, { ...item, kind });
    }
    return found;
}

function inspect(receipt, partial) {
    const expected = entries(receipt);
    if (!present(receipt.parent)) throw new Error(`Owned removal parent is missing: ${receipt.parent.path}`);
    const seen = new Set();
    const visit = (directory, relative) => {
        for (const name of fs.readdirSync(directory)) {
            const relativeName = relative ? relative + '/' + name : name;
            const item = expected.get(relativeName);
            if (!item) throw new Error(`Owned removal contains unregistered content: ${path.join(directory, name)}`);
            seen.add(relativeName);
            const filename = path.join(directory, name);
            if (item.kind === 'directory') {
                present({ ...item, path: filename }); visit(filename, relativeName);
            } else {
                const stat = fs.lstatSync(filename);
                if (!stat.isFile() || stat.dev !== item.dev || stat.ino !== item.ino) throw new Error(`Owned removal file changed: ${filename}`);
                const bytes = fs.readFileSync(filename, { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
                if (bytes.length !== item.length || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Owned removal file failed length/SHA256 verification: ${filename}`);
            }
        }
    };
    if (present(receipt.root)) visit(receipt.root.path, '');
    else if (!partial) throw new Error(`Owned removal root is missing before registration: ${receipt.root.path}`);
    if (!partial && seen.size !== expected.size) throw new Error(`Owned removal inventory is incomplete: ${receipt.root.path}`);
    return seen;
}

export function removalReceipt(expected) {
    // structuredClone() materializes host-realm objects when this module runs
    // in a VM context, which makes isDeepStrictEqual reject an otherwise
    // identical receipt. Build the receipt with plain literals instead.
    const receipt = {
        format: 'owned-tree-removal-v1',
        state: 'removing',
        root: { ...expected.root },
        parent: { ...expected.parent },
        directories: expected.directories.map(directory => ({ ...directory })),
        files: expected.files.map(file => ({ ...file })),
    };
    inspect(receipt, false);
    return receipt;
}

export function verifyOwnedTree(expected) {
    inspect(expected, false);
}

export function verifyRemoval(receipt, expected) {
    if (!receipt || receipt.format !== 'owned-tree-removal-v1' || !['removing', 'complete'].includes(receipt.state) || !isDeepStrictEqual({ root: receipt.root, parent: receipt.parent, directories: receipt.directories, files: receipt.files }, expected)) throw new Error(`Owned removal has no matching registered authority: ${expected.root.path}`);
    const remaining = inspect(receipt, true);
    if (receipt.state === 'complete' && present(receipt.root)) throw new Error(`Completed owned removal unexpectedly exists: ${receipt.root.path}`);
    return remaining;
}

export async function removeOwnedTree(receipt, expected) {
    const remaining = verifyRemoval(receipt, expected);
    if (receipt.state === 'complete') return;
    for (const file of receipt.files) if (remaining.has(file.name)) fs.unlinkSync(path.join(receipt.root.path, file.name));
    for (const directory of [...receipt.directories].sort((left, right) => right.name.split('/').length - left.name.split('/').length)) if (remaining.has(directory.name)) fs.rmdirSync(path.join(receipt.root.path, directory.name));
    if (present(receipt.root)) fs.rmdirSync(receipt.root.path);
    const descriptor = fs.openSync(path.dirname(receipt.root.path), 'r');
    const errors = [];
    try { await new Promise((resolve, reject) => fs.fsync(descriptor, error => error ? reject(error) : resolve())); }
    catch (error) { errors.push(error); }
    try { fs.closeSync(descriptor); }
    catch (error) { errors.push(error); }
    if (errors.length) throw failureGroup(errors, `Cannot settle owned removal: ${receipt.root.path}`);
    receipt.state = 'complete';
}
