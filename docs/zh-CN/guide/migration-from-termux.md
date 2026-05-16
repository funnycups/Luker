# 从 Termux 原版酒馆迁移到 Luker APK

如果你之前在 Termux 里跑原版 SillyTavern，想换用 Luker 的 Android APK，这篇指南说明如何把原有数据搬到 APK 中。Luker 与 SillyTavern 数据格式完全兼容，APK 在首次启动时会弹出导入向导，正常情况下不需要碰 `Android/data` 私有目录。

迁移完成后，你的角色卡、聊天记录、世界书、预设、用户人设、扩展设置都会照常加载。

::: tip 适用场景
本指南面向「Termux 上的 SillyTavern → Luker APK」。PC / Linux / Docker 上的 SillyTavern 迁到 Luker 服务端、或者 Termux 之间互迁，请参考 [从 SillyTavern 迁移](/zh-CN/guide/migration)。
:::

## 推荐流程：首次启动的导入向导

整套流程不需要文件管理器进入 `Android/data/` 私有目录。

### 1. 在 Termux 里把数据打成 ZIP

如果 Termux 里没有 `zip` 命令，先装一下：

```bash
pkg install zip
```

第一次跑还需要给 Termux 开存储权限，这样它才能写到共享存储：

```bash
termux-setup-storage
```

把 SillyTavern 的用户数据目录打成 ZIP，放到共享存储的 `Download/`（系统文件管理器能直接看到）：

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip default-user
```

如果你启用了多用户模式，把所有用户子目录一起打：

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip *
```

如果想把全局第三方扩展也带过去，单独打一份：

```bash
cd ~/SillyTavern/public/scripts/extensions
zip -r ~/storage/shared/Download/sillytavern-extensions.zip third-party
```

服务端 `config.yaml`（如果你之前在 Termux 里改过端口、代理之类）也复制到同一个位置，等会儿一起选：

```bash
cp ~/SillyTavern/config.yaml ~/storage/shared/Download/sillytavern-config.yaml
```

::: tip ZIP 内部前缀宽容
Luker 的导入逻辑会自动识别 ZIP 里 `characters/`、`chats/`、`worlds/` 这类子目录，不管它前面套着 `data/default-user/...`、`default-user/...`、还是直接 `characters/...`，都能正确落到对应位置。
:::

### 2. 安装 Luker APK 并触发首次启动向导

从 [GitHub Releases](https://github.com/funnycups/Luker/releases/latest) 下载安装最新 APK。

**首次打开** Luker 会弹出标题为 **「欢迎来到 Luker！」** 的引导窗口。窗口顶部可以选界面语言（Language，默认英文，建议先切到「简体中文」，下面的按钮就会变中文），中间是一块 **「从 SillyTavern 迁移」**，列出三个并排按钮：

| 按钮 | 用途 | 选什么文件 |
| --- | --- | --- |
| **「导入 Data ZIP」** | 主迁移入口，导入用户数据（角色卡 / 聊天 / 世界书 / 预设 / 密钥等） | 第 1 步打的 `sillytavern-data.zip` |
| **「导入 config.yaml」** | 把原 SillyTavern 的服务端配置带过来 | `sillytavern-config.yaml`（可选） |
| **「导入全局扩展 ZIP」** | 全局第三方扩展 | `sillytavern-extensions.zip`（可选） |

按需点对应按钮、在系统文件选择器里挑文件，等每个导入提示完成即可。三个按钮顺序无所谓，互相独立。

### 3. 完成引导后进入 Luker

引导窗口要求填一个用户名（用作默认人设名），完成后 Luker 会进入主界面。这时角色卡列表、聊天记录、世界书、预设、API 密钥都应已经在位。

## 错过了首次启动向导怎么办

如果你已经关掉了引导窗口（或者 Luker 已经用了一段时间想再次导入），可以从用户管理面板再走一次相同的导入：

1. 打开「用户设置」→ 点「账户」
2. 在用户卡片上找 **「备份与恢复」** 按钮
3. 在面板里点 **「全选」**，把所有数据类别都包含进来（也可以只勾你想恢复的类别）
4. 点 **「选择 ZIP」**，选中迁移 ZIP 文件
5. 选恢复模式 —— **「增量更新」**（按文件路径覆盖，不删别的）或 **「覆盖更新」**（先清掉所选类别再恢复）
6. 点 **「恢复备份」**

「备份与恢复」面板里也包含同样的「局域网迁移」、「下载备份 ZIP」等功能，详见下文。

## 局域网迁移（双方都已是 Luker 时）

如果你的源端已经是 Luker（另一台 Luker APK、或者 Termux 里跑的服务端 Luker），目标端也是 Luker APK，可以走更轻松的局域网迁移，完全不用打 ZIP：

1. 源端「备份与恢复」面板里点 **「创建迁移链接」**，生成一次性链接
2. 目标端把链接粘进 **「从链接迁移」** 框，点导入
3. 同局域网内自动传输 + 恢复

链接是一次性的、很快过期。SillyTavern 原版没有这个 UI，所以从原版 SillyTavern 来的迁移走不通——先按上面的 ZIP 流程到 Luker，之后的迁移就能用「局域网迁移」了。

## 兜底：手动复制到应用专属目录

只有以下情况才需要走这条路径：

- 上面的 ZIP 流程出问题（导入报错、文件管理器无法选到 ZIP）
- 你需要保留 Luker 导入逻辑识别不了的额外文件
- 你想精确替换某个特定文件而不是整体导入

Luker APK 的数据目录在 `/storage/emulated/0/Android/data/com.luker.app/files/luker-data/`，结构与 SillyTavern 的 `data/` 目录一致。Android 11+ 对这个路径加了访问限制，普通文件管理器多半进不去，需要授权或换工具。

### 1. 在 Termux 里把数据导出到共享存储

```bash
mkdir -p ~/storage/shared/Luker-migration
cp -r ~/SillyTavern/data ~/storage/shared/Luker-migration/
```

如果有第三方扩展也一起搬：

```bash
cp -r ~/SillyTavern/public/scripts/extensions/third-party \
      ~/storage/shared/Luker-migration/
```

### 2. 首次启动 Luker APK 让它创建数据目录

打开一次 APK 让 `luker-data/` 目录生成出来。这一步必须做，否则下面要复制的目标目录还不存在。

### 3. 强制停止 Luker

进入系统设置 → 应用 → Luker → **强制停止**，确保 Luker 后台服务完全退出。迁移期间不要让 Luker 在后台运行，否则它可能在你复制文件的同时改写数据。

### 4. 把数据搬进 Luker 数据目录

打开手机文件管理器，进入：

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/
```

把第 1 步导出的 `data/` 目录里的 **全部内容** 复制进来——注意是把 `data/` **内部**的文件和子目录搬进 `luker-data/`，而不是把 `data/` 整个目录搬进去。

迁移后 `luker-data/` 下应该看到：

- `default-user/`（或其他用户名子目录，多用户模式下每个用户一个）
- 默认用户内部包含 `characters/`、`chats/`、`worlds/`、`OpenAI Settings/`、`User Settings/`、`secrets.json` 等

如果有第三方扩展，把 `third-party/` 目录里的内容搬到：

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/extensions/third-party/
```

::: warning 不要覆盖 `_runtime-persist`
Luker APK 自己在 `luker-data/` 下维护一个 `_runtime-persist/` 目录，存放运行时持久化产物。**不要覆盖也不要删除它**，从原版 SillyTavern 也不会带来这个目录。
:::

### 5. 重启 Luker，验证数据

重新打开 Luker APK。等待加载完成后角色卡列表、聊天记录、世界书、预设、API 连接都应自动恢复。

### 文件管理器无法访问 Android/data？

Android 11 及以上版本对 `Android/data/` 目录加了访问限制，不同手机厂商的处理方式不同：

- **小米 / 红米（MIUI / HyperOS）**：自带「文件管理」可以打开 `Android/data`，第一次进入会要求授权
- **OPPO / 一加 / Realme（ColorOS）、vivo（OriginOS / FuntouchOS）、华为 / 荣耀**：自家文件管理器一般可以访问，部分需要在「设置 → 隐私 → 特殊权限」中授予「文件管理权限」
- **三星（One UI）**：自带「我的文件」可访问，部分版本需要长按目录授权
- **原生 Android / Pixel**：Google 自家 Files 默认不允许访问，需要换用第三方

如果你的文件管理器无法进入 `Android/data/com.luker.app/`，可选方案：

- **第三方文件管理器**：MT 管理器、MiXplorer、Solid Explorer、Material Files（开源）等对 `Android/data` 支持较好
- **电脑 USB 中转**：用 USB 线连接手机和电脑选「文件传输 / MTP」模式，在电脑上拖动文件
- **ADB 推送**：`adb push ./data/. /sdcard/Android/data/com.luker.app/files/luker-data/`，速度最快也最不容易出错

## 数据目录速查

| 内容 | Termux 原路径 | Luker APK 目标路径 |
| --- | --- | --- |
| 数据根目录 | `~/SillyTavern/data/` | `…/com.luker.app/files/luker-data/` |
| 角色卡 | `data/<user>/characters/` | `luker-data/<user>/characters/` |
| 聊天记录 | `data/<user>/chats/` | `luker-data/<user>/chats/` |
| 世界书 | `data/<user>/worlds/` | `luker-data/<user>/worlds/` |
| 预设 | `data/<user>/OpenAI Settings/` 等 | 同名子目录 |
| API 密钥 | `data/<user>/secrets.json` | 同名 |
| 第三方扩展 | `public/scripts/extensions/third-party/` | `luker-data/extensions/third-party/` |
| 服务器插件 | `plugins/` | `luker-data/plugins/` |

`<user>` 在单用户模式下通常是 `default-user`；多用户模式下每个账户对应一个子目录，目录结构相同。

## 常见问题

**首次启动没有看到欢迎引导窗口**

引导只在全新数据目录上首次打开时弹出。如果 Luker 之前已经被打开过，从用户管理面板的「备份与恢复」做同样的导入即可——点「全选」，选 ZIP，选「增量更新」，然后点「恢复备份」。

**「恢复备份」报错说归档不匹配选定的恢复类别**

ZIP 内部完全找不到 `characters/`、`chats/`、`worlds/` 这类子目录。检查一下打 ZIP 时的工作目录——`zip -r ... default-user` 是正确的；从 `~/SillyTavern` 直接 `zip -r ... data` 也行；但从 `~/` 直接 `zip -r ... SillyTavern` 把外面的源码全包进去就会失败。

**重启 Luker 后角色卡列表是空的（手动复制流程）**

检查复制层级：`luker-data/` 下应直接出现 `default-user/`（或其他用户名目录），而不是嵌套的 `luker-data/data/default-user/`。如果出现了重复的 `data/` 一层，把里面的内容上移一级。

**Luker 启动后白屏 / 报错（手动复制流程）**

可能是 `_runtime-persist/` 被覆盖或破坏。可以尝试：① 删除 `_runtime-persist/` 让 Luker 自动重建；② 仍有问题时进入「应用信息 → 存储 → 清除数据」并重新走一遍迁移流程。

**第三方扩展未加载**

确认扩展放在 `luker-data/extensions/third-party/<extension-name>/` 这一层。每个扩展都是一个目录，里面包含 `manifest.json`。

## 与 SillyTavern 双向兼容

迁移后 Luker 不会修改原 SillyTavern 数据格式，只在 `data/` 中追加自己的状态文件（如 `.luker-state.<chat_id>.json` 等）。如果你之后又想回到 Termux 上的 SillyTavern，把 `luker-data/` 的内容拷回去即可，SillyTavern 会忽略它无法识别的状态文件。

更详细的兼容性说明见 [从 SillyTavern 迁移](/zh-CN/guide/migration#数据兼容性)。

## 相关页面

- [Android App](/zh-CN/guide/android) — APK 版本介绍
- [快速开始](/zh-CN/guide/getting-started) — Luker 安装总览
- [从 SillyTavern 迁移](/zh-CN/guide/migration) — 服务端版本迁移指南
