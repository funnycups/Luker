import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('./coverage-map.json', import.meta.url), 'utf8'));

const engines = ['fs', 'sqlite', 'mysql', 'postgres'];
const frameworks = ['node', 'jest', 'playwright'];
const resourceKinds = ['directory', 'process', 'network', 'browser', 'database', 'embedded-database'];
const fixtureKinds = ['browser-application', 'managed-native', 'storage-contract', 'explicit-module-environment'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
const names = values => Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;

function freeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
freeze(catalog);

/** Select declared coverage without importing runners, applications or resource providers. */
export function getProfile(name, options = {}) {
    if (typeof name !== 'string' || !Object.hasOwn(catalog.profiles, name)) throw new TypeError(`Unknown test profile: ${name}`);
    if (!record(options)) throw new TypeError(`Profile ${name} options must be a mapping`);
    for (const key of Object.keys(options)) if (key !== 'files') throw new TypeError(`Unknown profile ${name} option: ${key}`);
    const policy = catalog.profiles[name];
    const available = catalog.files.filter(entry => entry.profiles.includes(name));
    let entries = available;
    if (Object.hasOwn(options, 'files')) {
        if (!names(options.files) || !options.files.length) throw new TypeError(`Empty or invalid selection for profile ${name}`);
        for (const filename of options.files) if (!available.some(entry => entry.path === filename)) throw new Error(`Test ${filename} is not declared in profile ${name}`);
        const selected = new Set(options.files);
        entries = available.filter(entry => selected.has(entry.path));
    }
    const allowedBackends = policy.backends === undefined ? engines : policy.backends;
    const backends = engines.filter(engine => allowedBackends.includes(engine) && entries.some(entry => entry.backends.includes(engine)));
    const actualFrameworks = frameworks.filter(framework => entries.some(entry => entry.framework === framework));
    const requiredDatabases = ['mysql', 'postgres'].filter(engine => policy.requiredDatabases.includes(engine) || backends.includes(engine));
    return freeze({
        name,
        diagnosticSlot: name,
        files: entries.map(entry => entry.path),
        contracts: entries,
        frameworks: actualFrameworks,
        backends,
        requiredDatabases,
        requirements: [...new Set([...policy.requirements, ...requiredDatabases.map(engine => 'database:' + engine), ...(entries.some(entry => entry.resources.includes('browser')) ? ['browser'] : [])])],
        missingFrameworks: policy.requiredFrameworks.filter(framework => !available.some(entry => entry.framework === framework)),
        ...(policy.input ? { input: policy.input } : {}),
    });
}

/** Compare observed entry contracts with an explicit migration inventory. */
export function validateCoverageMap(files, mapping) {
    if (!Array.isArray(files)) throw new TypeError('Coverage files must be an array');
    const errors = [];
    const report = () => ({ valid: errors.length === 0, files: files.length, errors });
    if (!record(mapping) || mapping.format !== 'test-coverage-map-v1' || !record(mapping.profiles) || !Object.keys(mapping.profiles).length || !Array.isArray(mapping.files)) {
        errors.push('Invalid test coverage map format/profiles/files');
        return report();
    }
    if (!files.length) { errors.push('Empty observed test inventory'); return report(); }
    if (!mapping.files.length) errors.push('Coverage map declares no test files');
    for (const [name, profile] of Object.entries(mapping.profiles)) {
        if (!record(profile) || !names(profile.requiredFrameworks) || profile.requiredFrameworks.some(value => !frameworks.includes(value)) || !names(profile.requiredDatabases) || profile.requiredDatabases.some(value => !['mysql', 'postgres'].includes(value)) || !names(profile.requirements)) errors.push(`Invalid policy for profile ${name}`);
        else if (profile.backends !== undefined && (!names(profile.backends) || profile.backends.some(value => !engines.includes(value)))) errors.push(`Invalid backend selection for profile ${name}`);
    }
    const declared = new Map();
    for (const entry of mapping.files) {
        if (typeof entry?.path !== 'string' || !entry.path.startsWith('tests/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) { errors.push(`Invalid coverage entry path: ${entry?.path}`); continue; }
        if (declared.has(entry.path)) errors.push(`Duplicate coverage entry: ${entry.path}`);
        else declared.set(entry.path, entry);
        if (!frameworks.includes(entry.framework) || !fixtureKinds.includes(entry.fixture) || !names(entry.profiles) || !entry.profiles.length || entry.profiles.some(name => !Object.hasOwn(mapping.profiles, name))) errors.push(`Invalid framework/profile/fixture declaration: ${entry.path}`);
        if (!names(entry.backends) || entry.backends.some(value => !engines.includes(value)) || !names(entry.resources) || entry.resources.some(value => !resourceKinds.includes(value))) errors.push(`Invalid backend/resource declaration: ${entry.path}`);
        if (!names(entry.behaviors) || !entry.behaviors.length) errors.push(`Invalid behavior contract: ${entry.path}`);
        if (entry.backendMatrix && (!record(entry.backendMatrix) || !names(entry.backends) || !names(entry.backendMatrix.sources) || !names(entry.backendMatrix.destinations) || [...entry.backendMatrix.sources, ...entry.backendMatrix.destinations].some(value => !entry.backends.includes(value)))) errors.push(`Invalid backend matrix: ${entry.path}`);
    }
    const observed = new Set();
    for (const input of files) {
        const file = typeof input === 'string' ? { path: input } : input;
        if (typeof file?.path !== 'string') throw new TypeError('Observed coverage files require a path');
        if (observed.has(file.path)) errors.push(`Duplicate observed file: ${file.path}`);
        observed.add(file.path);
        const entry = declared.get(file.path);
        if (!entry) { errors.push(`Unmapped test file: ${file.path}`); continue; }
        for (const field of ['backends', 'behaviors', 'resources', 'profiles']) {
            if (file[field] === undefined) continue;
            if (!names(file[field])) throw new TypeError(`Observed ${file.path} has invalid ${field}`);
            if (!names(entry[field])) continue;
            for (const value of file[field]) if (!entry[field].includes(value)) errors.push(`Omitted ${field} ${value}: ${file.path}`);
        }
        if (file.framework !== undefined && file.framework !== entry.framework) errors.push(`Framework changed: ${file.path}`);
        if (file.fixture !== undefined && file.fixture !== entry.fixture) errors.push(`Fixture changed: ${file.path}`);
        if (file.backendMatrix !== undefined) for (const axis of ['sources', 'destinations']) {
            if (!record(file.backendMatrix) || !names(file.backendMatrix[axis])) throw new TypeError(`Observed ${file.path} has invalid backend matrix`);
            if (!record(entry.backendMatrix) || !names(entry.backendMatrix[axis]) || file.backendMatrix[axis].some(engine => !entry.backendMatrix[axis].includes(engine))) errors.push(`Omitted backend matrix ${axis}: ${file.path}`);
        }
    }
    for (const filename of declared.keys()) if (!observed.has(filename)) errors.push(`Coverage entry has no observed test file: ${filename}`);
    return report();
}
