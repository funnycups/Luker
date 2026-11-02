import { TextDecoder } from 'node:util';
import { buildSidecarFilename, splitSidecarFilename } from './engines/sidecar-naming.js';

export const PRESET_RECORDS_DIRECTORY = '.luker-preset-records';
const invalid = (relativePath, detail, code = 'PRESET_PROJECTION_INVALID') => Object.assign(new Error(`Invalid preset record path ${relativePath}: ${detail}`), { code });
const safeSegment = value => value !== '' && value !== '.' && value !== '..' && value !== '.git' && value !== '.DS_Store' && !/[\\/\0]/.test(value);

/** Complete logical identity, independent of physical path and serialization. */
export function presetRecordIdentity(record) {
    if (record.kind === 'preset') return JSON.stringify(['preset', record.dirKey, record.name]);
    if (record.kind === 'preset-state') return JSON.stringify(['preset-state', record.dirKey, record.name, record.namespace]);
    throw invalid('', 'unsupported record kind');
}

/** Decode the declared legacy or structurally versioned format without guessing another format. */
export function decodePresetRecordRelativePath(dirKey, relativePath) {
    const segments = relativePath.split('/');
    if (segments[0] !== PRESET_RECORDS_DIRECTORY) {
        if (segments.length !== 1 || !safeSegment(relativePath) || !relativePath.endsWith('.json')) return null;
        const state = splitSidecarFilename(relativePath);
        return state ? { kind: 'preset-state', dirKey, name: state.base, namespace: state.namespace }
            : { kind: 'preset', dirKey, name: relativePath.slice(0, -5) };
    }
    if (segments[1] !== 'v1') throw invalid(relativePath, 'unsupported version', 'PRESET_PROJECTION_UNSUPPORTED');
    const chunks = segments.slice(2, -1);
    if (segments.at(-1) !== 'value.json' || chunks.length === 0 || chunks.some((chunk, index) => !/^(?:[0-9a-f]{2})+$/.test(chunk) || chunk.length > 120 || (index < chunks.length - 1 && chunk.length !== 120))) throw invalid(relativePath, 'invalid canonical hex path');
    const hex = chunks.join('');
    let tuple;
    try { tuple = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'))); } catch {
        throw invalid(relativePath, 'invalid encoded identity');
    }
    if (!Array.isArray(tuple) || !tuple.every(value => typeof value === 'string') || tuple[1] !== dirKey || !((tuple[0] === 'preset' && tuple.length === 3) || (tuple[0] === 'preset-state' && tuple.length === 4))) throw invalid(relativePath, 'identity does not match category or record shape');
    if (Buffer.from(JSON.stringify(tuple)).toString('hex') !== hex) throw invalid(relativePath, 'identity is not canonically encoded');
    return tuple[0] === 'preset' ? { kind: 'preset', dirKey, name: tuple[2] }
        : { kind: 'preset-state', dirKey, name: tuple[2], namespace: tuple[3] };
}

/** Keep a legacy component only when its published inverse is this exact tuple. */
export function encodePresetRecordRelativePath(record) {
    const filename = record.kind === 'preset' ? `${record.name}.json` : buildSidecarFilename(record.name, record.namespace);
    if (safeSegment(filename) && Buffer.byteLength(filename) <= 255) {
        const decoded = decodePresetRecordRelativePath(record.dirKey, filename);
        if (decoded && presetRecordIdentity(decoded) === presetRecordIdentity(record)) return filename;
    }
    const hex = Buffer.from(presetRecordIdentity(record)).toString('hex');
    return `${PRESET_RECORDS_DIRECTORY}/v1/${hex.match(/.{1,120}/g).join('/')}/value.json`;
}
