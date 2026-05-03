# 後端外掛開發

Luker 的外掛系統不僅支援執行在瀏覽器中的前端擴展，還支援執行在 Node.js 伺服端的後端外掛（Server Plugin）。後端外掛可以存取檔案系統、呼叫 Node.js 原生模組、代理外部 API 請求——這些是前端擴展無法做到的事情。

本文檔面向希望為 Luker 開發後端外掛的開發者，涵蓋啟用方式、模組介面、路由註冊、安全注意事項和實戰範例。

## 什麼是後端外掛

後端外掛是執行在 Luker 伺服器進程中的 Node.js 模組。與前端擴展（執行在瀏覽器中，透過 `manifest.json` + `index.js` 注入 UI）不同，後端外掛：

- 執行在伺服端，擁有完整的 Node.js 執行時能力
- 透過 Express Router 註冊 API 端點，路由自動掛載到 `/api/plugins/{外掛ID}/` 路徑下
- 可以直接讀寫檔案系統、使用 `crypto`、`child_process` 等 Node.js 內建模組
- 可以安裝和使用 npm 套件
- 沒有沙箱隔離，與 Luker 伺服器共享同一進程

一個典型的後端外掛 + 前端擴展組合的工作流：前端擴展透過 `fetch` 呼叫後端外掛暴露的 API，後端外掛執行需要伺服端能力的操作（如檔案讀寫、API 代理），再將結果回傳給前端。

## 何時使用後端外掛

| 場景 | 前端擴展 | 後端外掛 |
|------|---------|---------|
| 修改 UI、新增設定面板 | ✅ | ❌ |
| 監聽聊天事件、攔截生成流程 | ✅ | ❌ |
| 讀寫伺服器檔案系統 | ❌ | ✅ |
| 代理外部 API 請求（隱藏 API Key） | ❌ | ✅ |
| 使用 Node.js 原生模組 | ❌ | ✅ |
| 安全儲存憑證資訊 | ❌ | ✅ |
| 啟動 WebSocket 伺服器 | ❌ | ✅ |
| 執行長時間背景任務 | ❌ | ✅ |

簡單來說：如果只需要操作瀏覽器端的 UI 和資料，用前端擴展就夠了；如果需要伺服端能力，就寫後端外掛，再配一個前端擴展來呼叫它。

## 啟用後端外掛

後端外掛預設不載入。需要在 `config.yaml` 中啟用：

```yaml
enableServerPlugins: true
```

修改後重啟 Luker 生效。外掛載入時會在控制台輸出日誌：

```
[Plugin Loader] Loaded plugin: My Plugin (my-plugin)
```

## 外掛檔案結構

後端外掛放置在專案根目錄的 `plugins/` 資料夾下。支援以下檔案結構：

### 單檔案形式

```
plugins/
├── my-plugin.js      # CommonJS 格式
├── my-plugin.mjs     # ESM 格式
```

### 目錄形式

```
plugins/
└── my-plugin/
    ├── package.json   # 必須包含 "main" 欄位
    ├── index.js       # CommonJS 入口（優先級僅次於 package.json 的 main）
    └── index.mjs      # ESM 入口（最低優先級）
```

目錄形式的入口檔案解析優先級：

1. `package.json` 的 `main` 欄位
2. `index.js`
3. `index.mjs`

### CommonJS 與 ESM

兩種模組格式都支援：

**CommonJS**（使用 `module.exports`）：

```js
// plugins/my-plugin/index.js
async function init(router) {
  // 註冊路由
}

async function exit() {
  // 清理資源
}

const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

module.exports = { init, exit, info };
```

> [!TIP]
> 如果 Luker 的根 `package.json` 設定了 `"type": "module"`，CommonJS 外掛需要在外掛目錄下放置自己的 `package.json` 並設定 `"type": "commonjs"`，否則 Node.js 會將 `.js` 檔案當作 ESM 處理。

**ESM**（使用 `export`）：

```js
// plugins/my-plugin/index.mjs
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};

export async function init(router) {
  // 註冊路由
}

export async function exit() {
  // 清理資源
}
```

## 模組介面

後端外掛必須匯出以下介面：

```typescript
interface PluginInfo {
  id: string;          // 外掛唯一標識
  name: string;        // 顯示名稱
  description: string; // 外掛描述
}

interface Plugin {
  init: (router: Router) => Promise<void>;  // 初始化函式
  exit: () => Promise<void>;                // 可選，伺服器關閉時的清理函式
  info: PluginInfo;                         // 外掛元資料
}
```

### `info` 物件（必需）

```js
export const info = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'A sample server plugin',
};
```

- `id`：外掛的唯一識別碼，用於路由掛載路徑和去重
- `name`：顯示在日誌中的友善名稱
- `description`：簡要描述外掛功能

### `init(router)` 函式（必需）

接收一個 Express Router 實例。在此函式中註冊 API 路由：

```js
export async function init(router) {
  router.get('/hello', (req, res) => {
    res.json({ message: 'Hello from my plugin!' });
  });
}
```

所有註冊在 `router` 上的路由會自動掛載到 `/api/plugins/{id}/` 路徑下。上面的例子中，完整路徑為 `/api/plugins/my-plugin/hello`。

### `exit()` 函式（可選）

伺服器關閉時呼叫，用於清理資源（關閉資料庫連線、停止計時器等）：

```js
export async function exit() {
  console.log('[my-plugin] Cleaning up resources...');
  // 關閉連線、清除計時器等
}
```

如果沒有需要清理的資源，可以不匯出此函式。

## 路由註冊

### 路由路徑對應

後端外掛的路由自動新增 `/api/plugins/{外掛ID}/` 前綴：

```js
// 外掛程式碼
router.get('/status', handler);
router.post('/config', handler);
router.put('/data/:id', handler);
```

對應的完整 URL：

| 外掛中的路由 | 完整 URL |
|-------------|---------|
| `GET /status` | `GET /api/plugins/my-plugin/status` |
| `POST /config` | `POST /api/plugins/my-plugin/config` |
| `PUT /data/:id` | `PUT /api/plugins/my-plugin/data/:id` |

### 關鍵細節：同步註冊路由

**路由必須在 `init` 函式的第一次 `await` 之前同步註冊完成。** Luker 的外掛載入器僅在 `router.stack.length > 0` 時才會將路由器掛載到應用上。如果路由註冊出現在非同步操作之後，可能導致路由器無法正確掛載。

```js
// ✅ 正確：路由在 await 之前註冊
export async function init(router) {
  router.get('/status', (req, res) => { /* ... */ });
  router.post('/config', (req, res) => { /* ... */ });

  // 非同步操作放在路由註冊之後
  const data = await loadData();
  cache.set('data', data);
}

// ❌ 錯誤：路由在 await 之後註冊
export async function init(router) {
  const data = await loadData();  // 先執行了非同步操作
  router.get('/status', (req, res) => { /* ... */ });  // 可能不會被掛載
}
```

### 使用 Express 中介軟體

後端外掛可以使用 Express 中介軟體來處理請求：

```js
import crypto from 'node:crypto';

export async function init(router) {
  // JSON 解析中介軟體
  router.use(express.json({ limit: '1mb' }));

  // 自訂外掛級中介軟體（如請求日誌）
  router.use((req, res, next) => {
    console.log(`[my-plugin] ${req.method} ${req.path}`);
    next();
  });

  router.post('/data', (req, res) => {
    // req.body 已被 JSON 中介軟體解析
    res.json({ received: true });
  });
}
```

> [!NOTE]
> 後端外掛路由自動繼承 Luker 的鑑權中介軟體（Basic Auth、CSRF、requireLogin 等），無需在外掛中自行處理認證邏輯。外掛中的中介軟體只需關注外掛自身的業務邏輯即可。

## 外掛 ID 規則

外掛 ID 必須符合以下規則：

- 僅允許**小寫字母**（`a-z`）、**數字**（`0-9`）、**橫槓**（`-`）和**底線**（`_`）
- 符合正規表示式：`/^[a-z0-9_-]+$/`
- ID 不可重複——如果兩個外掛聲明了相同的 ID，後載入的會被跳過並在控制台輸出警告

```js
// ✅ 合法的 ID
id: 'my-plugin'
id: 'llm_proxy'
id: 'image-cache-v2'

// ❌ 非法的 ID
id: 'MyPlugin'      // 包含大寫字母
id: 'my.plugin'     // 包含點號
id: 'my plugin'     // 包含空格
```

## 安全注意事項

### 沒有沙箱

後端外掛與 Luker 伺服器執行在同一個進程中，**沒有任何沙箱隔離**。外掛可以：

- 存取整個檔案系統
- 呼叫 `child_process` 執行系統命令
- 修改 Luker 的執行時狀態
- 存取其他外掛的資料

因此，**只安裝你信任的外掛**。

### 路徑穿越防護

Luker 的外掛載入器會偵測路徑穿越攻擊，防止外掛透過 `../../` 等方式逃逸 `plugins/` 目錄。但外掛自身的路由處理器中如果接受使用者輸入作為檔案路徑，仍需自行做路徑校驗：

```js
import path from 'path';
import fs from 'fs';

const SAFE_DIR = '/path/to/safe/directory';

router.get('/file/:name', (req, res) => {
  const resolved = path.resolve(SAFE_DIR, req.params.name);
  // 確保解析後的路徑仍在安全目錄內
  if (!resolved.startsWith(SAFE_DIR + path.sep)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  res.send(content);
});
```

### 憑證儲存

API Key 等敏感憑證應儲存在伺服端（後端外掛的設定檔中），而非暴露到前端：

```js
// ✅ 正確：憑證存在伺服端設定檔
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const apiKey = config.apiKey;

// ❌ 錯誤：憑證透過前端程式碼傳遞
router.get('/key', (req, res) => {
  res.json({ apiKey: 'sk-xxx' });  // 不要這樣做！
});
```

推薦將設定檔放在外掛目錄下，並在 `.gitignore` 中排除。實際專案中常見的做法是為設定檔使用 `.example` 後綴：

```
plugins/my-plugin/
├── config.json.example   # 提交到 Git 的範例設定
├── config.json           # 實際設定（.gitignore 排除）
└── index.js
```

## 前後端通訊

後端外掛通常配合前端擴展使用。前端透過 `fetch` 呼叫後端外掛的 API 端點：

### 前端呼叫後端

```js
// 前端擴展中的程式碼
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

### 後端回傳結果

```js
// 後端外掛中的程式碼
router.post('/process', express.json(), (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text field' });
  }

  // 執行伺服端操作
  const processed = doSomething(text);
  res.json({ result: processed });
});
```

### 錯誤處理約定

建議後端外掛在出錯時回傳統一的 JSON 格式：

```js
res.status(500).json({ error: '描述錯誤原因的簡短文字' });
```

前端可以透過 `response.ok` 或 `response.status` 判斷請求是否成功。

## 外掛安裝與更新

### 手動安裝

將外掛檔案（或目錄）放入 `plugins/` 資料夾，然後重啟 Luker。

### Git 自動更新

如果外掛是從 Git 儲存庫克隆的，Luker 在啟動時會自動檢查更新。載入器使用 `simple-git`（如未安裝則回退到 `isomorphic-git`）執行 `git pull`，拉取最新的程式碼。

要啟用自動更新，確保外掛目錄是一個 Git 儲存庫，且 `config.yaml` 中 `enableServerPlugins` 為 `true`。

### 安裝 npm 相依套件

如果後端外掛使用了第三方 npm 套件，需要在外掛目錄下執行：

```bash
cd plugins/my-plugin
npm install
```

外掛可以引用 Luker 根目錄的 `node_modules` 中的套件，無需重複安裝。只有在 Luker 未安裝該相依時，才需要在外掛目錄下單獨安裝。

## 實戰範例

### Hello World

一個最小的後端外掛，提供一個健康檢查端點：

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

啟動 Luker 後，造訪 `/api/plugins/hello-world/hello` 即可看到回傳的 JSON 回應。

### API 代理外掛

一個更實際的例子——代理外部 LLM API 請求，在前端隱藏 API Key：

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

  // 回傳外掛狀態（不暴露 API Key）
  router.get('/status', (req, res) => {
    res.json({
      configured: !!config?.apiKey,
      model: config?.model || 'not set',
    });
  });

  // 更新設定
  router.post('/config', (req, res) => {
    const { apiUrl, apiKey, model } = req.body;
    if (!apiUrl || !apiKey || !model) {
      return res.status(400).json({ error: 'Missing required fields: apiUrl, apiKey, model' });
    }

    config = { apiUrl, apiKey, model };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  });

  // 代理 LLM 請求
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

前端擴展呼叫範例：

```js
// 前端擴展程式碼
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

## 相關頁面

- [前端外掛開發](/zh-TW/development/frontend-plugin) — 前端擴展開發指南
- [Extension API 參考](/zh-TW/development/extension-api/) — 前端 API 完整列表
- [貢獻指南](/zh-TW/development/contributing) — 如何向 Luker 提交程式碼