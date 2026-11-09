import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { replaceRunningAppImage } from './appimage-update.js';
import { createHttpAuthController, HttpAuthStore } from './http-auth.js';
import { detectInstallFlavour } from './install-flavour.js';
import { hidesOnClose, usesTray, devtoolsShortcutFor } from './window-behaviour.js';

// Electron's main process exposes V8's WebAssembly but not the streaming
// compile helpers, which live at the Blink layer in Chromium. Emscripten-built
// wasm codecs probe `instantiateStreaming` to pick their load path; without it
// they fall through to a synchronous read that the same glue only defines for
// web and worker targets, so every decode aborts and the image pipelines that
// depend on them (thumbnails, average-color sampling) fail for jpeg and webp.
// Restore the standard semantics on top of the non-streaming primitives.
if (typeof WebAssembly.instantiateStreaming !== 'function') {
    WebAssembly.instantiateStreaming = async (source, importObject) => {
        const response = await source;
        const bytes = await response.arrayBuffer();
        const module = await WebAssembly.compile(bytes);
        return { module, instance: await WebAssembly.instantiate(module, importObject) };
    };
}

const DEFAULT_PORT = 8000;
// Probe window for a free port, matching the range the mobile shells use.
const PORT_PROBE_COUNT = 50;

app.setName('Luker');

// The backend tree lives next to this file in a checkout and under the app's
// resources once installed. Resolve it once and route every backend path
// through it, so both layouts share a single root.
const backendRoot = process.env.LUKER_BACKEND_ROOT
    || (app.isPackaged ? path.join(process.resourcesPath, 'luker') : path.resolve(import.meta.dirname, '..'));

// A packaged tree ships the frontend bundles pre-compiled; point the backend
// at them so it skips its in-process compile. An explicit setting wins.
if (!process.env.LUKER_PREBUILT_BUNDLES_DIR) {
    const prebuiltBundles = path.join(backendRoot, '_prebuilt-bundles');
    if (fs.existsSync(prebuiltBundles)) {
        process.env.LUKER_PREBUILT_BUNDLES_DIR = prebuiltBundles;
    }
}

function readPreferredPort(argv) {
    const prefix = '--port=';
    for (const arg of argv) {
        if (!arg.startsWith(prefix)) {
            continue;
        }
        const parsed = Number.parseInt(arg.slice(prefix.length), 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
            return parsed;
        }
    }
    return DEFAULT_PORT;
}

const preferredPort = readPreferredPort(process.argv);

const userData = process.env.LUKER_DESKTOP_USER_DATA || app.getPath('userData');
if (process.env.LUKER_DESKTOP_USER_DATA) {
    app.setPath('userData', userData);
}

const httpAuthStore = new HttpAuthStore(path.join(userData, 'http-auth.json'));

const UPDATE_PROGRESS_CHANNEL = 'luker:update-progress';

const updatesDirectory = path.join(userData, 'updates');

// The update prompt hands the downloaded installer to the OS, which owns it
// from there on, so the copy under the data root is only a staging file. A
// launch clears whatever an earlier run left behind.
fs.rmSync(updatesDirectory, { recursive: true, force: true });

// The renderer can only name the asset; the main process fetches it over the
// network and writes it under the data root. Streamed through a counting
// transform so the renderer sees `{ received, total }` while it downloads.
async function downloadUpdate(url, destination, onProgress) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`The update download failed (HTTP ${response.status}).`);
    }
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            onProgress(received, total);
            callback(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destination));
}

// The renderer cannot read the filesystem, so the shell resolves how it was
// installed once at startup and hands that answer over on request.
const installFlavour = detectInstallFlavour({
    appImagePath: process.env.APPIMAGE,
    packageTypePath: path.join(process.resourcesPath, 'package-type'),
    isPackaged: app.isPackaged,
});

ipcMain.on('luker:install-flavour', (event) => {
    event.returnValue = installFlavour;
});

// The preload bridge is attached to the window, not to a page, so a page from
// another origin loaded into that window can reach these channels too. Both of
// them act on the machine rather than on the page, and the window is allowed to
// leave the app on purpose, so the sender frame has to prove it is the app.
function assertAppFrame(event, action) {
    const frame = event.senderFrame;
    if (!backendOrigin) {
        throw new Error(`${action} was requested before the app page was ready.`);
    }
    if (!frame || frame.isDestroyed()) {
        throw new Error(`${action} was requested by a frame that is no longer available.`);
    }
    let frameOrigin = null;
    try {
        frameOrigin = new URL(frame.url).origin;
    } catch {
        throw new Error(`${action} was requested by a frame without a usable address.`);
    }
    if (frameOrigin !== backendOrigin) {
        throw new Error(`${action} was requested by a page outside the app.`);
    }
}

ipcMain.handle('luker:external-link-policy', (event, enabled) => {
    assertAppFrame(event, 'The external link setting');
    openExternalLinksInBrowser = enabled !== false;
});

ipcMain.handle('luker:install-update', async (event, payload) => {
    assertAppFrame(event, 'The update download');

    const rawUrl = String(payload?.url || '');
    const updateUrl = new URL(rawUrl);
    if (updateUrl.protocol !== 'http:' && updateUrl.protocol !== 'https:') {
        throw new Error(`Refusing to download an update from a non-HTTP URL: ${rawUrl}`);
    }

    const name = path.basename(String(payload?.name || ''));
    if (!name || name === '.' || name === '..') {
        throw new Error(`The update download has no usable file name: ${String(payload?.name || '')}`);
    }

    fs.mkdirSync(updatesDirectory, { recursive: true });
    const finalPath = path.join(updatesDirectory, name);
    const partialPath = `${finalPath}.part`;

    try {
        await downloadUpdate(updateUrl.href, partialPath, (received, total) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send(UPDATE_PROGRESS_CHANNEL, { received, total });
            }
        });
        fs.renameSync(partialPath, finalPath);
    } catch (error) {
        fs.rmSync(partialPath, { force: true });
        throw error;
    }

    // A self-contained bundle runs from a mount, so the download is put in
    // place of the file this process was started from rather than handed to the
    // OS. The renderer's progress dialog reports the saved path; the user
    // restarts the app to run the replacement.
    if (installFlavour === 'appimage') {
        await replaceRunningAppImage({ appImagePath: process.env.APPIMAGE, downloadPath: finalPath });
    } else if (process.env.LUKER_DESKTOP_SKIP_OPEN_INSTALLER !== '1') {
        // The e2e harness sets this so a test run never hands a file to the real
        // OS installer.
        await shell.openPath(finalPath);
    }

    return { path: finalPath };
});

// The backend is imported into this process, so a crash during module
// evaluation would otherwise leave no trace anywhere. Tee both streams to a
// file under the data directory until the server reports that it is up.
const logPath = path.join(userData, 'data', 'luker-boot.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, callback) => {
    fs.appendFileSync(logPath, chunk);
    return originalStdoutWrite(chunk, encoding, callback);
};

process.stderr.write = (chunk, encoding, callback) => {
    fs.appendFileSync(logPath, chunk);
    return originalStderrWrite(chunk, encoding, callback);
};

function stopTeeingLogs() {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
}

// The backend reports an unrecoverable startup problem in three ways, and all
// three have to reach the window instead of leaving it on the starting page:
// a rejection out of the module graph, a `process.exit()` raised while the
// backend is still booting, and an unhandled rejection from the boot chain
// src/server-main.js starts without attaching a catch. The last two end the
// process by default, which closes the window and takes the explanation with
// it, so while startup is in flight both are converted into a reported
// failure. Outside that window they are left untouched.
let backendStarting = false;
let bootFailure = null;
let reportBootFailure = () => {};

const nativeExit = process.exit.bind(process);

process.exit = (code) => {
    if (backendStarting) {
        reportStartupFailure(`The backend exited during startup (exit code ${code}).`);
        return;
    }
    return nativeExit(code);
};

function reportStartupFailure(error) {
    if (!backendStarting || bootFailure !== null) {
        return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    bootFailure = message;
    console.error(`Luker failed to start: ${message}`);
    reportBootFailure(message);
    return true;
}

const onUnhandledRejection = (reason) => {
    reportStartupFailure(reason);
};

const onUncaughtException = (error) => {
    reportStartupFailure(error);
};

function stopWatchingStartup() {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
}

function probePort(port) {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            } else {
                reject(err);
            }
        });
        probe.listen({ host: '127.0.0.1', port }, () => {
            probe.close(() => resolve(true));
        });
    });
}

async function pickPort(preferred) {
    for (let offset = 0; offset < PORT_PROBE_COUNT; offset++) {
        const port = preferred + offset;
        if (await probePort(port)) {
            return port;
        }
    }
    throw new Error(`no free port between ${preferred} and ${preferred + PORT_PROBE_COUNT - 1}`);
}

async function startBackend(win, locale, port) {
    const configPath = path.join(userData, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        fs.copyFileSync(path.resolve(backendRoot, 'default', 'config.yaml'), configPath);
    }

    const serverJs = path.resolve(backendRoot, 'server.js');

    process.argv = [
        process.execPath,
        serverJs,
        `--port=${port}`,
        `--dataRoot=${path.join(userData, 'data')}`,
        `--configPath=${configPath}`,
        `--serverPluginsPath=${path.join(userData, 'plugins')}`,
        `--globalExtensionsPath=${path.join(userData, 'extensions', 'third-party')}`,
        '--browserLaunchEnabled=false',
        `--backupsPath=${path.join(userData, 'backups')}`,
    ];

    // The import below never settles once the server is listening, so the
    // listener has to be attached before it runs.
    backendStarting = true;
    bootFailure = null;
    reportBootFailure = (message) => {
        win.loadFile('loading.html', { query: { locale, error: message, logPath } })
            .catch((err) => console.error('Failed to render the startup failure:', err));
    };
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    // The emitter has to be the exact module instance the backend imports,
    // which is the one under the resolved backend root. A static import would
    // resolve against this file's own directory instead.
    const { EVENT_NAMES, serverEvents } = await import(
        pathToFileURL(path.resolve(backendRoot, 'src', 'server-events.js')).href
    );

    serverEvents.once(EVENT_NAMES.SERVER_STARTED, ({ url }) => {
        // The server is up, so the startup window is over either way. A
        // failure reported earlier stands and the window keeps showing it.
        const failed = bootFailure !== null;
        backendStarting = false;
        stopWatchingStartup();
        stopTeeingLogs();
        if (!failed) {
            backendOrigin = url.origin;
            win.loadURL(url.toString());
        }
    });

    try {
        await import(pathToFileURL(serverJs).href);
    } catch (err) {
        reportStartupFailure(err);
    }
}

// Chromium hands `window.open` and `target="_blank"` targets to the embedder,
// and the default is a bare BrowserWindow with no address bar and no way back;
// an in-page link would likewise navigate the app window away from the UI.
// While the external link setting is on, anything outside the app's own origin
// goes to the system browser and the window keeps showing Luker. A request that
// carries its own dimensions is a popup whose page talks back to its opener, so
// it opens as a child of the app window instead.
let backendOrigin = null;

// The renderer pushes the user setting down after it loads; until then the
// shell keeps the product default so a link clicked in the first moments
// still goes to the browser.
let openExternalLinksInBrowser = true;

function isAppUrl(rawUrl) {
    if (!backendOrigin) {
        return false;
    }
    try {
        return new URL(rawUrl).origin === backendOrigin;
    } catch {
        return false;
    }
}

// Only http(s) has a meaningful "open in the browser" destination; blob:,
// data:, about:blank and file: are page content the app has to keep.
function isExternalHttpUrl(rawUrl) {
    try {
        const { protocol } = new URL(rawUrl);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function shouldOpenInSystemBrowser(rawUrl, currentUrl) {
    if (isOffAppPage(currentUrl)) {
        return false;
    }
    return openExternalLinksInBrowser && !isAppUrl(rawUrl) && isExternalHttpUrl(rawUrl);
}

// A page outside the app origin is a session the window admitted on purpose —
// a server redirect into a sign-in page, for instance. Its own form posts and
// links belong to that session, and the app page is already off screen, so
// handing them to the browser would break the session mid-way. An empty or
// unknown current URL means the app page, which keeps the ordinary decision.
function isOffAppPage(currentUrl) {
    if (!backendOrigin || !currentUrl) {
        return false;
    }
    try {
        const parsed = new URL(currentUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        return parsed.origin !== backendOrigin;
    } catch {
        return false;
    }
}

function openInSystemBrowser(rawUrl) {
    // The e2e harness sets this so a test run never launches a real browser.
    if (process.env.LUKER_DESKTOP_SKIP_OPEN_EXTERNAL === '1') {
        const opened = globalThis.__lukerExternalOpens ?? (globalThis.__lukerExternalOpens = []);
        opened.push(rawUrl);
        return;
    }
    shell.openExternal(rawUrl);
}

// A popup sized by the page opens inside the space the app window occupies.
// `features` is Chromium's `window.open` feature list: a comma-separated set of
// `name=value` pairs, where only the two dimensions matter here.
function popupWindowOptions(win, features) {
    const requested = new Map();
    for (const part of features.split(',')) {
        const [name, value] = part.split('=');
        const size = Number.parseInt(value, 10);
        if (name && Number.isInteger(size) && size > 0) {
            requested.set(name.trim(), size);
        }
    }
    const bounds = win.getContentBounds();
    return {
        parent: win,
        width: Math.min(requested.get('width') ?? 800, bounds.width),
        height: Math.min(requested.get('height') ?? 640, bounds.height),
        autoHideMenuBar: true,
    };
}

function routeExternalNavigation(win) {
    const contents = win.webContents;

    contents.setWindowOpenHandler((details) => {
        if (details.disposition === 'new-window') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: popupWindowOptions(win, details.features),
            };
        }
        // A form post that opens a new window carries its body in the
        // window-open request; the system browser only receives a URL, so
        // handing it over would drop the body and break the session.
        if (details.postBody) {
            return { action: 'allow' };
        }
        if (!shouldOpenInSystemBrowser(details.url)) {
            return { action: 'allow' };
        }
        openInSystemBrowser(details.url);
        return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
        if (!shouldOpenInSystemBrowser(url, contents.getURL())) {
            return;
        }
        event.preventDefault();
        openInSystemBrowser(url);
    });
}

// The shell draws a few labels of its own, outside the renderer: the tray menu
// and the macOS application menu. It carries its own copy of the loading
// page's locale table so those follow the system locale too.
const SHELL_STRINGS = {
    en: {
        showWindow: 'Show Luker',
        openDataDirectory: 'Open data directory',
        quit: 'Quit Luker',
        trayHint: 'Luker keeps running in the notification area. Quit from its menu when you are done.',
        httpAuthTitle: 'Sign in required',
        httpAuthMessage: 'This endpoint requires HTTP Basic authentication before Luker can load.',
        httpAuthEndpoint: 'Endpoint: %s',
        httpAuthRealm: 'Realm: %s',
        httpAuthUsername: 'Username',
        httpAuthPassword: 'Password',
        httpAuthLogin: 'Sign In',
        httpAuthCancel: 'Cancel',
    },
    'zh-CN': {
        showWindow: '显示 Luker',
        openDataDirectory: '打开数据目录',
        quit: '退出 Luker',
        trayHint: 'Luker 仍在通知区域运行，结束时请从托盘菜单退出。',
        httpAuthTitle: '需要登录',
        httpAuthMessage: '此端点启用了 HTTP Basic 认证，Luker 需要先完成账号密码验证后才能载入。',
        httpAuthEndpoint: '端点：%s',
        httpAuthRealm: '认证域：%s',
        httpAuthUsername: '用户名',
        httpAuthPassword: '密码',
        httpAuthLogin: '登录',
        httpAuthCancel: '取消',
    },
    'zh-TW': {
        showWindow: '顯示 Luker',
        openDataDirectory: '開啟資料目錄',
        quit: '結束 Luker',
        trayHint: 'Luker 仍在通知區域執行，結束時請從托盤選單結束。',
        httpAuthTitle: '需要登入',
        httpAuthMessage: '此端點啟用了 HTTP Basic 驗證，Luker 需要先完成帳號密碼驗證後才能載入。',
        httpAuthEndpoint: '端點：%s',
        httpAuthRealm: '驗證領域：%s',
        httpAuthUsername: '使用者名稱',
        httpAuthPassword: '密碼',
        httpAuthLogin: '登入',
        httpAuthCancel: '取消',
    },
};

function pickShellStrings(locale) {
    if (Object.prototype.hasOwnProperty.call(SHELL_STRINGS, locale)) {
        return SHELL_STRINGS[locale];
    }
    const lower = String(locale || '').toLowerCase();
    if (lower.startsWith('zh')) {
        if (lower.includes('tw') || lower.includes('hk') || lower.includes('hant')) {
            return SHELL_STRINGS['zh-TW'];
        }
        return SHELL_STRINGS['zh-CN'];
    }
    return SHELL_STRINGS.en;
}

// Where the platform keeps an entry point back into the app, closing the
// window hides it instead of destroying it. The backend runs in this process,
// so quitting on close would end any generation in flight; only a real quit
// takes the window down. Elsewhere the close is let through, because a hidden
// window with no way back leaves the app running and unreachable.
let quitting = false;
let tray = null;
let trayHintShown = false;

function showMainWindow(win) {
    if (win.isDestroyed()) {
        return;
    }
    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.focus();
}

function openDataDirectory() {
    // The e2e harness sets this so a test run never launches a file manager.
    if (process.env.LUKER_DESKTOP_SKIP_OPEN_DATA_DIR === '1') {
        const opened = globalThis.__lukerDataDirectoryOpens ?? (globalThis.__lukerDataDirectoryOpens = []);
        opened.push(userData);
        return;
    }
    return shell.openPath(userData);
}

function createTray(win, strings) {
    tray = new Tray(nativeImage.createFromPath(path.join(import.meta.dirname, 'tray-icon.png')));
    tray.setToolTip('Luker');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: strings.showWindow, click: () => showMainWindow(win) },
        { label: strings.openDataDirectory, click: openDataDirectory },
        { type: 'separator' },
        { label: strings.quit, click: () => app.quit() },
    ]));
    tray.on('click', () => showMainWindow(win));
}

function installApplicationMenu(strings) {
    // macOS keeps an application menu, because its Edit roles carry the
    // clipboard accelerators. Electron's default menu does not take new items,
    // so the template below mirrors it and adds the data directory command to
    // the app menu, where macOS puts application-level commands.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { label: strings.openDataDirectory, click: openDataDirectory },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ]));
}

function showHttpAuthDialog({ parent, host, port, realm, prefill }, strings) {
    return new Promise((resolve) => {
        const dialog = new BrowserWindow({
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            modal: true,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            width: 420,
            height: 380,
            title: strings.httpAuthTitle,
            webPreferences: {
                preload: path.join(import.meta.dirname, 'http-auth-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            ipcMain.removeListener('luker:http-auth:submit', onSubmit);
            ipcMain.removeListener('luker:http-auth:cancel', onCancel);
            if (!dialog.isDestroyed()) {
                dialog.destroy();
            }
            resolve(value);
        };
        const onSubmit = (event, payload) => {
            if (event.sender !== dialog.webContents) {
                return;
            }
            finish({
                username: String(payload?.username ?? ''),
                password: String(payload?.password ?? ''),
            });
        };
        const onCancel = (event) => {
            if (event.sender !== dialog.webContents) {
                return;
            }
            finish(null);
        };
        ipcMain.on('luker:http-auth:submit', onSubmit);
        ipcMain.on('luker:http-auth:cancel', onCancel);
        dialog.on('closed', () => finish(null));
        dialog.webContents.on('did-finish-load', () => {
            dialog.show();
            dialog.focus();
            dialog.webContents.send('luker:http-auth:context', {
                username: prefill?.username ?? '',
                password: prefill?.password ?? '',
                endpointText: strings.httpAuthEndpoint.replace('%s', `${host}:${port}`),
                realmText: realm.length > 0 ? strings.httpAuthRealm.replace('%s', realm) : '',
                strings: {
                    title: strings.httpAuthTitle,
                    message: strings.httpAuthMessage,
                    usernameHint: strings.httpAuthUsername,
                    passwordHint: strings.httpAuthPassword,
                    login: strings.httpAuthLogin,
                    cancel: strings.httpAuthCancel,
                },
            });
        });
        dialog.loadFile('http-auth.html').catch((error) => {
            console.error('Failed to open the HTTP authentication dialog:', error);
            finish(null);
        });
    });
}

app.whenReady().then(async () => {
    // Electron installs a default application menu, which Windows and Linux
    // draw as an in-window bar the shell has no use for. macOS keeps its own,
    // because the standard Edit roles there also carry the clipboard
    // accelerators.
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
    }

    const locale = app.getLocale();
    const strings = pickShellStrings(locale);
    const win = new BrowserWindow({
        width: 1024,
        height: 768,
        webPreferences: {
            preload: path.join(import.meta.dirname, 'preload.js'),
            // A hidden window is throttled by default, which would slow the
            // renderer's timers and animations down while the app runs hidden.
            // Leaving the page unthrottled matches what hiding does on macOS on
            // its own, so every platform behaves the same way.
            backgroundThrottling: false,
        },
    });
    routeExternalNavigation(win);

    const httpAuth = createHttpAuthController({
        store: httpAuthStore,
        prompt: (request) => showHttpAuthDialog(request, strings),
    });
    app.on('login', (event, contents, _details, authInfo, callback) => {
        // Proxy authentication is outside the endpoint credentials the shell
        // manages, so the proxy keeps whatever handling Electron gives it.
        if (authInfo.isProxy) {
            return;
        }
        event.preventDefault();
        const owner = contents ? BrowserWindow.fromWebContents(contents) : null;
        httpAuth.handle(authInfo, callback, owner || win);
    });
    win.webContents.on('did-finish-load', () => httpAuth.resetAttempts());

    // macOS keeps an application menu that already binds the devtools toggle,
    // so the handler would race it. Only the menu-less platforms get one.
    if (process.platform !== 'darwin') {
        win.webContents.on('before-input-event', (event, input) => {
            if (devtoolsShortcutFor(process.platform, input) === 'toggle') {
                event.preventDefault();
                win.webContents.toggleDevTools();
            }
        });
    }

    win.on('close', (event) => {
        if (quitting || !hidesOnClose(process.platform)) {
            return;
        }
        event.preventDefault();
        win.hide();
        // Windows tucks new tray icons into its overflow area, so the first
        // close tells the user where the app went.
        if (usesTray(process.platform) && !trayHintShown) {
            trayHintShown = true;
            tray.displayBalloon({ title: 'Luker', content: strings.trayHint });
        }
    });

    if (usesTray(process.platform)) {
        createTray(win, strings);
    } else if (process.platform === 'darwin') {
        installApplicationMenu(strings);
    }

    app.on('activate', () => showMainWindow(win));

    await win.loadFile('loading.html', { query: { locale } });

    try {
        const port = await pickPort(preferredPort);
        await startBackend(win, locale, port);
    } catch (err) {
        if (bootFailure === null) {
            await win.loadFile('loading.html', {
                query: { locale, error: String(err?.message || err), logPath },
            });
        }
    }
});

app.on('before-quit', () => {
    // Lets the window's close handler through, so a real quit destroys the
    // window and the process can exit.
    quitting = true;
    backendStarting = false;
    stopWatchingStartup();
    stopTeeingLogs();
});
