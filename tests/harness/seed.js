import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMap, parseDocument } from 'yaml';
import { failureGroup } from './resources/errors.js';

const defaultRoot = path.resolve(fileURLToPath(new URL('../../default/', import.meta.url)));
const settingsPath = 'default-user/settings.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);

function jsonValue(value, label, active = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!Array.isArray(value) && !mapping(value)) throw new TypeError(`Seed ${label} requires finite JSON values`);
    if (active.has(value)) throw new TypeError(`Seed ${label} contains a cycle`);
    active.add(value);
    const result = Array.isArray(value)
        ? Array.from(value, (child, index) => jsonValue(child, `${label}[${index}]`, active))
        : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child, `${label}.${key}`, active)]));
    active.delete(value);
    return result;
}

function overrides(value, label) {
    if (!mapping(value)) throw new TypeError(`Seed ${label} must be a mapping`);
    return jsonValue(value, label);
}

function fields(value, allowed, label) {
    if (!mapping(value)) throw new TypeError(`Seed ${label} must be a mapping`);
    for (const name of Object.keys(value)) if (!allowed.includes(name)) throw new TypeError(`Unknown seed ${label} field: ${name}`);
}

export function parseYamlConfigDocument(text, label = 'structured YAML config') {
    const document = parseDocument(text, { uniqueKeys: true, stringKeys: true });
    const errors = [...document.errors, ...document.warnings];
    if (errors.length) throw failureGroup(errors, `Invalid ${label}`);
    return document;
}

export function applyYamlChanges(document, changes, keyPath = []) {
    for (const [key, value] of Object.entries(changes)) {
        const nextPath = [...keyPath, key];
        if (mapping(value) && isMap(document.getIn(nextPath, true))) {
            applyYamlChanges(document, value, nextPath);
        } else {
            document.setIn(nextPath, value);
        }
    }
}

function merge(original, changes) {
    if (!mapping(original) || !mapping(changes)) return changes;
    return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(changes)])].map(key => [key,
        Object.hasOwn(changes, key) ? merge(Object.hasOwn(original, key) ? original[key] : undefined, changes[key]) : original[key],
    ]));
}

function absolute(value, label) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`Seed ${label} requires an explicit absolute path`);
    return path.resolve(value);
}

function relative(value) {
    if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError(`Seed target must be a safe relative path: ${value}`);
    return value;
}

function identity(filename, directory) {
    const stat = fs.lstatSync(filename);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || fs.realpathSync(filename) !== filename) throw new Error(`Symbolic or unsupported seed input: ${filename}`);
    return { path: filename, dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function verify(receipt, directory, label = 'input') {
    const current = identity(receipt.path, directory);
    if (current.dev !== receipt.dev || current.ino !== receipt.ino) throw new Error(`Seed ${label} identity changed: ${receipt.path}`);
}

function readSource(filename, kind, target, includeBytes = false) {
    const registered = identity(filename, false);
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const errors = [], pieces = [], digest = createHash('sha256');
    let length = 0;
    try {
        const stat = fs.fstatSync(descriptor);
        if (stat.dev !== registered.dev || stat.ino !== registered.ino) throw new Error(`Seed source changed before read: ${filename}`);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, buffer)) !== 0) {
            const bytes = buffer.subarray(0, read);
            digest.update(bytes);
            length += read;
            if (includeBytes) pieces.push(Buffer.from(bytes));
        }
        if (length !== fs.fstatSync(descriptor).size) throw new Error(`Seed source length changed during read: ${filename}`);
    } catch (error) { errors.push(error); }
    try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
    if (errors.length) throw failureGroup(errors, `Cannot read seed source: ${filename}`);
    return { ...registered, kind, target, length, sha256: digest.digest('hex'), ...(includeBytes ? { bytes: Buffer.concat(pieces) } : {}) };
}

function parseSource(source, parseValue) {
    try {
        const value = parseValue(source.bytes.toString('utf8'));
        if (!mapping(value)) throw new TypeError('root must be a mapping');
        return jsonValue(value, source.path);
    } catch (cause) { throw new Error(`Invalid seed input ${source.path}: ${cause.message}`, { cause }); }
}

function collect(root) {
    const directories = [], files = [];
    function walk(directory, target) {
        directories.push({ ...identity(directory, true), target });
        for (const name of fs.readdirSync(directory).sort()) {
            const filename = path.join(directory, name), relativePath = target ? target + '/' + name : name;
            const stat = fs.lstatSync(filename);
            if (stat.isDirectory()) walk(filename, relativePath);
            else files.push(readSource(filename, 'compatibility', relative(relativePath)));
        }
    }
    walk(root, '');
    return { directories, files };
}

/** Materialize declared input in a scope-owned directory; callers never clean it manually. */
export async function materializeSeed(scope, options = {}) {
    fields(options, ['fixture', 'configOverrides', 'settingsOverrides'], 'options');
    const fixture = options.fixture === undefined ? { kind: 'defaults' } : options.fixture;
    if (!mapping(fixture) || !['defaults', 'compatibility', 'owned'].includes(fixture.kind)) throw new TypeError('Seed fixture.kind must be defaults, compatibility or owned');
    fields(fixture, fixture.kind === 'defaults' ? ['kind', 'defaultsRoot', 'files'] : fixture.kind === 'owned' ? ['kind', 'defaultsRoot', 'directory'] : ['kind', 'defaultsRoot', 'root'], 'fixture');
    const configChanges = overrides(options.configOverrides === undefined ? {} : options.configOverrides, 'configOverrides');
    const settingsChanges = overrides(options.settingsOverrides === undefined ? {} : options.settingsOverrides, 'settingsOverrides');
    if (Object.hasOwn(configChanges, 'dataRoot')) throw new TypeError('Seed configOverrides.dataRoot cannot replace the managed dataRoot');
    const defaultsRoot = absolute(fixture.defaultsRoot === undefined ? defaultRoot : fixture.defaultsRoot, 'defaultsRoot');
    const roots = [identity(defaultsRoot, true)];
    const configSource = readSource(path.join(defaultsRoot, 'config.yaml'), 'config', 'config.yaml', true);
    let configDocument;
    parseSource(configSource, value => {
        configDocument = parseYamlConfigDocument(value, 'structured seed config');
        return configDocument.toJS();
    });
    applyYamlChanges(configDocument, configChanges);
    let sources = [configSource], directories = [], files = [], settings, verifiedData;
    if (fixture.kind === 'owned') {
        if (Object.keys(settingsChanges).length) throw new TypeError('Registered owned seed data does not accept settings overrides');
        verifiedData = await scope.verifyDirectory(fixture.directory);
    } else if (fixture.kind === 'compatibility') {
        const inputRoot = absolute(fixture.root, 'compatibility root');
        const input = collect(inputRoot);
        directories = input.directories;
        files = input.files;
        if (Object.keys(settingsChanges).length) {
            const original = files.find(file => file.target === settingsPath);
            if (!original) throw new Error(`Compatibility settings override requires ${path.join(inputRoot, settingsPath)}`);
            const parsed = readSource(original.path, 'compatibility', settingsPath, true);
            if (parsed.sha256 !== original.sha256) throw new Error(`Seed source changed before parsing: ${original.path}`);
            files[files.indexOf(original)] = parsed;
            settings = merge(parseSource(parsed, JSON.parse), settingsChanges);
        }
    } else {
        const original = readSource(path.join(defaultsRoot, 'content/settings.json'), 'settings', settingsPath, true);
        settings = merge(parseSource(original, JSON.parse), settingsChanges);
        files.push(original);
        const selected = fixture.files === undefined ? [] : fixture.files;
        if (!Array.isArray(selected)) throw new TypeError('Seed fixture.files must be an array');
        for (const file of selected) {
            fields(file, ['source', 'path'], 'fixture.files entry');
            const target = relative(file.path);
            if (target === settingsPath) throw new TypeError(`Seed fixture file conflicts with settingsOverrides: ${target}`);
            files.push(readSource(absolute(file.source, 'fixture source'), 'fixture', target));
        }
    }
    const targets = new Set();
    for (const file of files) {
        if (targets.has(file.target) || [...targets].some(target => target.startsWith(file.target + '/') || file.target.startsWith(target + '/'))) throw new Error(`Conflicting seed file target: ${file.target}`);
        targets.add(file.target);
    }
    sources = sources.concat(files);
    const owned = await scope.directory('materialized seed');
    const targetRoot = { path: owned.path, dev: owned.dev, ino: owned.ino };
    verify(targetRoot, true, 'target');
    if (verifiedData) verify(verifiedData, true, 'owned data');
    roots.concat(directories).forEach(directory => verify(directory, true));
    sources.forEach(source => verify(source, false));
    for (const source of sources) if (source.bytes) {
        const current = readSource(source.path, source.kind, source.target);
        if (current.length !== source.length || current.sha256 !== source.sha256) throw new Error(`Seed source changed before materialization: ${source.path}`);
    }
    const dataOwner = fixture.kind === 'owned' ? verifiedData : owned;
    const dataRoot = fixture.kind === 'owned' ? dataOwner.path : path.join(targetRoot.path, 'data');
    const configPath = path.join(targetRoot.path, 'config.yaml');
    const manifestPath = path.join(targetRoot.path, 'seed-manifest.json');
    if (fixture.kind !== 'owned') fs.mkdirSync(dataRoot, { mode: 0o700 });
    for (const directory of directories) if (directory.target) fs.mkdirSync(path.join(dataRoot, directory.target), { recursive: true, mode: 0o700 });
    const outputs = [];
    for (const source of files) {
        const target = path.join(dataRoot, source.target);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (source.target === settingsPath && settings !== undefined) fs.writeFileSync(target, JSON.stringify(settings, null, 4) + '\n', { flag: 'wx', mode: 0o600 });
        else {
            fs.copyFileSync(source.path, target, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(target, source.mode & 0o111 ? 0o700 : 0o600);
        }
        const output = readSource(target, 'output', source.target);
        if (!(source.target === settingsPath && settings !== undefined) && (output.length !== source.length || output.sha256 !== source.sha256)) throw new Error(`Seed source changed during copy: ${source.path}`);
        outputs.push({ path: 'data/' + source.target, length: output.length, sha256: output.sha256 });
    }
    configDocument.setIn(['dataRoot'], dataRoot);
    const configBytes = Buffer.from(configDocument.toString());
    fs.writeFileSync(configPath, configBytes, { flag: 'wx', mode: 0o600 });
    outputs.push({ path: 'config.yaml', length: configBytes.length, sha256: hash(configBytes) });
    const manifest = { format: 'test-seed-v1', fixture: fixture.kind, sources: sources.map(source => ({ path: source.path, kind: source.kind, target: source.target, length: source.length, sha256: source.sha256 })), outputs };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { dataRoot, configPath, manifestPath, owner: owned, dataOwner };
}
