import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { assertConfinedPath } from './path-confinement.js';

const failure = (code, operation, parent, detail) => Object.assign(new Error(`${operation}: filesystem identity at ${parent}: ${detail}`), { code });
const identity = stat => `${stat.dev}:${stat.ino}`;

function existingParent(boundary, absolutePath) {
    let parent = path.dirname(absolutePath);
    while (true) {
        assertConfinedPath({ boundary, absolutePath: parent });
        try {
            if (fs.lstatSync(parent).isDirectory()) return parent;
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
        if (parent === boundary) throw failure('SYNC_FS_IDENTITY_UNVERIFIED', 'admission', parent, 'no existing directory for a native probe');
        parent = path.dirname(parent);
    }
}

function assertExistingSpelling(boundary, absolutePath, operation, listings) {
    let current = boundary;
    for (const segment of path.relative(boundary, absolutePath).split(path.sep)) {
        let stat;
        try { stat = fs.lstatSync(path.join(current, segment)); } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
            throw error;
        }
        if (!listings.has(current)) listings.set(current, new Set(fs.readdirSync(current, { encoding: 'buffer' }).map(name => name.toString('hex'))));
        if (!listings.get(current).has(Buffer.from(segment).toString('hex'))) throw failure('SYNC_FS_ALIAS', operation, current, `requested spelling ${JSON.stringify(segment)} resolves to another directory entry`);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return;
        current = path.join(current, segment);
    }
}

function probeDestinations(parent, destinations, operation) {
    const prefix = `.luker-staging-identity-${randomBytes(12).toString('hex')}`;
    const scratch = fs.mkdtempSync(path.join(parent, `${prefix}-`));
    const owned = [];
    const manifest = path.join(scratch, 'ownership.ndjson');
    const record = absolutePath => {
        const entry = { absolutePath, identity: identity(fs.lstatSync(absolutePath, { bigint: true })) };
        owned.push(entry);
        fs.appendFileSync(manifest, `${JSON.stringify(entry)}\n`);
    };
    const pair = (dir, suffix, first, second) => {
        const a = path.join(dir, `${prefix}-${suffix}-${first}`);
        const b = path.join(dir, `${prefix}-${suffix}-${second}`);
        fs.closeSync(fs.openSync(a, 'wx'));
        record(a);
        try {
            fs.closeSync(fs.openSync(b, 'wx'));
            record(b);
            return false;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (identity(fs.lstatSync(a, { bigint: true })) !== identity(fs.lstatSync(b, { bigint: true }))) throw failure('SYNC_FS_IDENTITY_UNVERIFIED', operation, parent, 'probe name is owned by another directory entry');
            return true;
        }
    };
    let primary;
    try {
        fs.writeFileSync(manifest, `${JSON.stringify({ parent, scratch, pid: process.pid })}\n`, { flag: 'wx' });
        const child = path.join(scratch, 'semantics');
        fs.mkdirSync(child);
        record(child);
        const actual = [pair(parent, 'case', 'A', 'a'), pair(parent, 'normalization', '\u00e9', 'e\u0301')];
        const inherited = [pair(child, 'case', 'A', 'a'), pair(child, 'normalization', '\u00e9', 'e\u0301')];
        if (actual.some((value, index) => value !== inherited[index])) throw failure('SYNC_FS_IDENTITY_UNVERIFIED', operation, parent, 'child case/normalization semantics differ from the actual destination parent');
        const mirror = path.join(scratch, 'destinations');
        fs.mkdirSync(mirror);
        record(mirror);
        const nodes = new Map();
        const spellings = new Map();
        let obstruction;
        // Plan directory roles first so an obstruction cannot hide child aliases.
        for (const destination of destinations) {
            const parts = path.relative(parent, destination.absolutePath).split(path.sep);
            let relative = '';
            for (const [index, segment] of parts.entries()) {
                const directory = index < parts.length - 1 || destination.kind === 'directory';
                relative = relative ? `${relative}/${segment}` : segment;
                const previous = nodes.get(relative);
                if (previous) {
                    if (previous.directory !== directory) obstruction ??= failure('SYNC_FS_PATH_OBSTRUCTED', operation, parent, `file/directory collision for ${destination.treePath} and ${previous.treePath}`);
                    previous.directory ||= directory;
                } else nodes.set(relative, { directory, segment, treePath: destination.treePath });
            }
        }
        for (const [relative, destination] of nodes) {
            const next = path.join(mirror, ...relative.split('/'));
            const current = path.dirname(next);
            try {
                if (destination.directory) fs.mkdirSync(next);
                else fs.closeSync(fs.openSync(next, 'wx'));
            } catch (error) {
                if (error.code === 'EEXIST') {
                    const actualNames = fs.readdirSync(current, { encoding: 'buffer' }).map(name => name.toString('utf8'));
                    throw failure('SYNC_FS_ALIAS', operation, parent, `distinct destination ${destination.treePath} aliases an existing spelling in ${JSON.stringify(actualNames)}`);
                }
                if (error.code === 'ENAMETOOLONG' || error.code === 'EINVAL') throw failure('SYNC_FS_NAME_UNREPRESENTABLE', operation, parent, `destination ${destination.treePath} cannot be represented: ${error.code}`);
                throw error;
            }
            record(next);
            if (!spellings.has(current)) spellings.set(current, new Map());
            spellings.get(current).set(Buffer.from(destination.segment).toString('hex'), destination.treePath);
        }
        for (const [directory, expected] of spellings) {
            const actualNames = new Set(fs.readdirSync(directory, { encoding: 'buffer' }).map(name => name.toString('hex')));
            for (const [name, treePath] of expected) if (!actualNames.has(name)) throw failure('SYNC_FS_NAME_UNREPRESENTABLE', operation, parent, `destination ${treePath} does not retain its exact spelling`);
        }
        if (obstruction) throw obstruction;
    } catch (error) { primary = error; }
    const cleanupErrors = [];
    for (const entry of owned.reverse()) {
        try {
            const stat = fs.lstatSync(entry.absolutePath, { bigint: true });
            if (identity(stat) !== entry.identity) throw failure('SYNC_FS_IDENTITY_UNVERIFIED', operation, parent, `owned probe entry was replaced: ${entry.absolutePath}`);
            if (stat.isDirectory()) fs.rmdirSync(entry.absolutePath);
            else fs.unlinkSync(entry.absolutePath);
        } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length === 0) {
        try { fs.unlinkSync(manifest); fs.rmdirSync(scratch); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw Object.assign(new globalThis.AggregateError([...(primary ? [primary] : []), ...cleanupErrors], `${operation}: native identity probe cleanup failed at ${scratch}`), { code: 'SYNC_FS_PROBE_CLEANUP_FAILED' });
    if (primary) throw primary;
}

/** Validate exact destinations against their own native parent in one local epoch. */
export async function assertDistinctFsDestinations({ boundary, destinations, operation }) {
    const root = path.resolve(boundary);
    const groups = new Map();
    const listings = new Map();
    const exact = new Map();
    for (const destination of destinations) {
        const absolutePath = path.resolve(destination.absolutePath);
        assertConfinedPath({ boundary: root, absolutePath });
        const previous = exact.get(absolutePath);
        if (previous && previous.logicalIdentity !== destination.logicalIdentity) throw failure('SYNC_FS_ALIAS', operation, path.dirname(absolutePath), `distinct records ${previous.treePath} and ${destination.treePath} share a destination`);
        if (previous) continue;
        exact.set(absolutePath, destination);
        assertExistingSpelling(root, absolutePath, operation, listings);
        const parent = existingParent(root, absolutePath);
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push({ ...destination, absolutePath });
    }
    let obstruction;
    for (const [parent, entries] of groups) {
        try { probeDestinations(parent, entries, operation); } catch (error) {
            if (error.code !== 'SYNC_FS_PATH_OBSTRUCTED') throw error;
            obstruction ??= error;
        }
    }
    if (obstruction) throw obstruction;
}
