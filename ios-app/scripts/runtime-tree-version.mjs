#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Prints a stable content hash of a staged runtime tree. The iOS shell uses it
// as the runtime marker, so an app update that ships the same server tree does
// not recopy hundreds of megabytes on first launch.

import { createHash } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const VERSION_FILE_NAME = '.runtime-tree-version';

async function collect(dir, prefix, entries) {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const item of items) {
        if (!prefix && item.name === VERSION_FILE_NAME) {
            continue;
        }
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            await collect(fullPath, relative, entries);
        } else if (item.isSymbolicLink()) {
            entries.push(['L', relative, await readlink(fullPath)]);
        } else if (item.isFile()) {
            const digest = createHash('sha256').update(await readFile(fullPath)).digest('hex');
            entries.push(['F', relative, digest]);
        }
    }
}

const root = process.argv[2];
if (!root) {
    console.error('usage: runtime-tree-version.mjs <staged-runtime-dir>');
    process.exit(1);
}

const entries = [];
await collect(root, '', entries);
const hash = createHash('sha256');
for (const entry of entries) {
    hash.update(entry.join('\0'));
    hash.update('\n');
}
process.stdout.write(hash.digest('hex'));
