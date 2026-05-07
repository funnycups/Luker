# 贡献指南

感谢你对 Luker 项目的关注！本文档介绍如何为 Luker 贡献代码、文档和其他改进。

## 开发环境准备

1. **Fork 仓库**：在 GitHub 上 fork Luker 仓库到你的账户下。

2. **克隆到本地**：

```bash
git clone https://github.com/<your-username>/Luker.git
cd Luker
```

3. **安装依赖**：

```bash
npm install
```

4. **启动开发服务器**：

```bash
node server.js
```

默认监听 `http://localhost:8000`。可通过命令行参数或 `config.yaml` 修改端口。

## 分支策略

- **`release`** — 稳定分支，始终保持可发布状态。所有 PR 应以 `release` 为目标分支
- 功能开发请从 `release` 创建特性分支

```bash
git checkout -b feat/my-new-feature release
```

> [!IMPORTANT]
Luker 的稳定分支是 `release`。

分支命名建议：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新功能 | `feat/memory-graph-export` |
| `fix/` | Bug 修复 | `fix/chat-sync-race-condition` |
| `docs/` | 文档改进 | `docs/extension-api-examples` |
| `refactor/` | 代码重构 | `refactor/preset-manager` |
| `chore/` | 构建/工具链 | `chore/update-dependencies` |

## Commit 规范

Luker 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**类型（type）：**

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码格式（不影响逻辑） |
| `refactor` | 重构（不新增功能或修复 bug） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具链/依赖更新 |

**示例：**

```
feat(memory-graph): add hierarchical compression for event nodes

fix(search-tools): handle empty query in web search

docs(extension-api): add examples for registerExtensionApi
```

## Pull Request 流程

1. **确保代码质量**：提交前检查代码风格和基本功能。

2. **推送分支**：

```bash
git push origin feat/my-new-feature
```

3. **创建 PR**：在 GitHub 上创建 Pull Request，目标分支为 `release`。

4. **PR 描述**：清晰描述改动内容、动机和影响。如果关联了 Issue，请引用。

5. **代码审查**：维护者会审查代码并提供反馈。请及时响应审查意见。

6. **合并**：审查通过后，维护者会合并 PR。

## 代码风格

### 基本规则

- **缩进**：4 空格
- **引号**：单引号（JavaScript）
- **分号**：必须使用
- **换行符**：LF（`\n`），不使用 CRLF
- **文件末尾**：保留一个空行

> [!IMPORTANT]
> 所有文件必须使用 LF 换行符。Windows 用户请配置 Git：
> ```bash
> git config core.autocrlf input
> ```
> 或在 `.gitattributes` 中确保 `* text=auto eol=lf`。

### 命名规范

| 场景 | 风格 | 示例 |
|------|------|------|
| 变量和函数 | `camelCase` | `loadSettings()` |
| 常量 | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUT` |
| CSS 类名 | `kebab-case` | `chat-message-container` |
| 文件名 | `kebab-case` | `preset-manager.js` |

### 模块系统

- **前端代码**：ES Module（`import`/`export`）
- **后端代码**：ES Module（`import`/`export`）

### 注释

- 关键逻辑和公共 API 需要 JSDoc 注释
- 复杂的算法或业务逻辑应有行内注释说明意图
- 避免无意义的注释（如 `// 增加计数器` 后面跟 `counter++`）

## 项目结构概览

```
Luker/
├── server.js              # 服务器入口
├── src/                   # 后端源码
│   ├── endpoints/         # API 路由
│   └── middleware/        # 中间件
├── public/                # 前端资源
│   ├── scripts/           # 前端脚本
│   │   ├── extensions/    # 内置扩展
│   │   │   └── third-party/  # 第三方插件
│   │   └── ...            # 核心模块
│   └── ...                # 静态资源
├── docs/                  # 文档（英文版位于根目录）
│   ├── zh-CN/             # 简体中文文档
│   └── zh-TW/             # 繁体中文文档
└── config.yaml            # 服务器配置
```

## 测试

- 新功能应包含基本的功能验证
- Bug 修复应说明复现步骤和修复方案
- 确保改动不会破坏现有功能
- 测试多种浏览器和设备（如适用）

## 文档贡献

文档位于 `docs/` 目录下，使用 Markdown 格式：

- 英文文档：`docs/`（根目录）
- 简体中文文档：`docs/zh-CN/`
- 繁体中文文档：`docs/zh-TW/`

文档贡献同样遵循上述 PR 流程。编写文档时请注意：

- 使用准确的技术术语
- 代码和 API 名称保留英文
- 适当使用代码块和表格
- 交叉引用：英文版使用无前缀路径（如 `/development/contributing`），中文版使用 `/zh-CN/` 或 `/zh-TW/` 前缀
- 所有文件使用 LF 换行符

## 报告问题

如果你发现了 bug 或有功能建议，请在 GitHub Issues 中提交。提交 Issue 时请包含：

- 问题描述
- 复现步骤（如适用）
- 预期行为与实际行为
- 环境信息（操作系统、Node.js 版本、浏览器）

## 行为准则

请尊重所有贡献者和用户。保持友善、专业的交流态度。

## 相关页面

- [前端插件开发](/zh-CN/development/frontend-plugin) — 第三方插件开发入门
- [扩展 API 参考](/zh-CN/development/extension-api/) — 完整的 API 文档
- [角色卡开发](/zh-CN/development/card-developers) — 角色卡扩展功能
