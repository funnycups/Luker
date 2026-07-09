// native node modules
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import net from 'node:net';
import dns from 'node:dns';
import process from 'node:process';
import http from 'node:http';
import https from 'node:https';

import cors from 'cors';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import compression from 'compression';
import cookieSession from 'cookie-session';
import multer from 'multer';
import responseTime from 'response-time';
import helmet from 'helmet';
import bodyParser from 'body-parser';

// Timestamp all console output and capture to circular log buffer.
// JSON.stringify throws on circular references / BigInt — if the wrapper ever
// throws, callers see a TypeError from console.error and (worst case) the
// uncaughtException handler re-enters the same wrapper, re-throws, and Node
// aborts with an empty stderr. So: serialize defensively, and never let buffer
// bookkeeping interfere with the underlying console call.
const BACKEND_LOG_MAX = 500;
export const backendLogBuffer = [];
let backendLogCounter = 0;
function serializeLogArg(value) {
    if (typeof value === 'string') return value;
    try {
        const serialized = JSON.stringify(value);
        if (serialized !== undefined) return serialized;
    } catch { /* fall through */ }
    try {
        return util.inspect(value, { depth: 4, maxArrayLength: 100, breakLength: 140 });
    } catch {
        return String(value);
    }
}
['log', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        const ts = new Date().toISOString();
        try {
            const entry = { id: ++backendLogCounter, ts, level, message: args.map(serializeLogArg).join(' ') };
            if (backendLogBuffer.length >= BACKEND_LOG_MAX) backendLogBuffer.shift();
            backendLogBuffer.push(entry);
        } catch { /* never let log capture wreck the underlying console call */ }
        original(`[${ts}]`, ...args);
    };
});

// Node diagnostic reports — written on fatal V8 errors, uncaught exceptions,
// and OS signals. These are the only artefact left behind when a native
// module SEGVs and the process aborts without flushing stderr (the rename
// silent-crash class of bug). Reports land in <DATA_ROOT>/diagnostic-reports
// as JSON containing the native stack, JS stack, heap snapshot pointers,
// and open libuv handles. Always-on; cost is zero until something crashes.
try {
    const reportDir = path.join(globalThis.DATA_ROOT || '.', 'diagnostic-reports');
    fs.mkdirSync(reportDir, { recursive: true });
    process.report.directory = reportDir;
    process.report.reportOnFatalError = true;
    process.report.reportOnUncaughtException = true;
    process.report.reportOnSignal = true;
} catch (error) {
    console.warn('Failed to configure Node diagnostic reports:', error);
}

// local library imports
import './fetch-patch.js';
import { serverDirectory } from './server-directory.js';

import { serverEvents, EVENT_NAMES } from './server-events.js';
import { loadPlugins } from './plugin-loader.js';
import {
    initUserStorage,
    getCookieSecret,
    getCookieSessionName,
    ensurePublicDirectoriesExist,
    getUserDirectories,
    getUserDirectoriesList,
    migrateSystemPrompts,
    migrateUserData,
    requireLoginMiddleware,
    enforceUserQuotaMiddleware,
    setUserDataMiddleware,
    shouldRedirectToLogin,
    cleanUploads,
    getSessionCookieAge,
    verifySecuritySettings,
    loginPageMiddleware,
    migratePublicOverrides,
    isRequestAdmin,
} from './users.js';
import { initStorage, getStorageEngine } from './storage/index.js';
import { maybeFailFast } from './storage/fail-fast.js';

import getWebpackServeMiddleware from './middleware/webpack-serve.js';
import basicAuthMiddleware from './middleware/basicAuth.js';
import getWhitelistMiddleware from './middleware/whitelist.js';
import accessLoggerMiddleware, { getAccessLogPath, migrateAccessLog } from './middleware/accessLogWriter.js';
import multerMonkeyPatch from './middleware/multerMonkeyPatch.js';
import initRequestProxy from './request-proxy.js';
import initPrivateRequestFilter from './private-request-filter.js';
import cacheBuster from './middleware/cacheBuster.js';
import corsProxyMiddleware from './middleware/corsProxy.js';
import hostWhitelistMiddleware from './middleware/hostWhitelist.js';
import userCssMiddleware from './middleware/userCss.js';
import { storageErrorHandler } from './middleware/storage-errors.js';
import {
    getVersion,
    checkRemoteVersion,
    color,
    removeColorFormatting,
    getSeparator,
    safeReadFileSync,
    setupLogLevel,
    setWindowTitle,
    getConfigValue,
    ensureDirectory,
} from './util.js';
import { installLogCapture } from './log-capture.js';
import { getBufferForHandle as getInspectorBufferForHandle } from './request-inspector.js';
import {
    UPLOADS_DIRECTORY,
    SERVER_PLUGINS_DIRECTORY,
    setGlobalExtensionsDirectory,
    setServerPluginsDirectory,
} from './constants.js';

// Routers
import { router as usersPublicRouter } from './endpoints/users-public.js';
import { router as syncRouter } from './endpoints/sync.js';
import { syncInProgressMiddleware } from './sync/in-progress-gate.js';
import { router as storageHealthRouter } from './endpoints/storage-health.js';
import { init as statsInit, onExit as statsOnExit } from './endpoints/stats.js';
import { checkForNewContent } from './endpoints/content-manager.js';
import { init as settingsInit } from './endpoints/settings.js';
import { ServerStartup, setupPrivateEndpoints } from './server-startup.js';
import { verifyWsTicket } from './ws-ticket-router.js';
import { createDeliveryServer } from './ws-delivery.js';
import { diskCache } from './endpoints/characters.js';
import { migrateFlatSecrets } from './endpoints/secrets.js';
import { migrateGroupChatsMetadataFormat } from './endpoints/groups.js';
import { initializeAllUserMetadata } from './endpoints/image-metadata.js';
import { applyPendingSafeMode } from './safe-mode.js';

// Work around a node v20.0.0, v20.1.0, and v20.2.0 bug. The issue was fixed in v20.3.0.
// https://github.com/nodejs/node/issues/47822#issuecomment-1564708870
// Safe to remove once support for Node v20 is dropped.
if (process.versions && process.versions.node && process.versions.node.match(/20\.[0-2]\.0/)) {
    // @ts-ignore
    if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);
}

// Unrestrict console logs display limit
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.maxStringLength = null;
util.inspect.defaultOptions.depth = 4;
installLogCapture();

/** @type {import('./command-line.js').CommandLineArguments} */
const cliArgs = globalThis.COMMAND_LINE_ARGS;

setGlobalExtensionsDirectory(cliArgs.globalExtensionsPath);
setServerPluginsDirectory(cliArgs.serverPluginsPath);

if (!cliArgs.enableIPv6 && !cliArgs.enableIPv4) {
    console.error('error: You can\'t disable all internet protocols: at least IPv6 or IPv4 must be enabled.');
    process.exit(1);
}

// Set keep-alive preference for all HTTP/HTTPS requests.
http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive });
https.globalAgent = new https.Agent({ keepAlive: cliArgs.enableKeepAlive });

const app = express();
// Root for Luker-shipped scaffolding (e.g. bundled skills under
// default/skills/global/). Endpoints that consume bundled content read it
// via req.app.get('lukerDefaultRoot') so tests can override per-request.
app.set('lukerDefaultRoot', path.join(serverDirectory, 'default'));
app.use(helmet({
    contentSecurityPolicy: false,
}));
// Allow JS Self-Profiling API in supported browsers.
// We send both legacy and mode-based directives for broader Chromium compatibility.
app.use((_, res, next) => {
    res.setHeader('Document-Policy', 'js-profiling, js-profiling-mode=lazy');
    next();
});
app.use(compression({
    filter: (req, res) => {
        const contentType = String(res.getHeader('Content-Type') || '');
        if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
            return false;
        }
        return compression.filter(req, res);
    },
}));
app.use(responseTime());

// In-flight request tracker — when the process exits unexpectedly (signal,
// uncaught exception escaping a handler, native abort, stray process.exit),
// the exit hook below dumps whatever requests were still running so we know
// which endpoint took the server down.
const inFlightRequests = new Map();
let inFlightSeq = 0;
app.use((req, res, next) => {
    const id = ++inFlightSeq;
    inFlightRequests.set(id, {
        id,
        method: req.method,
        path: req.path,
        startedAt: Date.now(),
    });
    const cleanup = () => inFlightRequests.delete(id);
    res.on('finish', cleanup);
    res.on('close', cleanup);
    next();
});

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// CORS Settings //
const corsEnabled = getConfigValue('cors.enabled', true, 'boolean');
if (corsEnabled) {
    const corsOrigin = getConfigValue('cors.origin', 'null');
    const corsMethods = getConfigValue('cors.methods', ['OPTIONS']);
    const corsAllowedHeaders = getConfigValue('cors.allowedHeaders', []);
    const corsExposedHeaders = getConfigValue('cors.exposedHeaders', []);
    const corsCredentials = getConfigValue('cors.credentials', false, 'boolean');
    const corsMaxAge = getConfigValue('cors.maxAge', null, 'number');

    /** @type {cors.CorsOptions} */
    const corsOptions = {
        origin: corsOrigin,
        methods: corsMethods,
        credentials: corsCredentials,
    };
    if (Array.isArray(corsAllowedHeaders) && corsAllowedHeaders.length > 0) {
        corsOptions.allowedHeaders = corsAllowedHeaders;
    }
    if (Array.isArray(corsExposedHeaders) && corsExposedHeaders.length > 0) {
        corsOptions.exposedHeaders = corsExposedHeaders;
    }
    if (corsMaxAge !== null && Number.isInteger(corsMaxAge)) {
        corsOptions.maxAge = corsMaxAge;
    }
    app.use(cors(corsOptions));
}

if (cliArgs.listen && cliArgs.basicAuthMode) {
    app.use(basicAuthMiddleware);
}

if (cliArgs.whitelistMode) {
    const whitelistMiddleware = await getWhitelistMiddleware();
    app.use(whitelistMiddleware);
}

app.use(hostWhitelistMiddleware);

if (cliArgs.listen) {
    app.use(accessLoggerMiddleware());
}

app.use(cookieSession({
    name: getCookieSessionName(),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
}));

app.use(setUserDataMiddleware);

// CSRF Protection //
if (!cliArgs.disableCsrf) {
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => {
            if (!req.session) {
                console.error('(CSRF error) getTokenFromState: Session object not initialized');
                return;
            }
            return req.session.csrfToken;
        },
        getTokenFromRequest: (req) => {
            return req.headers['x-csrf-token']?.toString();
        },
        storeTokenInState: (req, token) => {
            if (!req.session) {
                console.error('(CSRF error) storeTokenInState: Session object not initialized');
                return;
            }
            req.session.csrfToken = token;
        },
        skipCsrfProtection: (req) => {
            // CORS proxy passthroughs were the original carve-out.
            if (cliArgs.enableCorsProxy && /^\/proxy\//.test(req.path)) return true;
            // LAN sync `/session/*` is the cross-peer protocol: those
            // routes either authenticate via bearer token (`requireSyncToken`)
            // or via the user's basic-auth credentials forwarded by the
            // initiating peer (`/session/offer`). CSRF protection assumes
            // browser-driven cross-site attacks, which doesn't apply when
            // every legitimate caller is another Luker server's fetch()
            // (with no shared cookie jar). Without this carve-out, a server-
            // side `/pair/accept` call to the peer's `/session/offer` is
            // rejected with "Invalid CSRF token" — the peer has no way to
            // know the initiator's session-bound token.
            //
            // Limited to `/api/sync/v1/session/*` deliberately: the admin
            // routes (`/peers`, `/pair/start`, `/pair/accept`, etc.) are
            // browser-driven from the user's own page and remain CSRF-
            // gated.
            if (/^\/api\/sync\/v1\/session\//.test(req.path)) return true;
            return false;
        },
        size: 32,
    });

    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': csrfSyncProtection.generateToken(req),
        });
    });

    // Customize the error message
    csrfSyncProtection.invalidCsrfTokenError.message = color.red('Invalid CSRF token. Please refresh the page and try again.');
    csrfSyncProtection.invalidCsrfTokenError.stack = undefined;

    app.use(csrfSyncProtection.csrfSynchronisedProtection);
} else {
    console.warn('\nCSRF protection is disabled. This will make your server vulnerable to CSRF attacks.\n');
    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': 'disabled',
        });
    });
}

// Static files
// Host index page
app.get('/', cacheBuster.middleware, (request, response) => {
    if (shouldRedirectToLogin(request)) {
        const query = request.url.split('?')[1];
        const redirectUrl = query ? `/login?${query}` : '/login';
        return response.redirect(redirectUrl);
    }

    return response.sendFile('index.html', { root: path.join(serverDirectory, 'public') });
});

// Callback endpoint for OAuth PKCE flows (e.g. OpenRouter)
app.get('/callback/:source?', (request, response) => {
    const source = request.params.source;
    const query = request.url.split('?')[1];
    const searchParams = new URLSearchParams();
    source && searchParams.set('source', source);
    query && searchParams.set('query', query);
    const path = `/?${searchParams.toString()}`;
    return response.redirect(307, path);
});

// Host login page
app.get('/login', loginPageMiddleware);

// Host frontend assets
const webpackMiddleware = getWebpackServeMiddleware();
app.use(webpackMiddleware);
app.use(userCssMiddleware);
app.use(express.static(path.join(serverDirectory, 'public'), {}));

// Tokenizer libs and data — let the browser run tokenization directly instead
// of going through /api/tokenizers/* for every count. Read-only static assets.
app.use('/lib/tokenizers/web-tokenizers', express.static(
    path.join(serverDirectory, 'node_modules/@agnai/web-tokenizers/lib'),
    { maxAge: '7d', immutable: true },
));
app.use('/lib/tokenizers/js-tiktoken', express.static(
    path.join(serverDirectory, 'node_modules/js-tiktoken/dist'),
    { maxAge: '7d', immutable: true },
));
app.use('/tokenizers', express.static(
    path.join(serverDirectory, 'src/tokenizers'),
    { maxAge: '7d', immutable: true },
));

// js-tiktoken's chunk module does `import base64 from 'base64-js'` (bare specifier),
// which browsers can't resolve without an import map or bundler. Synthesize a
// single-file ESM that inlines base64-js as an IIFE shim. Computed once, cached
// in memory, auto-updates when js-tiktoken / base64-js change on disk.
let __tiktokenBundle = null;
function getTiktokenBundle() {
    if (__tiktokenBundle) return __tiktokenBundle;
    const distDir = path.join(serverDirectory, 'node_modules/js-tiktoken/dist');
    const chunkName = fs.readdirSync(distDir).find(f => f.startsWith('chunk-') && f.endsWith('.js'));
    if (!chunkName) throw new Error('Could not locate js-tiktoken chunk file');
    const base64js = fs.readFileSync(path.join(serverDirectory, 'node_modules/base64-js/index.js'), 'utf8');
    let chunk = fs.readFileSync(path.join(distDir, chunkName), 'utf8');
    const shim = `const base64 = (() => { const exports = {}; const module = { exports };\n${base64js}\nreturn module.exports; })();`;
    chunk = chunk.replace(/^import base64 from 'base64-js';/m, shim);
    __tiktokenBundle = chunk;
    return __tiktokenBundle;
}
app.get('/lib/tokenizers/js-tiktoken-bundle.js', (_req, res) => {
    try {
        res.type('application/javascript')
            .set('Cache-Control', 'public, max-age=3600, must-revalidate')
            .send(getTiktokenBundle());
    } catch (err) {
        console.error('Failed to synthesize js-tiktoken bundle:', err);
        res.status(500).type('text/plain').send('// js-tiktoken bundle synthesis failed: ' + err.message);
    }
});

// @agnai/sentencepiece-js ships pure CommonJS (`var fs = require('fs')` and
// `exports.SentencePieceProcessor = ...`), which browsers can't load natively.
// Wrap the raw dist in an ESM module with local `require`/`exports`/`module`/
// `__filename`/`__dirname` shims. The NODE-only branches inside Emscripten's
// init never execute in browser, so the fs stub never gets called.
let __sentencepieceBundle = null;
function getSentencepieceBundle() {
    if (__sentencepieceBundle) return __sentencepieceBundle;
    const src = fs.readFileSync(
        path.join(serverDirectory, 'node_modules/@agnai/sentencepiece-js/dist/index.js'),
        'utf8',
    );
    const wrapped = [
        '// Auto-synthesized ESM wrapper around @agnai/sentencepiece-js CommonJS dist.',
        '// __spFileCache lets the adapter pre-stash model bytes by URL, so the inner',
        '// `.load(url)` -> `fs__namespace.readFileSync(url)` sync call resolves to a',
        '// real buffer instead of throwing.',
        'const __spFileCache = new Map();',
        'const __fsShim = {',
        '    readFileSync(url) {',
        '        const buf = __spFileCache.get(url);',
        '        if (!buf) throw new Error("sentencepiece-js fs shim: no cached buffer for " + url + " — adapter must prefetch via __spFileCache.set() before sp.load()");',
        '        return buf;',
        '    },',
        '};',
        'const exports = {};',
        'const module = { exports };',
        'const __filename = "";',
        'const __dirname = "";',
        'const require = (id) => {',
        '    if (id === "fs") return __fsShim;',
        // Emscripten boilerplate at index.js:93 dereferences require("url").URL
        // when `typeof document === "undefined"` (module-worker scope). Without
        // this, sentencepiece init throws "require(...).URL is not a constructor"
        // inside the worker and every encode call silently rejects.
        '    if (id === "url") return { URL };',
        '    if (id === "path" || id === "module") return {};',
        '    throw new Error("sentencepiece-js bundle: unshimmed require(" + JSON.stringify(id) + ")");',
        '};',
        src,
        'const __SP_Processor = exports.SentencePieceProcessor;',
        'const __SP_cleanText = exports.cleanText;',
        'export { __SP_Processor as SentencePieceProcessor, __SP_cleanText as cleanText, __spFileCache };',
        'export default exports.default ?? exports;',
    ].join('\n');
    __sentencepieceBundle = wrapped;
    return __sentencepieceBundle;
}
app.get('/lib/tokenizers/sentencepiece-js-bundle.js', (_req, res) => {
    try {
        res.type('application/javascript')
            .set('Cache-Control', 'public, max-age=3600, must-revalidate')
            .send(getSentencepieceBundle());
    } catch (err) {
        console.error('Failed to synthesize sentencepiece-js bundle:', err);
        res.status(500).type('text/plain').send('// sentencepiece-js bundle synthesis failed: ' + err.message);
    }
});

// Public API
app.use('/api/users', usersPublicRouter);
// Public storage probe: mounted BEFORE requireLoginMiddleware so external
// monitors (k8s, load balancers, uptime checks) can poll without
// credentials. Returns engine kind + latency on success, 503 on ping failure.
app.use('/api/storage', storageHealthRouter);

// LAN-sync protocol. Mounted alongside the public router so peer-to-peer
// session traffic (`/session/*`, bearer-token auth) is reachable without a
// logged-in browser cookie. Basic auth still applies to `/health` via the
// upstream middleware; the `isBasicAuthExemptRequest` patch lets the
// `/session/*` paths through on their own token.
app.use('/api/sync/v1', syncRouter);

// Everything below this line requires authentication
app.use(requireLoginMiddleware);
app.use(enforceUserQuotaMiddleware);

// LAN-sync write-gate (spec §4.4). Returns HTTP 409 from user-initiated
// save endpoints (`/api/chats/save`, `/api/settings/save`, etc.) while a
// sync is mid-flight for the same user. Mounted AFTER the sync router
// so /api/sync/v1/* is unaffected, and AFTER requireLoginMiddleware so
// the middleware can read `request.user.profile.handle`.
app.use(syncInProgressMiddleware());
app.post('/api/ping', (request, response) => {
    if (request.query.extend && request.session) {
        request.session.touch = Date.now();
    }

    response.sendStatus(204);
});

// Debug export endpoint.
// One-shot bundle export for troubleshooting: assembles every payload on the
// server so the browser never has to stringify the full ring buffer. The client
// posts its frontend-only fields (console logs, perf marks, UA/viewport, etc.)
// and gets back a single attachment combining everything below, with secrets
// redacted in one place.
const DEBUG_EXPORT_REDACT_PATTERNS = [
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-***REDACTED***' },
    { pattern: /Bearer\s+[a-zA-Z0-9\-_.]{20,}/g, replacement: 'Bearer ***REDACTED***' },
    { pattern: /(api[_-]?key|apikey|token|secret|password|passwd)\s*[=:]\s*["']?[^\s"',&]+/gi, replacement: '$1=***REDACTED***' },
    { pattern: /eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/g, replacement: '***JWT-REDACTED***' },
    { pattern: /\b[a-f0-9]{40,}\b/gi, replacement: '***HEX-TOKEN-REDACTED***' },
];

function redactDebugExportString(input) {
    let out = String(input);
    for (const { pattern, replacement } of DEBUG_EXPORT_REDACT_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

function redactDebugExportValue(value) {
    if (typeof value === 'string') return redactDebugExportString(value);
    if (Array.isArray(value)) return value.map(redactDebugExportValue);
    if (value && typeof value === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(value)) cleaned[k] = redactDebugExportValue(v);
        return cleaned;
    }
    return value;
}

app.post('/api/debug/export', (request, response) => {
    const handle = String(request?.user?.profile?.handle || '');
    const isAdmin = isRequestAdmin(request);
    const client = (request.body && typeof request.body === 'object') ? request.body : {};

    const bundle = {
        exportedAt: new Date().toISOString(),
        scope: isAdmin ? 'admin' : 'user',
        client: {
            userAgent: typeof client.userAgent === 'string' ? client.userAgent : '',
            viewport: client.viewport && typeof client.viewport === 'object' ? client.viewport : null,
            devicePixelRatio: client.devicePixelRatio ?? null,
            platform: typeof client.platform === 'string' ? client.platform : '',
            language: typeof client.language === 'string' ? client.language : '',
            online: typeof client.online === 'boolean' ? client.online : null,
            connectionType: typeof client.connectionType === 'string' ? client.connectionType : '',
            memoryGB: client.memoryGB ?? null,
        },
        frontendLogs: Array.isArray(client.frontendLogs) ? client.frontendLogs : [],
        performanceMarks: Array.isArray(client.performanceMarks) ? client.performanceMarks : [],
        performanceMeasures: Array.isArray(client.performanceMeasures) ? client.performanceMeasures : [],
        requestInspector: handle ? getInspectorBufferForHandle(handle) : [],
    };

    if (isAdmin) {
        bundle.backendLogs = backendLogBuffer;
        bundle.runtime = {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cwd: serverDirectory,
        };
    }

    const redacted = redactDebugExportValue(bundle);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="luker-debug-${ts}.json"`);
    response.end(JSON.stringify(redacted, null, 2));
});

if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
} else {
    app.use('/proxy/:url(*)', async (_, res) => {
        const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
        console.log(message);
        res.status(404).send(message);
    });
}

// File uploads — re-ensure destination per request so the upload doesn't
// ENOENT if the directory is removed after process start.
const uploadsPath = path.join(cliArgs.dataRoot, UPLOADS_DIRECTORY);
app.use(multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            ensureDirectory(uploadsPath);
            cb(null, uploadsPath);
        },
    }),
    limits: { fieldSize: 500 * 1024 * 1024 },
}).single('avatar'));
app.use(multerMonkeyPatch);

app.get('/version', async function (_, response) {
    const data = await getVersion();
    response.send(data);
});

app.post('/api/system/update-check', async function (_, response) {
    const data = await checkRemoteVersion();
    response.send(data);
});

setupPrivateEndpoints(app);

// Storage-layer typed errors (StorageReadOnlyError / ConflictError /
// NotFoundError) thrown or forwarded by any of the routers above are mapped
// to clean HTTP responses here. Must come AFTER all route mounts and BEFORE
// `apply404Middleware` (which is registered by `.then(apply404Middleware)`
// after `preSetupTasks`) so unhandled errors don't fall through to a generic
// 500. Anything not recognized is passed through to Express's default error
// handler.
app.use(storageErrorHandler);

/**
 * Tasks that need to be run before the server starts listening.
 * @returns {Promise<void>}
 */
async function preSetupTasks() {
    const version = await getVersion();

    // Print formatted header
    console.log();
    console.log(`Luker ${version.pkgVersion}`);
    if (version.gitBranch && version.commitDate) {
        const date = new Date(version.commitDate);
        const localDate = date.toLocaleString('en-US', { timeZoneName: 'short' });
        console.log(`Running '${version.gitBranch}' (${version.gitRevision}) - ${localDate}`);
        checkRemoteVersion().then((remoteData) => {
            if (!remoteData.isLatest && ['staging', 'release'].includes(version.gitBranch)) {
                console.log('INFO: A newer tagged Luker version is available.');
                console.log('      Pull latest tags/changes to update.');
            }
        });
    }
    console.log();

    const directories = await getUserDirectoriesList();

    // Schema migrations must complete before downstream readers run, because
    // diskCache.verify / initializeAllUserMetadata / settingsInit / statsInit
    // all consume whatever shape these migrations leave behind.
    await migrateGroupChatsMetadataFormat(directories);

    // Content seeding can add new characters/worlds; finish before the
    // metadata/cache stages scan those directories.
    await checkForNewContent(directories);

    migrateFlatSecrets(directories);
    cleanUploads();
    migrateAccessLog();

    // IO-bound, mutually-independent: each touches disjoint state
    // (diskCache → character PNGs, settingsInit → settings backups,
    // statsInit → stats DB, initializeAllUserMetadata → avatar metadata).
    // Running serially on Android wastes hundreds of ms per user; the JS
    // event loop happily interleaves these fs reads.
    await Promise.all([
        diskCache.verify(directories),
        settingsInit(),
        statsInit(),
        initializeAllUserMetadata(directories),
    ]);

    // If the native launcher's boot watchdog left a sentinel (i.e. the
    // previous launch never produced a successful /api/ping), expand each
    // user's `disabledExtensions` to cover every third-party extension on
    // disk before any client connects. Re-enabling happens one-by-one from
    // the regular extensions UI.
    try {
        await applyPendingSafeMode(globalThis.DATA_ROOT);
    } catch (err) {
        console.warn('safe-mode: failed to apply pending sentinel', err?.message || err);
    }

    const cleanupPlugins = await loadPlugins(app, SERVER_PLUGINS_DIRECTORY);
    const consoleTitle = process.title;

    let isExiting = false;
    const exitProcess = async () => {
        if (isExiting) return;
        isExiting = true;
        await statsOnExit();
        if (typeof cleanupPlugins === 'function') {
            await cleanupPlugins();
        }
        diskCache.dispose();
        setWindowTitle(consoleTitle);
        process.exit();
    };

    // Set up event listeners for a graceful shutdown
    process.on('SIGINT', exitProcess);
    process.on('SIGTERM', exitProcess);
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        exitProcess();
    });
    // Express 4 does not forward async route handler rejections to
    // `next(err)`, so any unhandled rejection inside an `async` route would,
    // by Node defaults, transition to `uncaughtException` and tear the
    // process down. Log them and keep the server alive instead — a single
    // failing request should never take the whole server with it.
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', reason);
    });
    // Make every process exit auditable: a silent crash with no stderr
    // output is otherwise indistinguishable from a clean shutdown. The
    // exit-hook writes straight to stderr.fd because the console wrapper
    // may already be torn down at that point, and it dumps any in-flight
    // requests so the offending endpoint is identifiable.
    process.on('beforeExit', (code) => {
        console.warn('Process beforeExit', { code, intentionalShutdown: isExiting });
    });
    process.on('exit', (code) => {
        try {
            const lines = [`Process exit code=${code} intentionalShutdown=${isExiting}`];
            if (inFlightRequests.size > 0) {
                lines.push(`  in-flight requests (${inFlightRequests.size}):`);
                for (const r of inFlightRequests.values()) {
                    lines.push(`    - ${r.method} ${r.path} (${Date.now() - r.startedAt}ms)`);
                }
            }
            process.stderr.write(lines.join('\n') + '\n');
        } catch { /* ignore */ }
    });

    // Add private request filter.
    const requestFilterOptions = {
        listen: cliArgs.listen,
        enabled: !!getConfigValue('privateAddressWhitelist.enabled', false, 'boolean'),
        privateAddressWhitelist: getConfigValue('privateAddressWhitelist.allowedRanges', ['127.0.0.0/8', '::1/128']),
        logBlocked: !!getConfigValue('privateAddressWhitelist.log.blockedRequests', true, 'boolean'),
        logAllowed: !!getConfigValue('privateAddressWhitelist.log.allowedRequests', false, 'boolean'),
        allowUnresolvedHosts: !!getConfigValue('privateAddressWhitelist.allowUnresolvedHosts', false, 'boolean'),
        enableKeepAlive: cliArgs.enableKeepAlive,
    };
    initPrivateRequestFilter(requestFilterOptions);

    // Add request proxy.
    initRequestProxy({ enabled: cliArgs.requestProxyEnabled, url: cliArgs.requestProxyUrl, bypass: cliArgs.requestProxyBypass, enableKeepAlive: cliArgs.enableKeepAlive, privateRequestFilterEnabled: requestFilterOptions.enabled });

    // Wait for frontend libs to compile
    await webpackMiddleware.runWebpackCompiler({ pruneCache: true });
}

/**
 * Tasks that need to be run after the server starts listening.
 * @param {import('./server-startup.js').ServerStartupResult} result The result of the server startup
 * @returns {Promise<void>}
 */
async function postSetupTasks(result) {
    // Mount the WS delivery layer. Every /api/ws-delivery upgrade must
    // carry a single-use ticket via `Sec-WebSocket-Protocol:
    // luker-ws-ticket.<ticket>`. Tickets are minted on
    // `POST /api/ws-ticket` (see wsTicketRouter mount in server-startup.js)
    // which is gated by the full HTTP middleware stack — Basic Auth,
    // cookieSession, setUserData, requireLogin, CSRF — so the WS channel
    // is trusted the moment the upgrade completes.
    if (result.servers && result.servers.length > 0) {
        for (const server of result.servers) {
            createDeliveryServer({ httpServer: server, verifyTicket: verifyWsTicket });
        }
    }

    const browserLaunchHostname = await cliArgs.getBrowserLaunchHostname(result);
    const browserLaunchUrl = cliArgs.getBrowserLaunchUrl(browserLaunchHostname);
    const browserLaunchApp = String(getConfigValue('browserLaunch.browser', 'default') ?? '');
    const isAndroid = process.platform === 'android';

    if (cliArgs.browserLaunchEnabled && !isAndroid) {
        try {
            // TODO: This should be converted to a regular import when support for Node 18 is dropped
            const openModule = await import('open');
            const { default: open, apps } = openModule;

            function getBrowsers() {
                return {
                    'firefox': apps.firefox,
                    'chrome': apps.chrome,
                    'edge': apps.edge,
                    'brave': apps.brave,
                };
            }

            const validBrowsers = getBrowsers();
            const appName = validBrowsers[browserLaunchApp.trim().toLowerCase()];
            const openOptions = appName ? { app: { name: appName } } : {};

            console.log(`Launching in a browser: ${browserLaunchApp}...`);
            await open(browserLaunchUrl.toString(), openOptions);
        } catch (error) {
            console.error('Failed to launch the browser. Open the URL manually.', error);
        }
    } else if (cliArgs.browserLaunchEnabled && isAndroid) {
        console.log('Skipping automatic browser launch on Android runtime.');
    }

    if (cliArgs.heartbeatInterval > 0) {
        // Convert seconds to milliseconds for the timer
        const intervalMs = cliArgs.heartbeatInterval * 1000;
        const heartbeatPath = path.join(globalThis.DATA_ROOT, 'heartbeat.json');

        console.log(`Heartbeat enabled. Updating ${color.green(heartbeatPath)} every ${cliArgs.heartbeatInterval} seconds`);

        const writeHeartbeat = () => {
            try {
                fs.writeFileSync(heartbeatPath, JSON.stringify({ timestamp: Date.now() }));
            } catch (err) {
                console.error(`Failed to write heartbeat file at ${color.green(heartbeatPath)}:`, err.message);
            }
        };

        // Write immediately
        writeHeartbeat();

        // Loop using the converted milliseconds
        setInterval(writeHeartbeat, intervalMs).unref();
    }

    setWindowTitle('Luker WebServer');

    let logListen = 'Luker is listening on';

    if (result.useIPv6 && !result.v6Failed) {
        logListen += color.green(
            ' IPv6: ' + cliArgs.getIPv6ListenUrl().host,
        );
    }

    if (result.useIPv4 && !result.v4Failed) {
        logListen += color.green(
            ' IPv4: ' + cliArgs.getIPv4ListenUrl().host,
        );
    }

    const goToLog = `Go to: ${color.blue(browserLaunchUrl)} to open Luker`;
    const plainGoToLog = removeColorFormatting(goToLog);

    console.log(logListen);
    if (cliArgs.listen) {
        console.log();
        console.log('To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".');
        console.log('Check the "access.log" file in the data directory to inspect incoming connections:', color.green(getAccessLogPath()));
    }
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');
    console.log(goToLog);
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');

    setupLogLevel();
    installLogCapture();
    serverEvents.emit(EVENT_NAMES.SERVER_STARTED, { url: browserLaunchUrl });
}

/**
 * Registers a not-found error response if a not-found error page exists. Should only be called after all other middlewares have been registered.
 */
function apply404Middleware() {
    const notFoundWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'url-not-found.html')) ?? '';
    app.use((req, res) => {
        res.status(404).send(notFoundWebpage);
    });
}

/**
 * Sets the DNS resolution order based on the command line arguments.
 */
function setDnsResolutionOrder() {
    try {
        if (cliArgs.dnsPreferIPv6) {
            dns.setDefaultResultOrder('ipv6first');
            console.log('Preferring IPv6 for DNS resolution');
        } else {
            dns.setDefaultResultOrder('ipv4first');
            console.log('Preferring IPv4 for DNS resolution');
        }
    } catch (error) {
        console.warn('Failed to set DNS resolution order. Possibly unsupported in this Node version.');
    }
}

// User storage module needs to be initialized before starting the server
initUserStorage(globalThis.DATA_ROOT)
    .then(setDnsResolutionOrder)
    .then(ensurePublicDirectoriesExist)
    .then(migrateUserData)
    .then(migrateSystemPrompts)
    .then(migratePublicOverrides)
    .then(verifySecuritySettings)
    .then(() => initStorage({
        mode: getConfigValue('storage.mode', 'fs'),
        directoriesByHandle: getUserDirectories,
        mysql: getConfigValue('storage.mysql', null),
        postgres: getConfigValue('storage.postgres', null),
        acquireTimeoutMs: getConfigValue('storage.acquireTimeoutMs', 30000),
        retries: { transient: getConfigValue('storage.retries.transient', 3) },
    }))
    // Optional crash-on-boot: when storage.failFast=true, ping the engine
    // once and exit(1) on failure so the server doesn't accept traffic on a
    // broken storage stack. Default is false (lazy connect).
    .then(() => maybeFailFast(getStorageEngine(), getConfigValue('storage.failFast', false)))
    // Cross-mode restore scratch sweep — best-effort, runs in the background
    // so a slow disk doesn't block server start. Removes _xrestore_<id>
    // dirs under <dataRoot>/_storage-migrations/ older than 24h (left over
    // when a previous cross-mode restore was SIGKILL'd mid-run).
    .then(() => {
        import('./storage/migration/gc-scratch.js')
            .then(({ gcScratch }) => gcScratch({
                dataRoot: globalThis.DATA_ROOT,
                maxAgeMs: 24 * 3600 * 1000,
            }))
            .then((counts) => {
                if (counts.scanned > 0) {
                    console.info(`[gc-scratch] swept ${counts.removed}/${counts.scanned} stale scratch dirs (kept ${counts.kept}, errors ${counts.errors})`);
                }
            })
            .catch((err) => {
                console.warn('[gc-scratch] sweep failed (non-fatal):', err?.message || err);
            });
    })
    .then(preSetupTasks)
    .then(apply404Middleware)
    .then(() => new ServerStartup(app, cliArgs).start())
    .then(postSetupTasks);
