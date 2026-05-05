# 快速开始

本指南将帮助你在几分钟内启动并运行 Luker。

## 前置条件

| 依赖 | 要求 |
| --- | --- |
| **Node.js** | >= 24.0（仅 Git Clone 方式需要） |
| **Git** | 任意版本（仅 Git Clone 方式需要） |
| **Docker** | 任意现代版本（仅 Docker 方式需要） |

你还需要准备一个可用的 LLM API（OpenAI、Claude、Google Gemini、本地模型等）。

## 安装方式一：Git Clone

适合希望自行管理和更新的用户。

### 1. 克隆仓库

```bash
git clone https://github.com/funnycups/Luker.git
cd Luker
```

### 2. 安装依赖

```bash
npm install
```

### 3. 启动服务

```bash
node server.js
```

你也可以使用仓库提供的启动脚本，它会自动安装依赖并启动：

```bash
bash start.sh
```

::: tip 其他运行时
Luker 也支持通过 Deno 或 Bun 启动：
```bash
# Deno
npm run start:deno

# Bun
npm run start:bun
```
:::

### 4. 更新

```bash
git pull
npm install
```

## 安装方式二：Docker

适合服务器部署或希望开箱即用的用户。Luker 提供了预构建的 Docker 镜像。

### 1. 创建 `docker-compose.yml`

在你希望存放数据的目录下创建 `docker-compose.yml`：

```yaml
services:
  luker:
    image: ghcr.io/funnycups/luker:latest
    container_name: luker
    ports:
      - 127.0.0.1:8000:8000
    volumes:
      - ./plugins:/home/node/app/plugins
      - ./config:/home/node/app/config
      - ./data:/home/node/app/data
      - ./extensions:/home/node/app/public/scripts/extensions/third-party
    restart: unless-stopped
```

### 2. 启动容器

```bash
docker compose up -d
```

::: warning 端口绑定与安全防护
默认配置将端口绑定到 `127.0.0.1:8000`，仅允许本机访问。如需远程访问，请将 `127.0.0.1:8000:8000` 改为 `0.0.0.0:8000:8000`，并确保做好以下安全防护：

- **反向代理 + HTTPS**：通过 Nginx 等反向代理提供 HTTPS 加密
- **启用登录机制**：开启 Basic Auth（`basicAuthMode: true`）或多用户登录（`enableUserAccounts: true`），防止未授权访问。详见 [基础配置](/zh-CN/guide/configuration#认证与多用户)
:::

### 3. 更新镜像

```bash
docker compose pull
docker compose up -d
```

## 安装方式三：Android APK

Luker 提供安卓 APP，你可以直接在手机上运行 Luker，无需依赖云服务器或 Termux。

前往 GitHub Release 页面下载最新版 APK：

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

下载并安装 APK 后，打开应用即可直接使用。

## 首次配置

### 访问 Luker

启动成功后，在浏览器中访问：

```
http://localhost:8000
```

::: tip Android 用户
APK 版本是一个独立的 App，打开后直接显示完整界面，不需要另外使用浏览器访问地址。
:::

### 配置 API 连接

首次进入 Luker 后，你需要配置至少一个 LLM API 才能开始对话：

1. 点击顶部的 **API 连接** 图标
2. 选择你的 API 类型（如 OpenAI、Claude 等）
3. 填入 API 地址和密钥
4. 测试连接是否成功

详细说明请参阅 [API 连接配置](/zh-CN/basics/connections)。

### 选择或导入角色卡

配置好 API 后，你可以：

- 从角色卡列表中选择一个角色开始对话
- 点击 **导入** 按钮，导入 `.png` 或 `.json` 格式的角色卡文件

了解更多请参阅 [角色卡基础](/zh-CN/basics/character-cards)。

## 从 SillyTavern 迁移

Luker 完全兼容 SillyTavern 的数据。如果你是 SillyTavern 用户，可以直接将 `data` 目录复制到 Luker 中使用。如果之后不想用 Luker 了，也可以随时降级回 SillyTavern，数据不会被破坏。

::: warning 备份提醒
虽然 Luker 兼容 SillyTavern 数据，但在迁移前仍建议做好备份。
:::

详细迁移指南请参阅 [从 SillyTavern 迁移](/zh-CN/guide/migration)。

## 下一步

- [配置 API 连接](/zh-CN/basics/connections) — 连接你的 LLM 服务
- [了解角色卡](/zh-CN/basics/character-cards) — 开始你的第一次角色扮演
- [从 SillyTavern 迁移](/zh-CN/guide/migration) — 如果你是 SillyTavern 用户
