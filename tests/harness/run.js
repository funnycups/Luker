#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getProfile } from './profiles.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const JEST_BIN = path.join(TESTS_DIR, 'node_modules/jest/bin/jest.js');
const JEST_CONFIG = path.join(TESTS_DIR, 'jest.config.json');
const PLAYWRIGHT_CLI = path.join(TESTS_DIR, 'node_modules/playwright/cli.js');
const PLAYWRIGHT_CONFIG = path.join(TESTS_DIR, 'playwright.config.js');

const VALID_FRAMEWORKS = new Set(['node', 'jest', 'playwright']);

export function parseRunnerArgs(argv) {
    const parsed = {
        profile: null,
        framework: null,
        files: [],
        list: false,
        json: false,
        input: null,
        exportEnvironment: null,
        passthrough: [],
    };
    let afterSeparator = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (afterSeparator) {
            parsed.passthrough.push(arg);
            continue;
        }
        if (arg === '--') {
            afterSeparator = true;
            continue;
        }
        if (arg === '--list') {
            parsed.list = true;
            continue;
        }
        if (arg === '--json') {
            parsed.json = true;
            continue;
        }
        const readValue = (flag) => {
            if (i + 1 >= argv.length) throw new TypeError(`Missing value for ${flag}`);
            i += 1;
            return argv[i];
        };
        if (arg === '--profile') {
            parsed.profile = readValue('--profile');
        } else if (arg.startsWith('--profile=')) {
            parsed.profile = arg.slice('--profile='.length);
        } else if (arg === '--framework') {
            parsed.framework = readValue('--framework');
        } else if (arg.startsWith('--framework=')) {
            parsed.framework = arg.slice('--framework='.length);
        } else if (arg === '--file') {
            parsed.files.push(readValue('--file'));
        } else if (arg.startsWith('--file=')) {
            parsed.files.push(arg.slice('--file='.length));
        } else if (arg === '--input') {
            parsed.input = readValue('--input');
        } else if (arg.startsWith('--input=')) {
            parsed.input = arg.slice('--input='.length);
        } else if (arg === '--export-environment') {
            parsed.exportEnvironment = readValue('--export-environment');
        } else if (arg.startsWith('--export-environment=')) {
            parsed.exportEnvironment = arg.slice('--export-environment='.length);
        } else if (arg.startsWith('-')) {
            // Forward unrecognized flags (e.g. from `npm run test:unit -- --maxWorkers=3`)
            // as passthrough runner arguments.
            parsed.passthrough.push(arg);
        } else {
            parsed.files.push(arg);
        }
    }
    if (!parsed.profile) {
        throw new TypeError('Managed test runner requires --profile <name>');
    }
    if (parsed.framework !== null && !VALID_FRAMEWORKS.has(parsed.framework)) {
        throw new TypeError(`Unknown test framework filter: ${parsed.framework}`);
    }
    return parsed;
}

function normalizeSelectedFile(rawPath) {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('tests/')) return normalized;
    const fromTests = path.relative(REPO_ROOT, path.resolve(TESTS_DIR, normalized)).replace(/\\/g, '/');
    if (fromTests.startsWith('tests/')) return fromTests;
    return normalized;
}

function validateExportEnvironmentPath(destination) {
    if (typeof destination !== 'string' || !destination || !path.isAbsolute(destination)) {
        throw new TypeError(`--export-environment requires an explicit absolute destination path: ${destination}`);
    }
    if (fs.existsSync(destination)) {
        throw new Error(`--export-environment destination already exists: ${destination}`);
    }
}

function validateCompatibilityInput(inputPath, profile) {
    if (profile.input?.required) {
        if (!inputPath || !path.isAbsolute(inputPath)) {
            throw new TypeError(`Profile ${profile.name} requires --input with an explicit absolute directory path`);
        }
        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
            throw new Error(`Profile ${profile.name} --input path is not an existing directory: ${inputPath}`);
        }
        return fs.realpathSync(inputPath);
    }
    if (inputPath !== null) {
        throw new TypeError(`Profile ${profile.name} does not accept --input`);
    }
    return null;
}

async function runPreflight(profile, compatibilityInput) {
    if (profile.missingFrameworks.length > 0) {
        throw new Error(
            `Profile ${profile.name} is missing required framework coverage: ${profile.missingFrameworks.join(', ')}`,
        );
    }
    if (profile.requiredDatabases.length > 0) {
        const { preflightDatabases } = await import('./database.js');
        await preflightDatabases();
    }
    if (profile.requirements.includes('desktop-artifact')) {
        const { resolvePackagedDesktopArtifact } = await import('../e2e/_lib/desktop.js');
        resolvePackagedDesktopArtifact();
    }
    if (profile.requirements.includes('desktop-source')) {
        const { resolveSourceDesktopRuntime } = await import('../e2e/_lib/desktop.js');
        resolveSourceDesktopRuntime();
    }
    if (profile.input?.required && !compatibilityInput) {
        throw new Error(`Profile ${profile.name} requires --input <absolute-directory>`);
    }
}

function spawnFramework(command, args, { cwd, env }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        let interruptedSignal = null;
        const forward = (signal) => {
            interruptedSignal = signal;
            if (child.exitCode === null && child.signalCode === null) {
                child.kill(signal);
            }
        };
        const onSigint = () => forward('SIGINT');
        const onSigterm = () => forward('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
        const cleanupListeners = () => {
            process.off('SIGINT', onSigint);
            process.off('SIGTERM', onSigterm);
        };
        child.once('error', (error) => {
            cleanupListeners();
            reject(error);
        });
        child.once('close', (code, signal) => {
            cleanupListeners();
            const actualSignal = signal ?? interruptedSignal;
            if (actualSignal === 'SIGINT') resolve(130);
            else if (actualSignal === 'SIGTERM') resolve(143);
            else resolve(code ?? 1);
        });
    });
}

function buildFrameworkPlan(profile, options, compatibilityInput) {
    const selectedFiles = options.files.length > 0;
    const contracts = options.framework
        ? profile.contracts.filter(entry => entry.framework === options.framework)
        : profile.contracts;
    const activeFrameworks = ['node', 'jest', 'playwright'].filter(fw =>
        contracts.some(entry => entry.framework === fw),
    );
    const multiFramework = activeFrameworks.length > 1;
    const steps = [];

    for (const fw of activeFrameworks) {
        const fwFiles = contracts.filter(entry => entry.framework === fw).map(entry => entry.path);
        const relToTests = fwFiles.map(file => path.relative('tests', file));
        const env = {
            ...process.env,
            LUKER_TEST_PROFILE: profile.diagnosticSlot,
        };
        if (options.exportEnvironment) {
            env.LUKER_EXPORT_ENVIRONMENT = options.exportEnvironment;
        } else {
            delete env.LUKER_EXPORT_ENVIRONMENT;
        }
        if (compatibilityInput) {
            env.LUKER_REAL_DATA_ROOT = compatibilityInput;
        }

        if (fw === 'node') {
            const extra = multiFramework ? [] : options.passthrough;
            steps.push({
                framework: 'node',
                command: process.execPath,
                args: ['--test', ...relToTests, ...extra],
                cwd: TESTS_DIR,
                env,
            });
        } else if (fw === 'jest') {
            const args = [
                '--experimental-vm-modules',
                JEST_BIN,
                '--config',
                JEST_CONFIG,
                '--selectProjects',
                profile.diagnosticSlot,
            ];
            if (selectedFiles) {
                args.push('--runTestsByPath', ...relToTests);
            }
            args.push(...options.passthrough);
            steps.push({
                framework: 'jest',
                command: process.execPath,
                args,
                cwd: TESTS_DIR,
                env,
            });
        } else if (fw === 'playwright') {
            if (profile.diagnosticSlot === 'desktop') env.PW_INCLUDE_DESKTOP = '1';
            if (profile.diagnosticSlot === 'desktop-packaged') env.PW_INCLUDE_DESKTOP_PACKAGED = '1';
            const args = [
                PLAYWRIGHT_CLI,
                'test',
                '--config',
                PLAYWRIGHT_CONFIG,
                `--project=${profile.diagnosticSlot}`,
            ];
            if (selectedFiles) {
                args.push(...relToTests);
            }
            args.push(...options.passthrough);
            steps.push({
                framework: 'playwright',
                command: process.execPath,
                args,
                cwd: TESTS_DIR,
                env,
            });
        }
    }
    return steps;
}

async function writeStdout(text) {
    await new Promise((resolve, reject) => {
        process.stdout.write(text, error => (error ? reject(error) : resolve()));
    });
}

export async function runCli(argv = process.argv.slice(2)) {
    const options = parseRunnerArgs(argv);
    const normalizedFiles = options.files.map(normalizeSelectedFile);
    const profile = getProfile(
        options.profile,
        normalizedFiles.length > 0 ? { files: normalizedFiles } : {},
    );

    if (options.list) {
        const contracts = options.framework
            ? profile.contracts.filter(entry => entry.framework === options.framework)
            : profile.contracts;
        const summary = {
            profile: profile.name,
            diagnosticSlot: profile.diagnosticSlot,
            frameworks: ['node', 'jest', 'playwright'].filter(fw => contracts.some(e => e.framework === fw)),
            missingFrameworks: profile.missingFrameworks,
            backends: profile.backends,
            requiredDatabases: profile.requiredDatabases,
            requirements: profile.requirements,
            ...(profile.input ? { input: profile.input } : {}),
            files: contracts.map(entry => entry.path),
        };
        if (options.json) {
            await writeStdout(JSON.stringify(summary, null, 2) + '\n');
        } else {
            const lines = [
                `Profile: ${summary.profile} (slot: ${summary.diagnosticSlot})`,
                `Frameworks: ${summary.frameworks.join(', ') || 'none'}`,
                ...(summary.backends.length ? [`Backends: ${summary.backends.join(', ')}`] : []),
                ...(summary.requirements.length ? [`Requirements: ${summary.requirements.join(', ')}`] : []),
                ...summary.files.map(file => `  ${file}`),
            ];
            await writeStdout(lines.join('\n') + '\n');
        }
        return 0;
    }

    if (options.exportEnvironment !== null) {
        validateExportEnvironmentPath(options.exportEnvironment);
    }
    const compatibilityInput = validateCompatibilityInput(options.input, profile);
    await runPreflight(profile, compatibilityInput);

    const steps = buildFrameworkPlan(profile, options, compatibilityInput);
    if (!steps.length) {
        throw new Error(`No test files selected for profile ${profile.name}${options.framework ? ` (framework ${options.framework})` : ''}`);
    }
    if (options.exportEnvironment && steps.length > 1) {
        throw new Error(`--export-environment requires a single framework invocation; select --framework or --file for profile ${profile.name}`);
    }

    for (const step of steps) {
        const exitCode = await spawnFramework(step.command, step.args, {
            cwd: step.cwd,
            env: step.env,
        });
        if (exitCode !== 0) return exitCode;
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli().then(
        code => { process.exitCode = code; },
        error => {
            console.error(error?.message ?? error);
            process.exitCode = 1;
        },
    );
}
