import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { replaceRunningAppImage } from './appimage-update.js';
import {
    POINTER_VERSION,
    checkFreeSpace,
    classifyDataTarget,
    classifyRecoveryTarget,
    directoryIdentity,
    finishPendingCleanup as finishCleanup,
    migrateDataDirectory,
    resolveLocation,
    validateWritableDirectory,
    writeLocationState,
} from './data-location.js';
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

// The data directory is resolved before Electron touches its user data. The
// pointer lives in the default directory, so the chosen directory can move
// without leaving a record inside itself. Both paths are set before `ready`
// so Chromium's session storage follows the same root.
const defaultUserData = process.env.LUKER_DESKTOP_DEFAULT_USER_DATA || app.getPath('userData');
const launchArgs = process.argv.slice(1);
if (process.env.LUKER_DESKTOP_DEFAULT_USER_DATA) {
    app.setPath('userData', defaultUserData);
    app.setPath('sessionData', defaultUserData);
}
const location = resolveLocation({
    defaultUserData,
    envUserData: process.env.LUKER_DESKTOP_USER_DATA || null,
});
prepareLocation(location);
const userData = location.error ? defaultUserData : location.activeUserData;
app.setPath('userData', userData);
app.setPath('sessionData', userData);

function sameDirectory(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function prepareLocation(current) {
    if (current.error) {
        return current;
    }
    const directory = current.activeUserData;
    if (sameDirectory(directory, current.defaultUserData) || current.locked) {
        try {
            fs.mkdirSync(directory, { recursive: true });
        } catch (error) {
            current.error = { code: 'target-not-writable', path: directory, message: error.message };
            return current;
        }
    } else if (!fs.existsSync(directory)) {
        current.error = { code: 'target-missing', path: directory };
        return current;
    }
    let stats;
    try {
        stats = fs.statSync(directory);
    } catch (error) {
        current.error = { code: 'target-missing', path: directory, message: error.message };
        return current;
    }
    if (!stats.isDirectory()) {
        current.error = { code: 'target-not-directory', path: directory };
        return current;
    }
    try {
        validateWritableDirectory(directory);
    } catch (error) {
        current.error = { code: 'target-not-writable', path: directory, message: error.message };
    }
    return current;
}

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

const httpAuthStore = new HttpAuthStore(path.join(userData, 'http-auth.json'));

const UPDATE_PROGRESS_CHANNEL = 'luker:update-progress';

const updatesDirectory = path.join(userData, 'updates');

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

ipcMain.handle('luker:get-data-directory', (event) => {
    assertAppFrame(event, 'The data directory setting');
    return {
        path: location.error ? location.error.path || location.activeUserData : location.activeUserData,
        defaultPath: defaultUserData,
        locked: Boolean(process.env.LUKER_DESKTOP_USER_DATA),
        pendingCleanup: Boolean(location.state?.pendingDeleteFrom),
    };
});

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
// file under the data directory until the server reports that it is up. The
// tee starts only once the window is ready, so a location error or a migration
// session does not write into a directory that is not the active one.
const logPath = path.join(userData, 'data', 'luker-boot.log');
let originalStdoutWrite = null;
let originalStderrWrite = null;

function startLogTee() {
    if (originalStdoutWrite) {
        return;
    }
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, encoding, callback) => {
        fs.appendFileSync(logPath, chunk);
        return originalStdoutWrite(chunk, encoding, callback);
    };
    process.stderr.write = (chunk, encoding, callback) => {
        fs.appendFileSync(logPath, chunk);
        return originalStderrWrite(chunk, encoding, callback);
    };
}

function stopTeeingLogs() {
    if (!originalStdoutWrite) {
        return;
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    originalStdoutWrite = null;
    originalStderrWrite = null;
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
        if (!failed && location.state?.pendingDeleteFrom) {
            finishPendingCleanup().catch((error) => {
                console.error('Failed to remove the old data directory:', error);
            });
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
        locationErrorTitle: "Luker can't open its data folder",
        locationPointerError: 'Luker could not read its data location record.',
        locationTargetMissing: 'The data folder does not exist: %s',
        locationTargetUnwritable: 'Luker cannot write to the data folder: %s',
        locationTargetNotDirectory: 'The data folder is not a folder: %s',
        locationRetry: 'Retry',
        locationChoose: 'Choose Another Folder…',
        locationQuit: 'Quit',
        locationOpenFolder: 'Open Folder',
        locationOk: 'OK',
        chooseDataDirectoryTitle: 'Choose a data folder',
        dataDirectoryInvalid: 'Choose an empty folder or an existing Luker data folder.',
        dataDirectoryNotWritable: 'Luker cannot write to that folder.',
        dataDirectoryNoSpace: 'The folder does not have enough free space.',
        dataDirectorySame: 'That is the current data folder.',
        moveConfirmTitle: 'Move Luker data?',
        moveConfirmMessage: 'Luker will move its data to %s and restart. The current data folder will be emptied.',
        adoptConfirmTitle: 'Use this data folder?',
        adoptConfirmMessage: 'Luker will use the existing data in %s and restart. The current data folder stays in place. The chosen folder is used exclusively by Luker.',
        moveConfirmButton: 'Move and Restart',
        adoptConfirmButton: 'Use and Restart',
        cancel: 'Cancel',
        emptyStartConfirmTitle: 'Start with an empty data folder?',
        emptyStartConfirmMessage: 'Luker will use %s as an empty data folder. Existing data in the old folder stays in place.',
        moveFailedTitle: 'Luker could not move its data',
        moveFailedMessage: 'Luker could not move its data to %s.',
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
        locationErrorTitle: 'Luker 无法打开数据目录',
        locationPointerError: 'Luker 无法读取数据位置记录。',
        locationTargetMissing: '数据目录不存在：%s',
        locationTargetUnwritable: 'Luker 无法写入数据目录：%s',
        locationTargetNotDirectory: '数据目录不是文件夹：%s',
        locationRetry: '重试',
        locationChoose: '重新选择目录……',
        locationQuit: '退出',
        locationOpenFolder: '打开所在文件夹',
        locationOk: '确定',
        chooseDataDirectoryTitle: '选择数据目录',
        dataDirectoryInvalid: '请选择空目录或已有的 Luker 数据目录。',
        dataDirectoryNotWritable: 'Luker 无法写入该目录。',
        dataDirectoryNoSpace: '该目录的可用空间不足。',
        dataDirectorySame: '该目录就是当前数据目录。',
        moveConfirmTitle: '移动 Luker 数据？',
        moveConfirmMessage: 'Luker 会把数据迁移到 %s 并重启。当前数据目录会被清空。',
        adoptConfirmTitle: '使用该数据目录？',
        adoptConfirmMessage: 'Luker 会使用 %s 中的现有数据并重启。当前数据目录保持不变。所选目录由 Luker 独占。',
        moveConfirmButton: '迁移并重启',
        adoptConfirmButton: '使用并重启',
        cancel: '取消',
        emptyStartConfirmTitle: '从空的数据目录开始？',
        emptyStartConfirmMessage: 'Luker 会把 %s 作为空的数据目录。旧目录中的现有数据保持不变。',
        moveFailedTitle: 'Luker 无法迁移数据',
        moveFailedMessage: 'Luker 无法把数据迁移到 %s。',
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
        locationErrorTitle: 'Luker 無法開啟資料目錄',
        locationPointerError: 'Luker 無法讀取資料位置記錄。',
        locationTargetMissing: '資料目錄不存在：%s',
        locationTargetUnwritable: 'Luker 無法寫入資料目錄：%s',
        locationTargetNotDirectory: '資料目錄不是資料夾：%s',
        locationRetry: '重試',
        locationChoose: '重新選擇目錄……',
        locationQuit: '結束',
        locationOpenFolder: '開啟所在資料夾',
        locationOk: '確定',
        chooseDataDirectoryTitle: '選擇資料目錄',
        dataDirectoryInvalid: '請選擇空目錄或既有的 Luker 資料目錄。',
        dataDirectoryNotWritable: 'Luker 無法寫入該目錄。',
        dataDirectoryNoSpace: '該目錄的可用空間不足。',
        dataDirectorySame: '該目錄就是目前資料目錄。',
        moveConfirmTitle: '移動 Luker 資料？',
        moveConfirmMessage: 'Luker 會把資料遷移到 %s 並重新啟動。目前資料目錄會被清空。',
        adoptConfirmTitle: '使用該資料目錄？',
        adoptConfirmMessage: 'Luker 會使用 %s 中的現有資料並重新啟動。目前資料目錄保持不變。所選目錄由 Luker 獨占。',
        moveConfirmButton: '遷移並重新啟動',
        adoptConfirmButton: '使用並重新啟動',
        cancel: '取消',
        emptyStartConfirmTitle: '從空的資料目錄開始？',
        emptyStartConfirmMessage: 'Luker 會把 %s 作為空的資料目錄。舊目錄中的現有資料保持不變。',
        moveFailedTitle: 'Luker 無法遷移資料',
        moveFailedMessage: 'Luker 無法把資料遷移到 %s。',
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

function relaunchApp() {
    if (process.env.LUKER_DESKTOP_TEST_NO_RELAUNCH === '1') {
        app.quit();
        return;
    }
    app.relaunch({ args: launchArgs });
    app.quit();
}

function locationErrorDetail(error, strings) {
    switch (error?.code) {
        case 'pointer-invalid':
            return strings.locationPointerError;
        case 'target-missing':
            return strings.locationTargetMissing.replace('%s', error.path || '');
        case 'target-not-directory':
            return strings.locationTargetNotDirectory.replace('%s', error.path || '');
        case 'target-not-writable':
            return strings.locationTargetUnwritable.replace('%s', error.path || '');
        default:
            return error?.message || String(error);
    }
}

async function confirmRecovery(strings, title, message) {
    if (process.env.LUKER_DESKTOP_TEST_LOCATION_CONFIRM === '1') {
        return true;
    }
    return confirmDialog(null, title, message, strings.adoptConfirmButton, strings.cancel);
}

async function chooseRecoveryDirectory(current, strings) {
    let chosen = process.env.LUKER_DESKTOP_TEST_LOCATION_DIRECTORY || null;
    if (!chosen) {
        const result = await dialog.showOpenDialog({
            title: strings.chooseDataDirectoryTitle,
            defaultPath: app.getPath('home'),
            properties: process.platform === 'darwin'
                ? ['openDirectory', 'createDirectory']
                : ['openDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) {
            return false;
        }
        chosen = result.filePaths[0];
    }
    const target = path.resolve(chosen);
    let stats;
    try {
        stats = fs.statSync(target);
    } catch {
        stats = null;
    }
    if (stats && !stats.isDirectory()) {
        await showDialogMessage(null, strings, strings.dataDirectoryInvalid, target);
        return false;
    }
    if (!stats) {
        try {
            fs.mkdirSync(target, { recursive: true });
        } catch (error) {
            await showDialogMessage(null, strings, strings.dataDirectoryInvalid, error.message);
            return false;
        }
    }
    let classified;
    try {
        classified = classifyRecoveryTarget(target, { defaultUserData: current.defaultUserData });
    } catch (error) {
        await showDialogMessage(null, strings, strings.dataDirectoryInvalid, error.message);
        return false;
    }
    if (classified.mode === 'reject') {
        const { message, detail } = formatDialogError(strings, classified.reason, target);
        await showDialogMessage(null, strings, message, detail);
        return false;
    }
    try {
        validateWritableDirectory(target);
    } catch (error) {
        await showDialogMessage(null, strings, strings.dataDirectoryNotWritable, error.message);
        return false;
    }
    const confirmed = classified.mode === 'adopt'
        ? await confirmRecovery(
            strings,
            strings.adoptConfirmTitle,
            strings.adoptConfirmMessage.replace('%s', target),
        )
        : await confirmRecovery(
            strings,
            strings.emptyStartConfirmTitle,
            strings.emptyStartConfirmMessage.replace('%s', target),
        );
    if (!confirmed) {
        return false;
    }
    writeLocationState(current.pointerPath, { version: POINTER_VERSION, userData: target });
    relaunchApp();
    return true;
}

async function showLocationError(current, strings) {
    const pointerError = current.error?.code === 'pointer-invalid';
    const buttons = pointerError
        ? [strings.locationOpenFolder, strings.locationChoose, strings.locationQuit]
        : [strings.locationRetry, strings.locationChoose, strings.locationQuit];
    const testChoice = process.env.LUKER_DESKTOP_TEST_LOCATION_DIALOG;
    while (true) {
        let action;
        if (testChoice === 'quit') {
            action = 'quit';
        } else if (testChoice === 'choose') {
            action = 'choose';
        } else if (testChoice === 'retry' && !pointerError) {
            action = 'retry';
        } else {
            const result = await dialog.showMessageBox({
                type: 'error',
                title: strings.locationErrorTitle,
                message: strings.locationErrorTitle,
                detail: locationErrorDetail(current.error, strings),
                buttons,
                defaultId: 0,
                cancelId: buttons.length - 1,
                noLink: true,
            });
            action = result.response === 0
                ? (pointerError ? 'open' : 'retry')
                : result.response === 1 ? 'choose' : 'quit';
        }
        if (action === 'quit') {
            app.quit();
            return;
        }
        if (action === 'retry') {
            relaunchApp();
            return;
        }
        if (action === 'open') {
            await shell.openPath(path.dirname(current.pointerPath));
            continue;
        }
        if (await chooseRecoveryDirectory(current, strings)) {
            return;
        }
    }
}

async function pickDataDirectory(win, strings) {
    const options = {
        title: strings.chooseDataDirectoryTitle,
        defaultPath: userData,
        properties: process.platform === 'darwin'
            ? ['openDirectory', 'createDirectory']
            : process.platform === 'win32'
                ? ['openDirectory', 'promptToCreate']
                : ['openDirectory'],
    };
    const result = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : path.resolve(result.filePaths[0]);
}

async function confirmDialog(win, title, message, confirmLabel, cancelLabel) {
    const options = {
        type: 'question',
        title,
        message,
        buttons: [confirmLabel, cancelLabel],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    };
    const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return result.response === 0;
}

function formatDialogError(strings, code, target, detail = '') {
    if (code === 'same') {
        return { message: strings.dataDirectorySame, detail: target };
    }
    if (code === 'not-writable') {
        return { message: strings.dataDirectoryNotWritable, detail: target };
    }
    if (code === 'no-space') {
        return { message: strings.dataDirectoryNoSpace, detail: target };
    }
    return { message: strings.dataDirectoryInvalid, detail: detail || target };
}

async function showDialogMessage(win, strings, message, detail = '') {
    const options = {
        type: 'error',
        title: strings.locationErrorTitle,
        message,
        detail,
        buttons: [strings.locationOk],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
    if (win && !win.isDestroyed()) {
        await dialog.showMessageBox(win, options);
    } else {
        await dialog.showMessageBox(options);
    }
}

let cleanupPromise = null;
async function finishPendingCleanup() {
    if (!location.state?.pendingDeleteFrom) {
        return;
    }
    if (!cleanupPromise) {
        cleanupPromise = (async () => {
            location.state = await finishCleanup({
                pointerPath: location.pointerPath,
                state: location.state,
                defaultUserData,
            });
        })().finally(() => {
            cleanupPromise = null;
        });
    }
    await cleanupPromise;
}

ipcMain.handle('luker:choose-data-directory', async (event) => {
    assertAppFrame(event, 'The data directory setting');
    if (process.env.LUKER_DESKTOP_USER_DATA) {
        throw new Error('The data directory is managed by the launch environment.');
    }
    await finishPendingCleanup();

    const strings = pickShellStrings(app.getLocale());
    const win = BrowserWindow.fromWebContents(event.sender);
    const selected = await pickDataDirectory(win, strings);
    if (!selected) {
        return { canceled: true };
    }

    let classified;
    try {
        classified = classifyDataTarget(selected, { source: userData, defaultUserData });
    } catch (error) {
        await showDialogMessage(win, strings, strings.dataDirectoryInvalid, error.message);
        return { canceled: true };
    }
    if (classified.mode === 'reject') {
        const { message, detail } = formatDialogError(strings, classified.reason, selected);
        await showDialogMessage(win, strings, message, detail);
        return { canceled: true };
    }

    if (classified.mode === 'move') {
        try {
            fs.mkdirSync(selected, { recursive: true });
            validateWritableDirectory(selected);
        } catch (error) {
            await showDialogMessage(win, strings, strings.dataDirectoryNotWritable, error.message);
            return { canceled: true };
        }
        let space;
        try {
            space = checkFreeSpace(userData, selected);
        } catch (error) {
            await showDialogMessage(win, strings, strings.dataDirectoryInvalid, error.message);
            return { canceled: true };
        }
        if (!space.enough) {
            const { message, detail } = formatDialogError(strings, 'no-space', selected);
            await showDialogMessage(win, strings, message, detail);
            return { canceled: true };
        }
        const confirmed = await confirmDialog(
            win,
            strings.moveConfirmTitle,
            strings.moveConfirmMessage.replace('%s', selected),
            strings.moveConfirmButton,
            strings.cancel,
        );
        if (!confirmed) {
            return { canceled: true };
        }
        try {
            writeLocationState(location.pointerPath, {
                version: POINTER_VERSION,
                userData,
                pendingMoveTo: selected,
                pendingMoveToIdentity: directoryIdentity(selected),
            });
        } catch (error) {
            await showDialogMessage(win, strings, strings.dataDirectoryInvalid, error.message);
            return { canceled: true };
        }
    } else {
        try {
            validateWritableDirectory(selected);
        } catch (error) {
            await showDialogMessage(win, strings, strings.dataDirectoryNotWritable, error.message);
            return { canceled: true };
        }
        const confirmed = await confirmDialog(
            win,
            strings.adoptConfirmTitle,
            strings.adoptConfirmMessage.replace('%s', selected),
            strings.adoptConfirmButton,
            strings.cancel,
        );
        if (!confirmed) {
            return { canceled: true };
        }
        try {
            writeLocationState(location.pointerPath, { version: POINTER_VERSION, userData: selected });
        } catch (error) {
            await showDialogMessage(win, strings, strings.dataDirectoryInvalid, error.message);
            return { canceled: true };
        }
    }

    setTimeout(() => relaunchApp(), 250);
    return { restarting: true };
});

async function showMoveFailure(current, strings, source, target, error) {
    const buttons = [strings.locationRetry, strings.locationChoose, strings.locationQuit];
    while (true) {
        const result = await dialog.showMessageBox({
            type: 'error',
            title: strings.moveFailedTitle,
            message: strings.moveFailedMessage.replace('%s', target),
            detail: error?.message || String(error),
            buttons,
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        });
        if (result.response === 0) {
            relaunchApp();
            return;
        }
        if (result.response === 2) {
            app.quit();
            return;
        }
        const selected = await pickDataDirectory(null, strings);
        if (!selected) {
            continue;
        }
        const classified = classifyDataTarget(selected, { source, defaultUserData });
        if (classified.mode === 'reject') {
            const { message, detail } = formatDialogError(strings, classified.reason, selected);
            await showDialogMessage(null, strings, message, detail);
            continue;
        }
        if (classified.mode === 'adopt') {
            writeLocationState(current.pointerPath, { version: POINTER_VERSION, userData: selected });
            relaunchApp();
            return;
        }
        try {
            fs.mkdirSync(selected, { recursive: true });
            validateWritableDirectory(selected);
        } catch (selectionError) {
            await showDialogMessage(null, strings, strings.dataDirectoryNotWritable, selectionError.message);
            continue;
        }
        writeLocationState(current.pointerPath, {
            version: POINTER_VERSION,
            userData: source,
            pendingMoveTo: selected,
            pendingMoveToIdentity: directoryIdentity(selected),
        });
        relaunchApp();
        return;
    }
}

async function runMigrationSession(current, strings, locale) {
    const source = current.state.userData;
    const target = current.state.pendingMoveTo;
    let settled = false;
    const win = new BrowserWindow({
        width: 520,
        height: 320,
        show: false,
        webPreferences: {
            preload: path.join(import.meta.dirname, 'preload.js'),
            backgroundThrottling: false,
        },
    });
    win.once('ready-to-show', () => win.show());
    win.on('close', (event) => {
        if (settled) {
            return;
        }
        event.preventDefault();
        app.quit();
    });
    try {
        await win.loadFile('loading.html', { query: { locale, mode: 'move' } });
        await migrateDataDirectory({
            source,
            target,
            targetIdentity: current.state.pendingMoveToIdentity,
            defaultUserData,
            onProgress: (progress) => {
                if (!win.isDestroyed()) {
                    win.webContents.send('luker:data-move-progress', progress);
                }
            },
        });
        writeLocationState(current.pointerPath, {
            version: POINTER_VERSION,
            userData: target,
            pendingDeleteFrom: source,
        });
        if (!win.isDestroyed()) {
            win.webContents.send('luker:data-move-progress', { done: true });
        }
        settled = true;
        setTimeout(() => relaunchApp(), 300);
    } catch (error) {
        settled = true;
        if (!win.isDestroyed()) {
            win.destroy();
        }
        await showMoveFailure(current, strings, source, target, error);
    }
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
    if (location.error) {
        await showLocationError(location, strings);
        return;
    }
    if (location.state?.pendingMoveTo) {
        await runMigrationSession(location, strings, locale);
        return;
    }
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

    startLogTee();
    fs.rmSync(updatesDirectory, { recursive: true, force: true });

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
