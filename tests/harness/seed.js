import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, parseDocument } from 'yaml';
import { failureGroup } from './resources/errors.js';

const defaultRoot = path.resolve(fileURLToPath(new URL('../../default/', import.meta.url)));
const settingsRelPath = 'default-user/settings.json';
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);

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

function deepMerge(original, changes) {
    if (!mapping(original) || !mapping(changes)) return changes;
    const keys = new Set([...Object.keys(original), ...Object.keys(changes)]);
    const merged = {};
    for (const key of keys) {
        merged[key] = Object.hasOwn(changes, key)
            ? deepMerge(Object.hasOwn(original, key) ? original[key] : undefined, changes[key])
            : original[key];
    }
    return merged;
}

function copyTree(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyTree(src, dest);
        } else if (entry.isFile()) {
            fs.copyFileSync(src, dest);
        }
    }
}

function validateRelativeTarget(value) {
    if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')
        || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new TypeError(`Seed target must be a safe relative path: ${value}`);
    }
    return value;
}

/** Materialize declared input in a scope-owned directory. */
export async function materializeSeed(scope, options = {}) {
    const fixture = options.fixture ?? { kind: 'defaults' };
    if (!mapping(fixture) || !['defaults', 'compatibility', 'owned'].includes(fixture.kind)) {
        throw new TypeError('Seed fixture.kind must be defaults, compatibility or owned');
    }
    const configChanges = options.configOverrides ?? {};
    const settingsChanges = options.settingsOverrides ?? {};
    if (Object.hasOwn(configChanges, 'dataRoot')) {
        throw new TypeError('Seed configOverrides.dataRoot cannot replace the managed dataRoot');
    }

    const defaultsRoot = path.resolve(fixture.defaultsRoot ?? defaultRoot);
    const configDocument = parseYamlConfigDocument(
        fs.readFileSync(path.join(defaultsRoot, 'config.yaml'), 'utf8'),
        'structured seed config',
    );
    applyYamlChanges(configDocument, configChanges);

    const owned = await scope.directory('materialized seed');
    let dataOwner = owned;
    let dataRoot = path.join(owned.path, 'data');

    if (fixture.kind === 'owned') {
        if (Object.keys(settingsChanges).length) {
            throw new TypeError('Registered owned seed data does not accept settings overrides');
        }
        dataOwner = await scope.verifyDirectory(fixture.directory);
        dataRoot = dataOwner.path;
    } else if (fixture.kind === 'compatibility') {
        if (typeof fixture.root !== 'string' || !path.isAbsolute(fixture.root)) {
            throw new TypeError('Seed compatibility root requires an explicit absolute path');
        }
        copyTree(path.resolve(fixture.root), dataRoot);
        if (Object.keys(settingsChanges).length) {
            const targetSettings = path.join(dataRoot, settingsRelPath);
            if (!fs.existsSync(targetSettings)) {
                throw new Error(`Compatibility settings override requires ${targetSettings}`);
            }
            const parsed = JSON.parse(fs.readFileSync(targetSettings, 'utf8'));
            fs.writeFileSync(targetSettings, JSON.stringify(deepMerge(parsed, settingsChanges), null, 4) + '\n');
        }
    } else {
        fs.mkdirSync(dataRoot, { recursive: true });
        const defaultSettings = JSON.parse(fs.readFileSync(path.join(defaultsRoot, 'content/settings.json'), 'utf8'));
        const mergedSettings = deepMerge(defaultSettings, settingsChanges);
        const settingsDest = path.join(dataRoot, settingsRelPath);
        fs.mkdirSync(path.dirname(settingsDest), { recursive: true });
        fs.writeFileSync(settingsDest, JSON.stringify(mergedSettings, null, 4) + '\n');

        for (const file of fixture.files ?? []) {
            const target = validateRelativeTarget(file.path);
            if (target === settingsRelPath) {
                throw new TypeError(`Seed fixture file conflicts with settingsOverrides: ${target}`);
            }
            const dest = path.join(dataRoot, target);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.resolve(file.source), dest);
        }
    }

    const configPath = path.join(owned.path, 'config.yaml');
    const manifestPath = path.join(owned.path, 'seed-manifest.json');
    configDocument.setIn(['dataRoot'], dataRoot);
    fs.writeFileSync(configPath, configDocument.toString());
    fs.writeFileSync(manifestPath, JSON.stringify({ format: 'test-seed-v1', fixture: fixture.kind, dataRoot, configPath }, null, 2) + '\n');
    return { dataRoot, configPath, manifestPath, owner: owned, dataOwner };
}
