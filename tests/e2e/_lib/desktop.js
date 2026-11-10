// Launch the desktop shell (desktop-app/) under Playwright's Electron
// driver, so a spec drives the same window a user sees: the shell spawns
// the backend in-process, then swaps its loading page for the local URL.
//
// The shell reads two things from its launch: `--port=<n>` (the port to
// prefer) and `LUKER_DESKTOP_USER_DATA` (the branded data root to use
// instead of the real `~/Library/Application Support/Luker`). Both are
// what make a spec isolated from the developer's own install.

import { _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { reservePort } from './ports.js';
import { cloneDataDir, SCRATCH_ROOT } from './server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DESKTOP_APP_DIR = resolve(REPO_ROOT, 'desktop-app');

// `require('electron')` from inside desktop-app resolves to the absolute
// path of the installed binary; the root node_modules has no Electron.
const ELECTRON_EXECUTABLE = createRequire(resolve(DESKTOP_APP_DIR, 'package.json'))('electron');

// The packaged artifact carries the backend under its resources, so it is
// launched as a plain executable with no application directory.
const PACKAGED_APP_DIR = resolve(DESKTOP_APP_DIR, 'dist', 'mac-arm64', 'Luker.app');
const PACKAGED_EXECUTABLE = resolve(PACKAGED_APP_DIR, 'Contents', 'MacOS', 'Luker');
export const PACKAGED_RESOURCES_DIR = resolve(PACKAGED_APP_DIR, 'Contents', 'Resources');

// The shell loads a bundled file:// page first and swaps to the backend
// origin once the server announces it is up. `browserLaunch.hostname` is
// `auto`, so the host may be either loopback spelling.
const BACKEND_URL = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//;

// The shell's two terminal states: the backend came up, or it did not and
// the same window now renders the failure (a file:// loading page
// carrying `error`). A spec that expects a boot failure must be able to
// reach the second state, so both count as "settled".
function isSettled(url) {
    return BACKEND_URL.test(url.href) || (url.protocol === 'file:' && url.searchParams.has('error'));
}

/**
 * @param {{ scenarioId?: string, passPort?: boolean, port?: number|null, userData?: string|null, defaultUserData?: string|null, seed?: boolean, extraEnv?: Record<string, string>, packaged?: boolean, waitForSettle?: boolean, waitForWindow?: boolean }} [options]
 *   `passPort: false` leaves the port unpinned so the shell probes upward
 *   from its default (the "preferred port is taken" case). `userData`
 *   skips the seed clone, for specs that construct the data root themselves.
 *   `defaultUserData` isolates the pointer location and the default data
 *   root, so a spec can exercise the pointer without touching the real
 *   `~/Library/Application Support/Luker`; it clones the seed unless
 *   `seed: false`. `packaged: true` launches the built artifact instead of
 *   the checkout, so the app carries its own backend and takes no
 *   application directory. `extraEnv` overrides the child environment, for
 *   the settings a test has to vary per launch. `waitForSettle: false`
 *   returns as soon as the shell window exists, for a first navigation the
 *   test has to answer before it can reach the app (an authentication
 *   challenge, for example). `waitForWindow: false` leaves `page` null for
 *   a launch that is expected to quit before showing a window.
 * @returns {Promise<{ electronApp: object, page: object|null, baseURL: string|null, port: number|null, dataRoot: string, userData: string, defaultUserData: string|null, relaunch: () => Promise<void>, waitForExit: () => Promise<void>, close: () => Promise<void> }>}
 */
export async function launchLukerDesktop({ scenarioId = 'default', passPort = true, port = null, userData = null, defaultUserData = null, seed = true, extraEnv = {}, packaged = false, waitForSettle = true, waitForWindow = true } = {}) {
    const reservedPort = port ?? await reservePort('desktop');
    const resolvedUserData = defaultUserData ?? userData ?? resolve(SCRATCH_ROOT, `desktop-${scenarioId}-${reservedPort}`);
    if (!userData && seed !== false) {
        mkdirSync(resolvedUserData, { recursive: true });
        cloneDataDir(resolve(resolvedUserData, 'data'));
    }

    const handle = {
        electronApp: null,
        page: null,
        baseURL: null,
        port: null,
        dataRoot: resolve(resolvedUserData, 'data'),
        userData: resolvedUserData,
        defaultUserData: defaultUserData ?? null,
    };

    const open = async () => {
        const launchEnv = { ...process.env };
        if (defaultUserData) {
            delete launchEnv.LUKER_DESKTOP_USER_DATA;
            launchEnv.LUKER_DESKTOP_DEFAULT_USER_DATA = resolvedUserData;
        } else {
            launchEnv.LUKER_DESKTOP_USER_DATA = resolvedUserData;
        }
        Object.assign(launchEnv, extraEnv);
        const electronApp = await electron.launch({
            executablePath: packaged ? PACKAGED_EXECUTABLE : ELECTRON_EXECUTABLE,
            args: [...(packaged ? [] : [DESKTOP_APP_DIR]), ...(passPort ? [`--port=${reservedPort}`] : [])],
            env: launchEnv,
        });
        handle.electronApp = electronApp;
        if (!waitForWindow) {
            handle.page = null;
            handle.baseURL = null;
            handle.port = null;
            return;
        }
        const page = await electronApp.firstWindow();
        if (waitForSettle) {
            await page.waitForURL(u => isSettled(u), { timeout: 60_000 });
        }
        const actual = new URL(page.url());
        handle.page = page;
        if (BACKEND_URL.test(actual.href)) {
            handle.baseURL = actual.origin;
            handle.port = Number(actual.port);
        } else {
            handle.baseURL = null;
            handle.port = null;
        }
    };

    handle.relaunch = async () => {
        await handle.close({ removeData: false });
        await open();
    };

    handle.waitForExit = async () => {
        const electronApp = handle.electronApp;
        if (!electronApp) return;
        const child = electronApp.process();
        if (child.exitCode === null) {
            await new Promise((resolvePromise, rejectPromise) => {
                const timeout = setTimeout(
                    () => rejectPromise(new Error('Timed out waiting for the desktop app to exit.')),
                    60_000,
                );
                const finish = () => {
                    clearTimeout(timeout);
                    resolvePromise();
                };
                electronApp.once('close', finish);
                if (child.exitCode !== null) finish();
            });
        }
        handle.electronApp = null;
        handle.page = null;
        handle.baseURL = null;
        handle.port = null;
    };

    // The data root is a full clone of the seed tree, so a spec that leaves it
    // behind grows `tests/.e2e-scratch` by one data tree per run. Closing drops
    // it, except mid-relaunch, where the next open reuses the same directory.
    handle.close = async ({ removeData = true } = {}) => {
        const electronApp = handle.electronApp;
        if (electronApp) {
            handle.electronApp = null;
            await electronApp.close();
        }
        if (removeData && handle.userData.startsWith(SCRATCH_ROOT)) {
            rmSync(handle.userData, { recursive: true, force: true });
        }
    };

    await open();
    return handle;
}

/**
 * Launch the shell without Playwright's driver. A startup that is expected to
 * quit before showing a window cannot be attached to with `electron.launch`,
 * because the process is gone before the driver connects.
 * @param {{ defaultUserData: string, port?: number|null, extraEnv?: Record<string, string> }} options
 * @returns {{ child: import('node:child_process').ChildProcess, waitForExit: () => Promise<{ code: number|null, signal: string|null }> }}
 */
export function spawnLukerDesktop({ defaultUserData, port = null, extraEnv = {} }) {
    const env = { ...process.env };
    delete env.LUKER_DESKTOP_USER_DATA;
    env.LUKER_DESKTOP_DEFAULT_USER_DATA = defaultUserData;
    Object.assign(env, extraEnv);

    const child = spawn(ELECTRON_EXECUTABLE, [
        DESKTOP_APP_DIR,
        ...(port ? [`--port=${port}`] : []),
    ], { env, stdio: 'ignore' });

    const exited = new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(
            () => rejectPromise(new Error('Timed out waiting for the desktop app to exit.')),
            30_000,
        );
        child.once('error', (error) => {
            clearTimeout(timeout);
            rejectPromise(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolvePromise({ code, signal });
        });
    });

    return { child, waitForExit: () => exited };
}
