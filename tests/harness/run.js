#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const JEST_BIN = path.join(TESTS_DIR, 'node_modules/jest/bin/jest.js');
const JEST_CONFIG = path.join(TESTS_DIR, 'jest.config.json');
const PLAYWRIGHT_CLI = path.join(TESTS_DIR, 'node_modules/playwright/cli.js');
const PLAYWRIGHT_CONFIG = path.join(TESTS_DIR, 'playwright.config.js');

const PROFILES = Object.freeze({
    unit: { framework: 'jest', project: 'unit', requirements: [] },
    'storage-local': { framework: 'jest', project: 'storage-local', requirements: [] },
    'storage-sql': { framework: 'jest', project: 'storage-sql', requirements: ['databases'] },
    e2e: { framework: 'playwright', project: 'e2e', requirements: ['browser'] },
    frontend: { framework: 'playwright', project: 'frontend', requirements: ['browser'] },
    desktop: { framework: 'playwright', project: 'desktop', requirements: ['desktop-source'] },
    'desktop-packaged': { framework: 'playwright', project: 'desktop-packaged', requirements: ['desktop-artifact'] },
    compatibility: { framework: 'playwright', project: 'compatibility', requirements: ['browser'], requiresInput: true },
});

export function parseRunnerArgs(argv) {
    const parsed = {
        profile: null,
        framework: null,
        files: [],
        list: false,
        json: false,
        input: null,
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
        if (arg === '--profile') parsed.profile = readValue('--profile');
        else if (arg.startsWith('--profile=')) parsed.profile = arg.slice('--profile='.length);
        else if (arg === '--framework') parsed.framework = readValue('--framework');
        else if (arg.startsWith('--framework=')) parsed.framework = arg.slice('--framework='.length);
        else if (arg === '--file') parsed.files.push(readValue('--file'));
        else if (arg.startsWith('--file=')) parsed.files.push(arg.slice('--file='.length));
        else if (arg === '--input') parsed.input = readValue('--input');
        else if (arg.startsWith('--input=')) parsed.input = arg.slice('--input='.length);
        else if (arg.startsWith('-')) parsed.passthrough.push(arg);
        else parsed.files.push(arg);
    }
    if (!parsed.profile) {
        throw new TypeError('Test runner requires --profile <name>');
    }
    if (!Object.hasOwn(PROFILES, parsed.profile)) {
        throw new TypeError(`Unknown test profile: ${parsed.profile}`);
    }
    return parsed;
}

function normalizeSelectedFile(rawPath) {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('tests/')) return path.relative('tests', normalized);
    return normalized;
}

function validateCompatibilityInput(inputPath, profileName, profile) {
    if (profile.requiresInput) {
        if (!inputPath || !path.isAbsolute(inputPath)) {
            throw new TypeError(`Profile ${profileName} requires --input with an explicit absolute directory path`);
        }
        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
            throw new Error(`Profile ${profileName} --input path is not an existing directory: ${inputPath}`);
        }
        return fs.realpathSync(inputPath);
    }
    if (inputPath !== null) {
        throw new TypeError(`Profile ${profileName} does not accept --input`);
    }
    return null;
}

async function runPreflight(profile, compatibilityInput) {
    if (profile.requirements.includes('databases')) {
        const { preflightDatabases } = await import('./database.js');
        await preflightDatabases();
    }
    if (profile.requirements.includes('desktop-artifact')) {
        const { resolvePackagedDesktopArtifact } = await import('../e2e/_lib/desktop-artifact.js');
        resolvePackagedDesktopArtifact();
    }
    if (profile.requirements.includes('desktop-source')) {
        const { resolveSourceDesktopRuntime } = await import('../e2e/_lib/desktop-artifact.js');
        resolveSourceDesktopRuntime();
    }
    if (profile.requiresInput && !compatibilityInput) {
        throw new Error(`Profile ${profile.project} requires --input <absolute-directory>`);
    }
}

function spawnFramework(command, args, { cwd, env }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        let interruptedSignal = null;
        const forward = (signal) => {
            interruptedSignal = signal;
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        };
        const onSigint = () => forward('SIGINT');
        const onSigterm = () => forward('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
        const cleanup = () => {
            process.off('SIGINT', onSigint);
            process.off('SIGTERM', onSigterm);
        };
        child.once('error', (error) => { cleanup(); reject(error); });
        child.once('close', (code, signal) => {
            cleanup();
            const actualSignal = signal ?? interruptedSignal;
            if (actualSignal === 'SIGINT') resolve(130);
            else if (actualSignal === 'SIGTERM') resolve(143);
            else resolve(code ?? 1);
        });
    });
}

export async function runCli(argv = process.argv.slice(2)) {
    const options = parseRunnerArgs(argv);
    const profile = PROFILES[options.profile];
    if (options.framework && options.framework !== profile.framework) {
        throw new Error(`Profile ${options.profile} runs on ${profile.framework}, not ${options.framework}`);
    }

    const relFiles = options.files.map(normalizeSelectedFile);
    if (options.list) {
        const summary = {
            profile: options.profile,
            framework: profile.framework,
            requirements: profile.requirements,
        };
        const out = options.json
            ? JSON.stringify(summary, null, 2) + '\n'
            : `Profile: ${summary.profile}\nFramework: ${summary.framework}\n`;
        process.stdout.write(out);
        return 0;
    }

    const compatibilityInput = validateCompatibilityInput(options.input, options.profile, profile);
    await runPreflight(profile, compatibilityInput);

    const env = { ...process.env, LUKER_TEST_PROFILE: profile.project };
    if (compatibilityInput) env.LUKER_REAL_DATA_ROOT = compatibilityInput;

    if (profile.framework === 'jest') {
        const args = [
            '--experimental-vm-modules',
            JEST_BIN,
            '--config',
            JEST_CONFIG,
            '--selectProjects',
            profile.project,
        ];
        if (relFiles.length) args.push('--runTestsByPath', ...relFiles);
        args.push(...options.passthrough);
        return spawnFramework(process.execPath, args, { cwd: TESTS_DIR, env });
    }

    if (profile.project === 'desktop') env.PW_INCLUDE_DESKTOP = '1';
    if (profile.project === 'desktop-packaged') env.PW_INCLUDE_DESKTOP_PACKAGED = '1';
    const args = [
        PLAYWRIGHT_CLI,
        'test',
        '--config',
        PLAYWRIGHT_CONFIG,
        `--project=${profile.project}`,
        ...relFiles,
        ...options.passthrough,
    ];
    return spawnFramework(process.execPath, args, { cwd: TESTS_DIR, env });
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
