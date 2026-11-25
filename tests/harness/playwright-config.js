import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contains } from './resources/registry.js';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const managedReporter = fileURLToPath(new URL('./playwright-reporter.js', import.meta.url));

function commandLineOptions() {
    const options = { projects: [], disableDependencies: false };
    for (let index = 2; index < process.argv.length; index++) {
        const argument = process.argv[index];
        if (argument === '--') break;
        if (argument === '--no-deps') { options.disableDependencies = true; continue; }
        if (argument === '--project' || argument.startsWith('--project=')) {
            options.projects.push(argument === '--project' ? process.argv[++index] : argument.slice(10));
            while (index + 1 < process.argv.length && !process.argv[index + 1].startsWith('-')) options.projects.push(process.argv[++index]);
        }
        for (const name of ['output', 'reporter']) {
            if (argument === '--' + name) options[name] = process.argv[++index];
            else if (argument.startsWith('--' + name + '=')) options[name] = argument.slice(name.length + 3);
        }
    }
    return options;
}

export function selectedProjects(config) {
    const options = commandLineOptions();
    if (!options.projects.length) return config.projects;
    const patterns = options.projects.map(name => new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));
    const selected = new Set(config.projects.filter(project => patterns.some(pattern => pattern.test(project.name))));
    if (!options.disableDependencies) {
        const named = new Map(config.projects.map(project => [project.name, project]));
        for (const project of selected) for (const name of [...project.dependencies, ...(project.teardown ? [project.teardown] : [])]) selected.add(named.get(name));
    }
    return [...selected];
}

function reporterDirectory(defaultName, configDir, configured) {
    if (configured) return path.resolve(configDir, configured);
    let directory = configDir;
    for (;;) {
        try { fs.statSync(path.join(directory, 'package.json')); return path.join(directory, defaultName); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(directory);
        if (parent === directory) return path.resolve(process.cwd(), defaultName);
        directory = parent;
    }
}

function reporterTargets(reporters, configDir) {
    const targets = [];
    for (const [name, options = {}] of reporters) {
        if (name === 'html') {
            const environment = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || process.env.PLAYWRIGHT_HTML_REPORT;
            targets.push(environment ? path.resolve(environment) : reporterDirectory('playwright-report', configDir, options.outputFolder));
        } else if (['blob', 'json', 'junit'].includes(name)) {
            const prefix = 'PLAYWRIGHT_' + name.toUpperCase() + '_OUTPUT_';
            const environmentFile = process.env[prefix + 'FILE'];
            if (environmentFile || options.outputFile) { targets.push(path.resolve(environmentFile ? process.cwd() : configDir, environmentFile || options.outputFile)); continue; }
            const environmentDirectory = process.env[prefix + 'DIR'];
            const directory = environmentDirectory ? path.resolve(environmentDirectory) : options.outputDir ? path.resolve(configDir, options.outputDir) : name === 'blob' ? reporterDirectory('blob-report', configDir) : configDir;
            if (name === 'blob') targets.push(directory);
            const filename = process.env[prefix + 'NAME'] ?? options.fileName;
            if (filename) targets.push(path.resolve(directory, filename));
        }
    }
    return targets;
}

function canonical(filename) {
    const tail = [];
    let parent = filename;
    for (;;) {
        try { return path.join(fs.realpathSync(parent), ...tail); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            tail.unshift(path.basename(parent)); parent = path.dirname(parent);
        }
    }
}

function absolute(filename, label) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.resolve(filename) !== filename) throw new TypeError(`${label} must be an absolute normalized path: ${filename}`);
    return filename;
}

/** Read-only admission before the native runner clears its configured output. */
export function validateResourcePaths(config, configDir) {
    const root = absolute(config.metadata?.resourceProjectRoot ?? repository, 'Browser resourceProjectRoot');
    if (fs.realpathSync(root) !== root) throw new Error(`Browser resourceProjectRoot is not a real directory: ${root}`);
    const managed = canonical(path.join(root, 'test-results', 'harness'));
    const options = commandLineOptions();
    const override = options.output;
    const outputs = (config.projects ?? [{}]).map(project => {
        const selected = override ?? project.outputDir ?? config.outputDir ?? 'test-results';
        if (typeof selected !== 'string' || !selected) throw new TypeError('Browser outputDir must be a nonempty path');
        return canonical(path.resolve(override === undefined ? configDir : process.cwd(), selected));
    });
    for (const output of outputs) if (contains(output, managed) || contains(managed, output)) throw new Error(`Native browser output overlaps the managed resource namespace: ${output}`);
    if (config.metadata?.resourceReportPath !== undefined) {
        const report = canonical(absolute(config.metadata.resourceReportPath, 'Browser resourceReportPath'));
        if (contains(report, managed) || contains(managed, report)) throw new Error(`Native browser report overlaps the managed resource namespace: ${report}`);
    }
    const configuredReporters = options.reporter ? options.reporter.split(',').map(name => [name]) : typeof config.reporter === 'string' ? [[config.reporter]] : config.reporter ?? [];
    for (const target of reporterTargets(configuredReporters, configDir)) {
        const report = canonical(target);
        if (contains(report, managed) || contains(managed, report)) throw new Error(`Native browser reporter output overlaps the managed resource namespace: ${report}`);
    }
    const reporterBase = options.reporter ? process.cwd() : configDir;
    if (!configuredReporters.some(([name]) => canonical(path.resolve(reporterBase, name)) === canonical(managedReporter))) throw new Error(`Managed browser configuration requires its managed reporter: ${managedReporter}; declare format reporters alongside it`);
    return config;
}

export function defineManagedConfig(config, configFile) {
    return validateResourcePaths(config, path.dirname(absolute(configFile, 'Browser config file')));
}
