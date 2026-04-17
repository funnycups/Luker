# 从 SillyTavern 迁移

Luker 是 SillyTavern 的下游分支，保持了完整的数据兼容性。从 SillyTavern 迁移到 Luker 只需几个简单步骤，你的所有数据都可以无缝使用。

## 迁移步骤

### 1. 备份现有数据

在迁移之前，建议备份 SillyTavern 的 `data/` 目录：

```bash
cp -r SillyTavern/data/ SillyTavern-data-backup/
```

### 2. 安装 Luker

按照 [快速开始](/zh-CN/guide/getting-started) 中的步骤安装 Luker。

### 3. 复制数据目录

将 SillyTavern 的 `data/` 目录复制到 Luker 的数据根目录下（默认为 `./data`）：

```bash
cp -r SillyTavern/data/* Luker/data/
```

如果你在 `config.yaml` 中自定义了 `dataRoot`，请复制到对应路径。

### 4. 迁移配置文件

将 SillyTavern 的 `config.yaml` 中你自定义过的配置项迁移到 Luker 的 `config.yaml` 中。建议以 Luker 的默认配置文件为基础，逐项迁移你的自定义值，而不是直接覆盖整个文件。

### 5. 迁移第三方扩展

如果你安装了第三方扩展，将 SillyTavern 的全局扩展目录复制到 Luker：

```bash
cp -r SillyTavern/public/scripts/extensions/third-party/* Luker/public/scripts/extensions/third-party/
```

### 6. 复制用户设置（多用户模式）

如果你启用了多用户模式（`enableUserAccounts: true`），用户数据存储在 `data/<用户名>/` 子目录中，目录结构与 SillyTavern 一致，直接复制即可。

### 7. 启动 Luker

```bash
node server.js
```

首次启动时，Luker 会自动识别已有数据并正常加载。

## 数据兼容性

Luker 与 SillyTavern 的数据格式完全兼容，以下数据类型均可直接使用：

| 数据类型 | 兼容性 | 说明 |
| --- | --- | --- |
| 角色卡（PNG/JSON） | ✅ 完全兼容 | 支持 V1/V2 规范 |
| 聊天记录（.jsonl） | ✅ 完全兼容 | 增量同步端点向下兼容 |
| 世界书（World Info） | ✅ 完全兼容 | 条目格式不变 |
| 预设 | ✅ 完全兼容 | Luker 会自动分离连接参数 |
| 用户人设（Persona） | ✅ 完全兼容 | — |
| 扩展设置 | ✅ 完全兼容 | 第三方扩展照常工作 |
| 群聊 | ✅ 完全兼容 | — |
| API 密钥（secrets） | ✅ 完全兼容 | `secrets.json` 格式不变 |

## Luker 新增的状态文件

Luker 在运行过程中会在数据目录中生成一些额外的**状态文件**，用于存储 Luker 独有功能的数据：

- `.luker-state.<chat_id>.json` — 聊天状态文件，存储增量同步的完整性校验值等
- 角色卡状态文件 — 存储角色绑定预设、记忆图数据、编辑助手会话等
- 预设状态文件 — 存储预设关联的世界书等扩展状态

这些文件**不会影响 SillyTavern 的原始数据**。如果你需要将数据迁回 SillyTavern，只需忽略这些状态文件即可。SillyTavern 不会读取它们，也不会因为它们的存在而出错。

## 注意事项

1. **Node.js 版本**：Luker 要求 Node.js >= 20。迁移前请确认你的 Node.js 版本。

2. **第三方扩展**：SillyTavern 的第三方扩展在 Luker 中照常工作。Luker 使用相同的扩展加载机制，扩展目录位于 `public/scripts/extensions/third-party/`。

3. **配置文件**：SillyTavern 的 `config.yaml` 与 Luker 的格式兼容，但 Luker 新增了一些配置段（如 `sso`、`hostWhitelist` 等）。`requestProxy` 等配置项是 SillyTavern 已有的，无需额外处理。建议以 Luker 的默认 `config.yaml` 为基础，将你的自定义配置迁移过来。详见 [基础配置](/zh-CN/guide/configuration)。

4. **预设解耦**：Luker 将 API 连接参数与预设分离。迁移后，你的预设仍然正常工作，Luker 会在加载时自动处理字段分类。

5. **双向兼容**：由于 Luker 不修改 SillyTavern 的原始数据格式，你可以随时在两者之间切换。只需注意 Luker 独有功能（如记忆图、编排器）产生的数据在 SillyTavern 中不可用。

6. **Docker 部署**：如果你使用 Docker 部署，请参考 Luker 提供的 `docker-compose.yml` 参考配置，将数据目录挂载为卷。
