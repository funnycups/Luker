# Server Plugin Development

Luker's plugin system supports not only frontend extensions running in the browser but also server-side plugins running in Node.js. Server plugins can access the filesystem, call native Node.js modules, and proxy external API requests — things frontend extensions cannot do.

This document is for developers building server plugins for Luker. It covers how to enable them, the module interface, route registration, security considerations, and worked examples.

## What Are Server Plugins

Server plugins are Node.js modules that run inside the Luker server process. Unlike frontend extensions (which run in the browser and inject UI via `manifest.json` + `index.js`), server plugins:

- Run on the server with full Node.js runtime access
- Register API endpoints via Express Router; routes mount automatically under `/api/plugins/{plugin-id}/`
- Can directly read/write the filesystem and use Node built-ins like `crypto`, `child_process`
- Can install and use npm packages
- Have no sandbox isolation — they share the same process as the Luker server

A typical pairing: a frontend extension calls a server plugin's API via `fetch`, the server plugin performs server-side work (file I/O, API proxying, etc.), and returns the result.

## When to Use Server Plugins

| Scenario | Frontend Plugin | Server Plugin |
|----------|-----------------|---------------|
| Modify UI, add settings panel | ✅ | ❌ |
| Listen to chat events, intercept generation | ✅ | ❌ |
| Read/write the server filesystem | ❌ | ✅ |
| Proxy external API requests (hide API keys) | ❌ | ✅ |
| Use native Node.js modules | ❌ | ✅ |
| Securely store credentials | ❌ | ✅ |
| Run a WebSocket server | ❌ | ✅ |
| Run long-lived background tasks | ❌ | ✅ |

In short: if you only need to manipulate browser-side UI and data, a frontend plugin is enough; if you need server capabilities, write a server plugin and pair it with a frontend extension that calls it.

## Enabling Server Plugins

Server plugins are not loaded by default. Enable them in `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart Luker for the change to take effect. The console will log each loaded plugin:

```
[Plugin Loader] Loaded plugin: My Plugin (my-plugin)
```

## Plugin File Structure

Server plugins live in the `plugins/` directory at the project root. Both file structures below are supported:

### Single-File Plugin

```
plugins/
├── my-plugin.js      # CommonJS
├── my-plugin.mjs     # ESM
```

### Directory Plugin

```
plugins/
└── my-plugin/
    ├── package.json   # Must include the "main" field
    ├── index.js       # CommonJS entry (next priority after package.json main)
    ├── index.cjs      # CommonJS entry (explicit extension)
    └── index.mjs      # ESM entry (lowest priority)
```

Entry resolution priority for directory plugins:

1. `package.json`'s `main` field
2. `index.js`
3. `index.cjs`
4. `index.mjs`

### CommonJS and ESM

Both module formats are supported:

**CommonJS** (using `module.exports`):

```js
// plugins/my-plugin/index.js
async function init(router) {
  // Register routes
}

async function exit() {
  // Clean up resources
}

const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

module.exports = { init, exit, info };
```

> [!TIP]
> If Luker's root `package.json` has `"type": "module"`, a CommonJS plugin must place its own `package.json` in the plugin directory with `"type": "commonjs"`, otherwise Node.js will treat `.js` files as ESM.

**ESM** (using `export`):

```js
// plugins/my-plugin/index.mjs
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

export async function init(router) {
  // Register routes
}

export async function exit() {
  // Clean up resources
}
```

## Module Interface

A server plugin must export the following interface:

```typescript
interface PluginInfo {
  id: string;          // Unique plugin identifier
  name: string;        // Display name
  description: string; // Plugin description
}

interface Plugin {
  init: (router: Router) => Promise<void>;  // Initialization function
  exit: () => Promise<void>;                // Optional, cleanup on shutdown
  info: PluginInfo;                         // Plugin metadata
}
```

### `info` Object (Required)

```js
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};
```

- `id`: A unique plugin identifier used as the route mount path and for de-duplication
- `name`: Friendly display name shown in logs
- `description`: A short summary of the plugin's purpose

### `init(router)` Function (Required)

Receives an Express Router instance. Register API routes here:

```js
export async function init(router) {
  router.get('/hello', (req, res) => {
    res.json({ message: 'Hello from my plugin!' });
  });
}
```

Routes registered on `router` are automatically mounted under `/api/plugins/{id}/`. In the example above, the full path is `/api/plugins/my-plugin/hello`.

### `exit()` Function (Optional)

Called when the server shuts down. Use it to release resources (close database connections, stop timers, etc.):

```js
export async function exit() {
  console.log('[my-plugin] Cleaning up resources...');
  // Close connections, clear timers, etc.
}
```

If your plugin has nothing to clean up, you can omit this export.

## Route Registration

### Route Path Mapping

Server plugin routes are automatically prefixed with `/api/plugins/{plugin-id}/`:

```js
// Plugin code
router.get('/status', handler);
router.post('/config', handler);
router.put('/data/:id', handler);
```

The corresponding full URLs:

| Route in plugin | Full URL |
|-----------------|----------|
| `GET /status` | `GET /api/plugins/my-plugin/status` |
| `POST /config` | `POST /api/plugins/my-plugin/config` |
| `PUT /data/:id` | `PUT /api/plugins/my-plugin/data/:id` |

### Important: Register Routes Synchronously

**Routes must be registered synchronously, before the first `await` in `init`.** Luker's plugin loader only mounts the router on the app when `router.stack.length > 0`. If route registration happens after an asynchronous operation, the router may not be mounted correctly.

```js
// ✅ Correct: routes registered before await
export async function init(router) {
  router.get('/status', (req, res) => { /* ... */ });
  router.post('/config', (req, res) => { /* ... */ });

  // Async operations happen after route registration
  const data = await loadData();
  cache.set('data', data);
}

// ❌ Wrong: routes registered after await
export async function init(router) {
  const data = await loadData();  // Async first
  router.get('/status', (req, res) => { /* ... */ });  // May not get mounted
}
```

### Using Express Middleware

Server plugins can use Express middleware to process requests:

```js
import crypto from 'node:crypto';

export async function init(router) {
  // JSON body parser
  router.use(express.json({ limit: '1mb' }));

  // Custom plugin-level middleware (e.g., request logging)
  router.use((req, res, next) => {
    console.log(`[my-plugin] ${req.method} ${req.path}`);
    next();
  });

  router.post('/data', (req, res) => {
    // req.body has been parsed by the JSON middleware
    res.json({ received: true });
  });
}
```

> [!NOTE]
> Server plugin routes automatically inherit Luker's authentication middleware (Basic Auth, CSRF, requireLogin, etc.); you don't need to implement auth inside the plugin. Plugin-level middleware can focus on business logic only.

## Plugin ID Rules

Plugin IDs must follow these rules:

- Only **lowercase letters** (`a-z`), **digits** (`0-9`), **hyphens** (`-`), and **underscores** (`_`) are allowed
- Must match the regex `/^[a-z0-9_-]+$/`
- IDs must be unique — if two plugins declare the same ID, the later-loaded one is skipped and a warning is logged

```js
// ✅ Valid IDs
id: 'my-plugin'
id: 'llm_proxy'
id: 'image-cache-v2'

// ❌ Invalid IDs
id: 'MyPlugin'      // Contains uppercase
id: 'my.plugin'     // Contains a dot
id: 'my plugin'     // Contains a space
```

## Security Considerations

### No Sandbox

Server plugins run in the same process as the Luker server, with **no sandbox isolation**. A plugin can:

- Access the entire filesystem
- Call `child_process` to run system commands
- Modify Luker's runtime state
- Access other plugins' data

For this reason, **only install plugins you trust**.

### Path Traversal Protection

Luker's plugin loader detects path traversal attempts and prevents plugins from escaping the `plugins/` directory via `../../`. However, if a plugin's route handlers accept user input as a file path, the plugin must still validate the path itself:

```js
import path from 'path';
import fs from 'fs';

const SAFE_DIR = '/path/to/safe/directory';

router.get('/file/:name', (req, res) => {
  const resolved = path.resolve(SAFE_DIR, req.params.name);
  // Ensure the resolved path stays inside the safe directory
  if (!resolved.startsWith(SAFE_DIR + path.sep)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  res.send(content);
});
```

### Credential Storage

API keys and other sensitive credentials should live on the server (in the plugin's config file), not be exposed to the frontend:

```js
// ✅ Correct: credentials stored in a server-side config file
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const apiKey = config.apiKey;

// ❌ Wrong: credentials passed to the frontend
router.get('/key', (req, res) => {
  res.json({ apiKey: 'sk-xxx' });  // Don't do this!
});
```

A common pattern is to keep config files in the plugin directory and add them to `.gitignore`. Provide an `.example` version that's safe to commit:

```
plugins/my-plugin/
├── config.json.example   # Example config committed to Git
├── config.json           # Real config (excluded by .gitignore)
└── index.js
```

## Frontend-Backend Communication

Server plugins are typically paired with a frontend extension. The frontend calls the server plugin's API endpoints via `fetch`:

### Frontend Calls Backend

```js
// Code in a frontend extension
async function callBackend() {
  const response = await fetch('/api/plugins/my-plugin/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'some input' }),
  });

  if (!response.ok) {
    console.error('Backend request failed:', response.status);
    return;
  }

  const result = await response.json();
  console.log('Result:', result);
}
```

### Backend Returns Results

```js
// Code in a server plugin
router.post('/process', express.json(), (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text field' });
  }

  // Perform server-side work
  const processed = doSomething(text);
  res.json({ result: processed });
});
```

### Error Handling Convention

We recommend server plugins return errors in a consistent JSON shape:

```js
res.status(500).json({ error: 'Short text describing the failure' });
```

The frontend can use `response.ok` or `response.status` to determine whether the request succeeded.

## Plugin Installation and Updates

### Manual Installation

Drop the plugin file (or directory) into the `plugins/` folder, then restart Luker.

### Git Auto-Update

If a plugin was cloned from a Git repo, Luker checks for updates on startup. The loader uses `simple-git` (falling back to `isomorphic-git` if unavailable) to run `git pull` and fetch the latest code.

To enable auto-update, make sure the plugin directory is a Git repository and `enableServerPlugins` is `true` in `config.yaml`.

### Installing npm Dependencies

If your server plugin uses third-party npm packages, install them in the plugin directory:

```bash
cd plugins/my-plugin
npm install
```

A plugin can also reference packages from Luker's root `node_modules` without reinstalling. Only install dependencies inside the plugin directory if Luker doesn't already provide them.

## Worked Examples

### Hello World

A minimal server plugin with a single health-check endpoint:

```
plugins/hello-world/
└── index.mjs
```

```js
// plugins/hello-world/index.mjs
export const info = {
  id: 'hello-world',
  name: 'Hello World',
  description: 'A minimal server plugin example',
};

export async function init(router) {
  router.get('/hello', (req, res) => {
    res.json({ message: 'Hello from server plugin!', time: new Date().toISOString() });
  });

  console.log(`[${info.id}] Plugin loaded.`);
}
```

After starting Luker, visit `/api/plugins/hello-world/hello` to see the JSON response.

### API Proxy Plugin

A more practical example — proxy an external LLM API and hide the API key from the frontend:

```
plugins/llm-proxy/
├── index.js
├── config.json.example
└── package.json
```

**package.json**:

```json
{
  "name": "llm-proxy",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js"
}
```

**config.json.example**:

```json
{
  "apiUrl": "https://api.example.com/v1/chat/completions",
  "apiKey": "your-api-key-here",
  "model": "gpt-4"
}
```

**index.js**:

```js
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const info = {
  id: 'llm-proxy',
  name: 'LLM API Proxy',
  description: 'Proxies LLM API requests with server-side credential storage',
};

let config = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error(`[${info.id}] Failed to load config:`, err.message);
  }
}

async function init(router) {
  loadConfig();

  // Return plugin status (without exposing the API key)
  router.get('/status', (req, res) => {
    res.json({
      configured: !!config?.apiKey,
      model: config?.model || 'not set',
    });
  });

  // Update configuration
  router.post('/config', (req, res) => {
    const { apiUrl, apiKey, model } = req.body;
    if (!apiUrl || !apiKey || !model) {
      return res.status(400).json({ error: 'Missing required fields: apiUrl, apiKey, model' });
    }

    config = { apiUrl, apiKey, model };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  });

  // Proxy LLM requests
  router.post('/chat', async (req, res) => {
    if (!config?.apiKey) {
      return res.status(503).json({ error: 'Plugin not configured. Set config via POST /config first.' });
    }

    const { messages, temperature } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages field' });
    }

    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: temperature ?? 0.7,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const body = await response.text();
        return res.status(502).json({ error: `Upstream API error (${response.status}): ${body.slice(0, 200)}` });
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        return res.status(502).json({ error: 'Upstream API returned empty response' });
      }

      res.json({ text });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return res.status(504).json({ error: 'Upstream API request timed out' });
      }
      console.error(`[${info.id}] Chat request failed:`, err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  console.log(`[${info.id}] Plugin loaded. Configured: ${!!config?.apiKey}`);
}

async function exit() {
  console.log(`[${info.id}] Plugin unloaded.`);
}

module.exports = { init, exit, info };
```

A frontend extension calling this plugin:

```js
// Frontend extension code
async function queryLLM(messages) {
  const res = await fetch('/api/plugins/llm-proxy/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0.8 }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Request failed: ${res.status}`);
  }

  const data = await res.json();
  return data.text;
}
```

## Related Pages

- [Frontend Plugin Development](/development/frontend-plugin) — Frontend extension development guide
- [Extension API Reference](/development/extension-api/) — Full frontend API list
- [Contributing](/development/contributing) — How to contribute code to Luker
