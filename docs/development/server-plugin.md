# Server Plugin Development

Server plugins extend Luker's backend — the Node.js process that hosts the application. Unlike frontend plugins, which run in the browser and modify the user interface, server plugins run on the server and can access the filesystem, spawn processes, proxy API requests, and use any Node.js package.

This guide covers everything you need to know to write, test, and distribute server plugins for Luker.

## What Are Server Plugins

Luker's extension system has two sides:

| | Frontend Plugins | Server Plugins |
|---|---|---|
| **Runtime** | Browser (client-side) | Node.js (server-side) |
| **Location** | `public/scripts/extensions/third-party/` | `plugins/` |
| **Entry format** | `manifest.json` + `index.js` | `.js` / `.mjs` module exporting `init` and `info` |
| **Capabilities** | DOM, events, UI tweaks | Filesystem, network, Node APIs, Express routes |
| **Communication** | Direct DOM access | HTTP endpoints at `/api/plugins/{id}/…` |
| **Security** | Sandboxed to browser origin | Full server access — no sandbox |

A server plugin is a JavaScript module that the Luker server loads at startup. It receives an Express `Router` object and can register HTTP endpoints, which are automatically mounted under `/api/plugins/{plugin-id}/`. The server calls the plugin's `init` function during startup and, if provided, its `exit` function during shutdown.

## When to Use Server Plugins

Server plugins are the right tool when your feature needs something the browser cannot do:

- **Filesystem access** — Read or write files on the server (e.g., managing image galleries, persisting config files)
- **API proxying** — Forward requests to external services, adding authentication headers or retry logic that should stay server-side
- **Node.js packages** — Use any npm module installed in Luker's `node_modules`, or Node built-ins like `crypto`, `fs`, `child_process`
- **WebSocket servers** — Open long-lived connections that the frontend can consume
- **Credential storage** — Keep API keys and secrets on the server instead of exposing them in the browser

If your feature only needs to modify the UI, handle chat events, or store small amounts of per-chat metadata, a frontend plugin is the simpler choice. See [Frontend Plugin Development](/development/frontend-plugin) for that path.

## Enabling Server Plugins

Server plugins are **disabled by default**. To enable them, edit `config.yaml` in your Luker root directory:

```yaml
enableServerPlugins: true
```

When this setting is `false` (or absent), the server skips the entire `plugins/` directory — no plugins are loaded, and no plugin routes are registered.

### Auto-Update

Luker can automatically pull the latest commits for Git-installed plugins on every startup:

```yaml
enableServerPluginsAutoUpdate: true
```

This is enabled by default. Set it to `false` if you want to pin plugin versions or avoid unexpected updates. See [Plugin Installation and Updates](#plugin-installation-and-updates) for details on how auto-update works.

## Plugin File Structure

A server plugin can be a **single file** or a **directory**. The loader discovers plugins inside the `plugins/` directory at the Luker root.

### Single-File Plugin

Place a `.js` (CommonJS) or `.mjs` (ES Module) file directly in `plugins/`:

```
plugins/
├── my-helper.mjs
└── another-plugin.js
```

### Directory Plugin

A directory is loaded in one of two ways:

1. **With `package.json`** — If the directory contains a `package.json` with a `"main"` field, that entry file is loaded:

   ```
   plugins/
   └── my-plugin/
       ├── package.json     # { "main": "src/entry.js" }
       └── src/
           └── entry.js
   ```

2. **Without `package.json`** — The loader looks for entry files in this order: `index.js`, `index.cjs`, `index.mjs`. The first one found is used:

   ```
   plugins/
   └── my-plugin/
       ├── index.js
       └── utils.js
   ```

### Module Format

| Extension | Format | Export Style |
|-----------|--------|-------------|
| `.js`, `.cjs` | CommonJS | `module.exports = { init, info, exit }` |
| `.mjs` | ES Module | `export async function init(router) {}` / `export const info = {}` |

Both formats are fully supported. The loader uses dynamic `import()` for all plugin files, so CJS modules with `module.exports` are handled automatically — you can also access default exports via `plugin.default`.

## Module Interface

Every server plugin must export three things: an `info` object, an `init` function, and optionally an `exit` function.

### TypeScript Interface

```typescript
interface PluginInfo {
  id: string;          // Unique identifier (lowercase, digits, hyphens, underscores)
  name: string;        // Human-readable display name
  description: string; // One-line summary of what the plugin does
}

interface Plugin {
  init: (router: Router) => Promise<void>;  // Called once at startup
  exit?: () => Promise<void>;               // Called on server shutdown (optional)
  info: PluginInfo;                         // Plugin metadata
}
```

### `info` — Required

The `info` object identifies your plugin. All three fields are required:

- **`id`** — A unique string used in the API route prefix and for duplicate detection. Must match `/^[a-z0-9_-]+$/` (see [Plugin ID Rules](#plugin-id-rules)).
- **`name`** — A human-readable name shown in logs and future management UIs.
- **`description`** — A brief summary of the plugin's purpose.

### `init(router)` — Required

Called once when the server starts. Receives an Express `Router` instance. Use it to register HTTP endpoints (see [Route Registration](#route-registration)).

The function may be `async`. The server `await`s it before moving on to the next plugin.

### `exit()` — Optional

Called when the server shuts down. Use it to clean up resources — close database connections, stop timers, flush buffers, etc.

All `exit` functions from loaded plugins are collected and called in parallel during shutdown. If your plugin doesn't hold any resources, you can omit this function entirely.

### ESM Example

```js
// plugins/my-helper/index.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

export const info = {
  id: 'my-helper',
  name: 'My Helper',
  description: 'Example server plugin with health check and file utilities.',
};

export async function init(router) {
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  router.get('/file-stats', (req, res) => {
    const dir = req.query.dir;
    if (!dir) return res.status(400).json({ error: 'Missing dir parameter' });
    try {
      const stats = fs.statSync(dir);
      res.json({ exists: true, isDirectory: stats.isDirectory(), size: stats.size });
    } catch {
      res.json({ exists: false });
    }
  });
}

export async function exit() {
  console.log('[my-helper] Shutting down.');
}
```

### CommonJS Example

```js
// plugins/my-helper/index.js
const fs = require('node:fs');

const info = {
  id: 'my-helper',
  name: 'My Helper',
  description: 'Example server plugin with health check and file utilities.',
};

async function init(router) {
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });
}

async function exit() {
  console.log('[my-helper] Shutting down.');
}

module.exports = { init, exit, info };
```

## Route Registration

Routes registered on the `router` passed to `init()` are automatically mounted at:

```
/api/plugins/{plugin-id}/{your-route}
```

For a plugin with `id: 'my-helper'` that registers `router.get('/health', ...)`, the full endpoint is:

```
GET /api/plugins/my-helper/health
```

### Express Router Usage

The `router` parameter is a standard Express Router. You can use all HTTP methods, middleware, and route patterns you'd use in any Express app:

```js
async function init(router) {
  // Simple GET endpoint
  router.get('/status', (req, res) => {
    res.json({ online: true });
  });

  // POST with JSON body
  router.post('/data', express.json(), (req, res) => {
    const { key, value } = req.body;
    res.json({ saved: true });
  });

  // Route with URL parameters
  router.get('/users/:id', (req, res) => {
    res.json({ id: req.params.id });
  });

  // Error handling middleware (plugin-scoped)
  router.use((err, req, res, next) => {
    console.error('[my-plugin] Unhandled error:', err);
    res.status(500).json({ error: 'Internal plugin error' });
  });
}
```

### Register Routes Before Await

This is the most important rule of server plugin development: **register all your routes synchronously before any `await` in `init()`**.

The server checks `router.stack.length` immediately after `init()` resolves. If no routes were registered, the router is not mounted — and your plugin's endpoints will return 404. This happens even if routes are registered later in an async callback.

**❌ Wrong — routes registered after an await:**

```js
export async function init(router) {
  // Some async setup happens first...
  const config = await loadConfigFromFile();

  // These routes are registered AFTER the await.
  // By the time this runs, the server has already checked
  // router.stack.length and decided not to mount the router.
  router.get('/data', (req, res) => {
    res.json(config);
  });
}
```

**✅ Correct — routes registered synchronously first:**

```js
export async function init(router) {
  // Register all routes immediately, synchronously.
  let config = null;

  router.get('/data', (req, res) => {
    if (!config) return res.status(503).json({ error: 'Still loading' });
    res.json(config);
  });

  router.get('/health', (req, res) => {
    res.json({ ready: !!config });
  });

  // NOW it's safe to do async work.
  // Routes are already in router.stack, so the router will be mounted.
  config = await loadConfigFromFile();
}
```

This pattern — register routes first, then `await` — is used by all well-behaved server plugins. The route handlers can reference variables that are populated asynchronously; they simply need to handle the "not ready yet" case.

> [!NOTE]
> Server plugin routes automatically inherit Luker's authentication middleware (Basic Auth, CSRF, requireLogin, etc.). You do not need to handle authentication in your plugin routes. Middleware in your plugin should focus on plugin-specific logic only.

## Plugin ID Rules

The `info.id` field is validated against a strict pattern:

```
/^[a-z0-9_-]+$/
```

Allowed characters:

- Lowercase letters (`a–z`)
- Digits (`0–9`)
- Hyphens (`-`)
- Underscores (`_`)

**Not allowed:** uppercase letters, spaces, dots, or any other special characters.

The plugin ID is used directly in the API route prefix (`/api/plugins/{id}/…`) and as a key in the loaded-plugins registry. These constraints keep URLs clean and prevent ambiguity.

### Duplicate IDs Are Rejected

If two plugins declare the same `id`, the second one is rejected with a console error and will not load. This prevents route conflicts and ensures every plugin has a unique namespace.

## Security Considerations

Server plugins run with the same privileges as the Luker server process — there is **no sandbox**. This means a plugin can read and write any file the server can, execute shell commands, and make unrestricted network requests. Treat server plugins with the same caution you would apply to any npm package.

### Trust Your Sources

Only install server plugins from authors you trust. A malicious plugin has full access to:

- All files on the server (including `config.yaml` and user data)
- Environment variables (which may contain API keys)
- The local network

### Path Traversal Protection

When accepting file paths from user input (e.g., query parameters), always validate that the resolved path stays within an expected directory. Luker's own plugin loader uses a path-traversal check when resolving plugin directories — apply the same discipline in your plugin code:

```js
import path from 'node:path';

function safePath(baseDir, userInput) {
  const resolved = path.resolve(baseDir, userInput);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error('Path escapes allowed directory');
  }
  return resolved;
}
```

### Credential Storage

If your plugin handles API keys or other secrets:

- Store credentials in server-side files (e.g., under the user's data directory), never in frontend-accessible locations
- Never include secrets in responses sent to the browser
- Use environment variables or a dedicated config file with restricted permissions
- Avoid logging credentials — even at debug level

### Input Validation

Always validate and sanitize data coming from HTTP requests before using it in filesystem operations, database queries, or shell commands. Express's built-in `req.query`, `req.params`, and `req.body` are not sanitized.

## Frontend-Backend Communication

Server plugins and frontend plugins work together by communicating over HTTP. A frontend plugin calls a server plugin's endpoint with `fetch`, and the server plugin handles the request and returns a response.

### Calling a Server Plugin from the Frontend

From a frontend plugin's `index.js`:

```js
// Frontend plugin calling a server plugin endpoint
async function getPluginStatus() {
  const response = await fetch('/api/plugins/my-helper/health');
  if (!response.ok) {
    console.error('Server plugin request failed:', response.status);
    return null;
  }
  return response.json();
}

// Sending data to a server plugin
async function submitData(payload) {
  const response = await fetch('/api/plugins/my-helper/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
```

### Full Round-Trip Example

**Server plugin** (`plugins/data-store/index.mjs`):

```js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data', 'data-store');

export const info = {
  id: 'data-store',
  name: 'Data Store',
  description: 'Simple key-value store backed by the filesystem.',
};

export async function init(router) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  router.get('/get/:key', (req, res) => {
    const filePath = path.join(DATA_DIR, req.params.key + '.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Key not found' });
    }
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  });

  router.post('/set', express.json(), (req, res) => {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'Missing key or value' });
    const filePath = path.join(DATA_DIR, key + '.json');
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    res.json({ ok: true });
  });
}
```

**Frontend plugin** (`public/scripts/extensions/third-party/data-store-ui/index.js`):

```js
const storeBase = '/api/plugins/data-store';

async function getValue(key) {
  const res = await fetch(`${storeBase}/get/${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return res.json();
}

async function setValue(key, value) {
  const res = await fetch(`${storeBase}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  return res.json();
}
```

This pattern — a server plugin handling data and auth, with a companion frontend plugin providing the UI — is the recommended architecture for features that need both server capabilities and user interaction.

## Plugin Installation and Updates

### Installing from a Git Repository

Luker provides built-in endpoints for installing server plugins from Git repositories. When you provide a repository URL, the server:

1. Derives a folder name from the URL (e.g., `https://github.com/user/my-plugin.git` → `my-plugin`)
2. Clones the repository into the `plugins/` directory
3. Loads and initializes the plugin

If the system `git` command is available, it uses `simple-git` for the clone. If `git` is not installed, Luker falls back to `isomorphic-git` (a pure-JavaScript Git implementation) — so plugins can be installed even on systems without Git.

### Auto-Update on Startup

When `enableServerPluginsAutoUpdate` is `true` (the default), Luker automatically checks all Git-installed plugins for updates every time the server starts:

1. For each plugin directory in `plugins/`, the server checks whether it is a Git repository
2. If it is, the server fetches from the remote and compares the local HEAD to the tracking branch
3. If the remote has new commits, the server pulls the latest changes
4. Plugins with local (uncommitted) changes are skipped to avoid overwriting modifications

If `git` is unavailable, the auto-update falls back to `isomorphic-git` with the same behavior.

### Manual Installation

To install a plugin without Git:

1. Create a directory in `plugins/` (the directory name becomes the plugin folder name, unrelated to the `info.id`)
2. Place your plugin files inside (entry file or `package.json` with `"main"`)
3. Restart the Luker server

### Disabling Auto-Update

To prevent specific or all plugins from auto-updating, set the config option:

```yaml
enableServerPluginsAutoUpdate: false
```

This disables auto-update globally. Individual plugins with local changes are always skipped regardless of this setting.

## Practical Examples

### Hello World

The simplest possible server plugin — one endpoint, no dependencies:

```js
// plugins/hello-world/index.mjs

export const info = {
  id: 'hello-world',
  name: 'Hello World',
  description: 'Minimal server plugin example.',
};

export async function init(router) {
  router.get('/greet', (req, res) => {
    const name = req.query.name || 'World';
    res.json({ message: `Hello, ${name}!` });
  });
}
```

After restarting the server, test it:

```bash
curl http://localhost:8000/api/plugins/hello-world/greet?name=Luker
# → {"message":"Hello, Luker!"}
```

### API Proxy with Retry

A common server plugin pattern is proxying requests to an external API — adding authentication, retrying on failure, and keeping secrets off the client. This example is inspired by real plugins in the Luker ecosystem:

```js
// plugins/llm-proxy/index.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'llm-proxy-config.json');
const DEFAULT_CONFIG = {
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: '',
  model: 'gpt-4o-mini',
  maxRetries: 2,
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (err) {
    console.error('[llm-proxy] Failed to load config:', err.message);
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function fetchWithRetry(url, options, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500 && attempt < retries) {
        console.warn(`[llm-proxy] Server error ${response.status}, retrying (${attempt + 1}/${retries})...`);
        continue;
      }
      return response;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[llm-proxy] Network error, retrying (${attempt + 1}/${retries})...`, err.message);
        continue;
      }
      throw err;
    }
  }
}

export const info = {
  id: 'llm-proxy',
  name: 'LLM Proxy',
  description: 'Proxies LLM API requests with retry logic and server-side credential storage.',
};

export async function init(router) {
  // ── Register all routes synchronously first ──

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', configured: !!config.apiKey });
  });

  router.get('/config', (req, res) => {
    // Never expose the API key to the client
    res.json({
      apiUrl: config.apiUrl,
      model: config.model,
      maxRetries: config.maxRetries,
      hasApiKey: !!config.apiKey,
    });
  });

  router.post('/config', express.json(), (req, res) => {
    const { apiKey, apiUrl, model, maxRetries } = req.body;
    if (apiKey !== undefined) config.apiKey = String(apiKey);
    if (apiUrl !== undefined) config.apiUrl = String(apiUrl);
    if (model !== undefined) config.model = String(model);
    if (maxRetries !== undefined) config.maxRetries = Number(maxRetries);
    saveConfig();
    res.json({ ok: true });
  });

  router.post('/chat', express.json(), async (req, res) => {
    if (!config.apiKey) {
      return res.status(400).json({ error: 'API key not configured' });
    }

    const { messages, model, temperature } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid "messages" field' });
    }

    try {
      const upstream = await fetchWithRetry(config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: model || config.model,
          messages,
          temperature: temperature ?? 0.7,
        }),
      }, config.maxRetries);

      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error('[llm-proxy] Request failed:', err.message);
      res.status(502).json({ error: 'Upstream request failed', details: err.message });
    }
  });

  // ── Now safe to do async initialization ──

  loadConfig();
  console.log('[llm-proxy] Config loaded. API key:', config.apiKey ? 'set' : 'not set');
}

export async function exit() {
  console.log('[llm-proxy] Plugin unloaded.');
}
```

Key patterns demonstrated:

- **Routes registered synchronously** — all `router.get()` / `router.post()` calls happen before any `await`, ensuring the router is mounted
- **Config loaded at module scope** — `loadConfig()` is called at the end of `init()` after routes are registered; route handlers handle the "not yet loaded" case gracefully
- **Credential safety** — the `GET /config` endpoint returns `hasApiKey: true/false` but never the actual key
- **Retry logic** — transient server errors trigger retries up to `maxRetries`
- **Clean exit** — the `exit()` function allows for future cleanup (closing connections, etc.)

## See Also

- [Frontend Plugin Development](/development/frontend-plugin) — Building browser-side extensions with UI, events, and settings
- [Extension API Reference](/development/extension-api) — Complete API list with detailed parameter descriptions
- [Contributing Guide](/development/contributing) — How to submit code to Luker