# 后端插件开发

Luker 的插件系统不仅支持运行在浏览器中的前端扩展，还支持运行在 Node.js 服务端的后端插件（Server Plugin）。后端插件可以访问文件系统、调用 Node.js 原生模块、代理外部 API 请求——这些是前端扩展无法做到的事情。

本文档面向希望为 Luker 开发后端插件的开发者，涵盖启用方式、模块接口、路由注册、安全注意事项和实战示例。

## 什么是后端插件

后端插件是运行在 Luker 服务器进程中的 Node.js 模块。与前端扩展（运行在浏览器中，通过 `manifest.json` + `index.js` 注入 UI）不同，后端插件：

- 运行在服务端，拥有完整的 Node.js 运行时能力
- 通过 Express Router 注册 API 端点，路由自动挂载到 `/api/plugins/{插件ID}/` 路径下
- 可以直接读写文件系统、使用 `crypto`、`child_process` 等 Node.js 内置模块
- 可以安装和使用 npm 包
- 没有沙箱隔离，与 Luker 服务器共享同一进程

一个典型的后端插件 + 前端扩展组合的工作流：前端扩展通过 `fetch` 调用后端插件暴露的 API，后端插件执行需要服务端能力的操作（如文件读写、API 代理），再将结果返回给前端。

## 何时使用后端插件

| 场景 | 前端扩展 | 后端插件 |
|------|---------|---------|
| 修改 UI、添加设置面板 | ✅ | ❌ |
| 监听聊天事件、拦截生成流程 | ✅ | ❌ |
| 读写服务器文件系统 | ❌ | ✅ |
| 代理外部 API 请求（隐藏 API Key） | ❌ | ✅ |
| 使用 Node.js 原生模块 | ❌ | ✅ |
| 安全存储凭证信息 | ❌ | ✅ |
| 启动 WebSocket 服务器 | ❌ | ✅ |
| 运行长时间后台任务 | ❌ | ✅ |

简单来说：如果只需要操作浏览器端的 UI 和数据，用前端扩展就够了；如果需要服务端能力，就写后端插件，再配一个前端扩展来调用它。

## 启用后端插件

后端插件默认不加载。需要在 `config.yaml` 中启用：

```yaml
enableServerPlugins: true
```

修改后重启 Luker 生效。插件加载时会在控制台输出日志：

```
[Plugin Loader] Loaded plugin: My Plugin (my-plugin)
```

## 插件文件结构

后端插件放置在项目根目录的 `plugins/` 文件夹下。支持以下文件结构：

### 单文件形式

```
plugins/
├── my-plugin.js      # CommonJS 格式
├── my-plugin.mjs     # ESM 格式
```

### 目录形式

```
plugins/
└── my-plugin/
    ├── package.json   # 必须包含 "main" 字段
    ├── index.js       # CommonJS 入口（优先级仅次于 package.json 的 main）
    ├── index.cjs      # CommonJS 入口（显式扩展名）
    └── index.mjs      # ESM 入口（最低优先级）
```

目录形式的入口文件解析优先级：

1. `package.json` 的 `main` 字段
2. `index.js`
3. `index.cjs`
4. `index.mjs`

### CommonJS 与 ESM

两种模块格式都支持：

**CommonJS**（使用 `module.exports`）：

```js
// plugins/my-plugin/index.js
async function init(router) {
  // 注册路由
}

async function exit() {
  // 清理资源
}

const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

module.exports = { init, exit, info };
```

> [!TIP]
> 如果 Luker 的根 `package.json` 设置了 `"type": "module"`，CommonJS 插件需要在插件目录下放置自己的 `package.json` 并设置 `"type": "commonjs"`，否则 Node.js 会将 `.js` 文件当作 ESM 处理。

**ESM**（使用 `export`）：

```js
// plugins/my-plugin/index.mjs
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

export async function init(router) {
  // 注册路由
}

export async function exit() {
  // 清理资源
}
```

## 模块接口

后端插件必须导出以下接口：

```typescript
interface PluginInfo {
  id: string;          // 插件唯一标识
  name: string;        // 显示名称
  description: string; // 插件描述
}

interface Plugin {
  init: (router: Router) => Promise<void>;  // 初始化函数
  exit: () => Promise<void>;                // 可选，服务器关闭时的清理函数
  info: PluginInfo;                         // 插件元数据
}
```

### `info` 对象（必需）

```js
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};
```

- `id`：插件的唯一标识符，用于路由挂载路径和去重
- `name`：显示在日志中的友好名称
- `description`：简要描述插件功能

### `init(router)` 函数（必需）

接收一个 Express Router 实例。在此函数中注册 API 路由：

```js
export async function init(router) {
  router.get('/hello', (req, res) => {
    res.json({ message: 'Hello from my plugin!' });
  });
}
```

所有注册在 `router` 上的路由会自动挂载到 `/api/plugins/{id}/` 路径下。上面的例子中，完整路径为 `/api/plugins/my-plugin/hello`。

### `exit()` 函数（可选）

服务器关闭时调用，用于清理资源（关闭数据库连接、停止定时器等）：

```js
export async function exit() {
  console.log('[my-plugin] Cleaning up resources...');
  // 关闭连接、清除定时器等
}
```

如果没有需要清理的资源，可以不导出此函数。

## 路由注册

### 路由路径映射

后端插件的路由自动添加 `/api/plugins/{插件ID}/` 前缀：

```js
// 插件代码
router.get('/status', handler);
router.post('/config', handler);
router.put('/data/:id', handler);
```

对应的完整 URL：

| 插件中的路由 | 完整 URL |
|-------------|---------|
| `GET /status` | `GET /api/plugins/my-plugin/status` |
| `POST /config` | `POST /api/plugins/my-plugin/config` |
| `PUT /data/:id` | `PUT /api/plugins/my-plugin/data/:id` |

### 关键细节：同步注册路由

**路由必须在 `init` 函数的第一次 `await` 之前同步注册完成。** Luker 的插件加载器仅在 `router.stack.length > 0` 时才会将路由器挂载到应用上。如果路由注册出现在异步操作之后，可能导致路由器无法正确挂载。

```js
// ✅ 正确：路由在 await 之前注册
export async function init(router) {
  router.get('/status', (req, res) => { /* ... */ });
  router.post('/config', (req, res) => { /* ... */ });

  // 异步操作放在路由注册之后
  const data = await loadData();
  cache.set('data', data);
}

// ❌ 错误：路由在 await 之后注册
export async function init(router) {
  const data = await loadData();  // 先执行了异步操作
  router.get('/status', (req, res) => { /* ... */ });  // 可能不会被挂载
}
```

### 使用 Express 中间件

后端插件可以使用 Express 中间件来处理请求：

```js
import crypto from 'node:crypto';

export async function init(router) {
  // JSON 解析中间件
  router.use(express.json({ limit: '1mb' }));

  // 自定义插件级中间件（如请求日志）
  router.use((req, res, next) => {
    console.log(`[my-plugin] ${req.method} ${req.path}`);
    next();
  });

  router.post('/data', (req, res) => {
    // req.body 已被 JSON 中间件解析
    res.json({ received: true });
  });
}
```

> [!NOTE]
> 后端插件路由自动继承 Luker 的鉴权中间件（Basic Auth、CSRF、requireLogin 等），无需在插件中自行处理认证逻辑。插件中的中间件只需关注插件自身的业务逻辑即可。

## 插件 ID 规则

插件 ID 必须符合以下规则：

- 仅允许**小写字母**（`a-z`）、**数字**（`0-9`）、**横杠**（`-`）和**下划线**（`_`）
- 符合正则表达式：`/^[a-z0-9_-]+$/`
- ID 不可重复——如果两个插件声明了相同的 ID，后加载的会被跳过并在控制台输出警告

```js
// ✅ 合法的 ID
id: 'my-plugin'
id: 'llm_proxy'
id: 'image-cache-v2'

// ❌ 非法的 ID
id: 'MyPlugin'      // 包含大写字母
id: 'my.plugin'     // 包含点号
id: 'my plugin'     // 包含空格
```

## 安全注意事项

### 没有沙箱

后端插件与 Luker 服务器运行在同一个进程中，**没有任何沙箱隔离**。插件可以：

- 访问整个文件系统
- 调用 `child_process` 执行系统命令
- 修改 Luker 的运行时状态
- 访问其他插件的数据

因此，**只安装你信任的插件**。

### 路径穿越防护

Luker 的插件加载器会检测路径穿越攻击，防止插件通过 `../../` 等方式逃逸 `plugins/` 目录。但插件自身的路由处理器中如果接受用户输入作为文件路径，仍需自行做路径校验：

```js
import path from 'path';
import fs from 'fs';

const SAFE_DIR = '/path/to/safe/directory';

router.get('/file/:name', (req, res) => {
  const resolved = path.resolve(SAFE_DIR, req.params.name);
  // 确保解析后的路径仍在安全目录内
  if (!resolved.startsWith(SAFE_DIR + path.sep)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  res.send(content);
});
```

### 凭证存储

API Key 等敏感凭证应存储在服务端（后端插件的配置文件中），而非暴露到前端：

```js
// ✅ 正确：凭证存在服务端配置文件
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const apiKey = config.apiKey;

// ❌ 错误：凭证通过前端代码传递
router.get('/key', (req, res) => {
  res.json({ apiKey: 'sk-xxx' });  // 不要这样做！
});
```

推荐将配置文件放在插件目录下，并在 `.gitignore` 中排除。实际项目中常见的做法是为配置文件使用 `.example` 后缀：

```
plugins/my-plugin/
├── config.json.example   # 提交到 Git 的示例配置
├── config.json           # 实际配置（.gitignore 排除）
└── index.js
```

## 前后端通信

后端插件通常配合前端扩展使用。前端通过 `fetch` 调用后端插件的 API 端点：

### 前端调用后端

```js
// 前端扩展中的代码
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

### 后端返回结果

```js
// 后端插件中的代码
router.post('/process', express.json(), (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text field' });
  }

  // 执行服务端操作
  const processed = doSomething(text);
  res.json({ result: processed });
});
```

### 错误处理约定

建议后端插件在出错时返回统一的 JSON 格式：

```js
res.status(500).json({ error: '描述错误原因的简短文字' });
```

前端可以通过 `response.ok` 或 `response.status` 判断请求是否成功。

## 插件安装与更新

### 手动安装

将插件文件（或目录）放入 `plugins/` 文件夹，然后重启 Luker。

### Git 自动更新

如果插件是从 Git 仓库克隆的，Luker 在启动时会自动检查更新。加载器使用 `simple-git`（如未安装则回退到 `isomorphic-git`）执行 `git pull`，拉取最新的代码。

要启用自动更新，确保插件目录是一个 Git 仓库，且 `config.yaml` 中 `enableServerPlugins` 为 `true`。

### 安装 npm 依赖

如果后端插件使用了第三方 npm 包，需要在插件目录下运行：

```bash
cd plugins/my-plugin
npm install
```

插件可以引用 Luker 根目录的 `node_modules` 中的包，无需重复安装。只有在 Luker 未安装该依赖时，才需要在插件目录下单独安装。

## 实战示例

### Hello World

一个最小的后端插件，提供一个健康检查端点：

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

启动 Luker 后，访问 `/api/plugins/hello-world/hello` 即可看到返回的 JSON 响应。

### API 代理插件

一个更实际的例子——代理外部 LLM API 请求，在前端隐藏 API Key：

```
plugins/llm-proxy/
├── index.js
├── config.json.example
└── package.json
```

**package.json**：

```json
{
  "name": "llm-proxy",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js"
}
```

**config.json.example**：

```json
{
  "apiUrl": "https://api.example.com/v1/chat/completions",
  "apiKey": "your-api-key-here",
  "model": "gpt-4"
}
```

**index.js**：

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

  // 返回插件状态（不暴露 API Key）
  router.get('/status', (req, res) => {
    res.json({
      configured: !!config?.apiKey,
      model: config?.model || 'not set',
    });
  });

  // 更新配置
  router.post('/config', (req, res) => {
    const { apiUrl, apiKey, model } = req.body;
    if (!apiUrl || !apiKey || !model) {
      return res.status(400).json({ error: 'Missing required fields: apiUrl, apiKey, model' });
    }

    config = { apiUrl, apiKey, model };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  });

  // 代理 LLM 请求
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

前端扩展调用示例：

```js
// 前端扩展代码
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

## 相关页面

- [前端插件开发](/zh-CN/development/frontend-plugin) — 前端扩展开发指南
- [Extension API 参考](/zh-CN/development/extension-api) — 前端 API 完整列表
- [贡献指南](/zh-CN/development/contributing) — 如何向 Luker 提交代码