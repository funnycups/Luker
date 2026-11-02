import { TextDecoder } from 'node:util';
import git from 'isomorphic-git';

import { normalizeDeviceLabel } from '../device-label.js';
import { atomicFs } from './atomic-fs.js';
import { SYNC_AUTHOR } from './merge.js';

const PREFIX = 'Luker Device v1 ';
const EMAIL = 'device@luker.local';

/** @param {string} label @returns {{ name: string, email: string }} */
export function authorForDevice(label) {
    const normalized = normalizeDeviceLabel(label);
    return normalized
        ? { name: PREFIX + Buffer.from(normalized, 'utf8').toString('base64url'), email: EMAIL }
        : { ...SYNC_AUTHOR };
}

/** @param {{ gitdir: string, oid: string }} args @returns {Promise<string>} */
export async function deviceLabelForCommit({ gitdir, oid }) {
    const { commit: { author } } = await git.readCommit({ fs: atomicFs, gitdir, oid });
    if (author.email !== EMAIL || !author.name.startsWith(PREFIX)) return SYNC_AUTHOR.name;
    const encoded = author.name.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return SYNC_AUTHOR.name;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return SYNC_AUTHOR.name;
    let label;
    try {
        label = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return SYNC_AUTHOR.name;
    }
    return label && normalizeDeviceLabel(label) === label ? label : SYNC_AUTHOR.name;
}
