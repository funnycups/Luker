<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker —— 下一代角色扮演聊天平台" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | **简体中文** | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe/zh-CN/)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker 是一款下一代角色扮演聊天平台。和真正记得住剧情的角色对话，让一整支导演带队的 agent 团在每次回复前先把这场戏排好，通过和 AI 聊天来修改角色卡，让角色能在对话中途实时联网检索。

## Luker 是什么

Luker 是一个为大语言模型角色扮演场景专门打造的平台。开箱即用，不需要装第三方扩展，内置了：基于知识图谱的长期记忆、自带可复用技能库的多智能体场景编排、AI 辅助的角色卡编辑工作台、聊天补全预设助手、局域网同步，以及一个可在手机上运行完整后端的原生 Android 应用。

Luker 基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 深度重构而来，与其保持**双向 100% 数据兼容**。角色卡、世界书、预设、聊天记录都可以在两者之间无损搬迁，零迁移成本。

## 核心亮点

### 记忆图 —— 让角色真的记得住

一套基于知识图谱的长期记忆。每一场戏都会被提取成带类型的节点（角色、地点、事件、剧情线），节点之间互相连边。每次回复前，召回环节会在图上游走，把最相关的记忆注入上下文——所以三十轮之后用户随口问一句「通往废弃神殿的第三条路径呢」，角色能准确翻出之前的那次对话。

![记忆图演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [记忆图文档](https://luker.cups.moe/zh-CN/features/memory-graph)

### 多智能体编排 —— 一整支导演队伍替你把每场戏排好

在写作 LLM 开口之前，一支可自由配置的 agent 队伍先行执行：蒸馏器压缩最近上下文，规划师草拟下一场戏，评审员做最后审校。最终回复出来的同时，附带一份可展开检查的运行时 trace。五种执行模式任选：Spec（固定流水线）、单 Agent、Agenda（流程动态派发 agent）、Loop（单一 agent 进行循环迭代）、Director（主 agent 带一支子 agent 团队直接写正文）。

![多智能体编排演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [多智能体编排文档](https://luker.cups.moe/zh-CN/features/orchestrator/)

### 技能 —— 按需读取的可复用知识包

agent 按需读取的可复用知识包：写作规则、口吻约定、反八股清单。格式兼容 Anthropic Claude Skills，为 Claude Code 编写的技能可原样迁移至 Luker，也可迁移回去。编排器默认的 Director profile 自带 24 个内置技能，技能还可以随角色卡或预设一起分发。

<img alt="技能管理器：已安装与内置技能" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [技能文档](https://luker.cups.moe/zh-CN/features/skills/)

### CardApp Studio 与角色卡编辑助手 —— 通过和 AI 对话来编辑角色卡

一整套针对角色卡的编辑环境：CodeMirror 6 代码编辑器、AI 聊天面板、每批改动都以 diff 形式让你逐条批准。普通角色卡使用轻量弹窗版编辑助手；带 **CardApp**（内嵌在角色卡里的迷你应用）的卡片则进入功能完整的 Studio，内含文件树、实时预览、历史记录。

![CardApp Studio 演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [角色卡编辑助手](https://luker.cups.moe/zh-CN/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/zh-CN/features/card-editor/studio)

### 聊天补全预设助手 —— 通过描述构建预设

告诉助手你想让某个聊天补全预设做什么，它会与你逐轮迭代，每次改动都以 diff 形式供你审阅，直至符合预期——读取参数、编辑提示词条目、并与参考预设对比。同一套工作流也覆盖多智能体编排的预设。

<img alt="聊天补全预设助手" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [聊天补全预设助手文档](https://luker.cups.moe/zh-CN/features/preset-assistant)

### 原生 Android 应用 —— 把整个平台装进手机

Luker 的后端**内嵌于** Android 应用运行。安装 APK 并打开，即可在一部设备上获得完整的服务端与界面——无需 Termux、无需手动安装 Node、无需端口转发。首次启动界面支持备份 ZIP 导入，迁移便捷。

![Android APK 演示](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android 应用指南](https://luker.cups.moe/zh-CN/guide/android)

### 搜索插件 —— 角色也能联网搜索

为写作 LLM 提供一个实时联网搜索工具（DuckDuckGo、SearXNG、Brave），或者让搜索作为预请求 agent 在生成前自动执行，把结果写入世界书。这些结果来自真正的搜索引擎，而非训练语料中的记忆。

→ [搜索插件文档](https://luker.cups.moe/zh-CN/features/search-tools)

### 局域网同步

同一局域网内两台 Luker 实例互相配对，聊天记录、角色卡、世界书、设置在两者之间自动同步。桌面端和手机端保持一致，不用推任何东西到云上。

→ [局域网同步指南](https://luker.cups.moe/zh-CN/improvements/lan-sync)

### 聊天合并与拆分

任意位置拆分长聊天，或将两段聊天合并成一条；分支历史保持一致。适用于剧情失控、希望保留精彩片段并拆分另开分支的场景。

<img alt="聊天合并与拆分" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [聊天管理](https://luker.cups.moe/zh-CN/basics/chat-management)

### TTS NPC 对白归属

开启 TTS 之后，一条回复里每一句引号台词都可以用说话者自己的声音念出来。后台会有一个 AI 环节判断每句台词是谁说的——它发现的 NPC 会自动出现在语音映射里；你事先手动加进去的名字，从第一次播放起就能被识别。

<img alt="消息里每句台词旁的播放按钮" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS NPC 对白归属](https://luker.cups.moe/zh-CN/features/tts-npc-attribution)

### 换模型不必重配提示词

SillyTavern 中 API 连接与聊天补全预设是联动的，切换模型会连带变更你的提示词配置。Luker 把两者解耦：换模型不用重新配提示词，换预设不用重新填 API key。

### 关掉标签页，回复照样在写

生成在后端运行，通过 WebSocket 流式推送给界面。刷新标签页、合上笔记本盖、丢失 Wi-Fi——后端上的这次回复会继续写下去，你回来的那一刻自动重连到界面。没有丢失，没有重启。

→ [后端存储与生命周期](https://luker.cups.moe/zh-CN/improvements/backend-storage)

---

此外还有一长串小便利功能：预设与提示词的分组、聊天人设锁定、撤销 Toast、能看到世界书条目因何激活的追踪、从各提供商实时拉取的模型列表。详见[文档](https://luker.cups.moe/zh-CN/)。

## 界面截图

<table>
  <tr>
    <td width="50%"><img alt="记忆图检查器" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="多智能体编排运行时 trace" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp Studio 工作台" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="聊天补全预设助手" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## 开始使用

- **桌面（Node.js）** —— `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`。需要 Node.js 24 或更新版本。→ [快速开始](https://luker.cups.moe/zh-CN/guide/getting-started)
- **Android APK** —— 从 [Releases](https://github.com/funnycups/Luker/releases) 页面下载最新签名 APK，安装即用。→ [Android 应用指南](https://luker.cups.moe/zh-CN/guide/android)
- **Docker** —— 用仓库根目录的 compose 文件执行 `docker compose up`。→ [快速开始](https://luker.cups.moe/zh-CN/guide/getting-started)

## 从 SillyTavern 迁移过来？

Luker 与 SillyTavern 保持双向 100% 数据兼容。把 `data/` 目录整个拷过来即可——角色卡、世界书、预设、聊天记录、人设、设置全部无损。全局第三方扩展存放在 `data/` 之外，位于 `public/scripts/extensions/third-party/`，需要单独复制。想回去也是一样，反向拷回来；Luker 独家数据（记忆图、多智能体编排配置）存在独立状态文件里，SillyTavern 会自动忽略。**迁移前无论如何都请先做备份。**

→ [迁移指南](https://luker.cups.moe/zh-CN/guide/migration)

## 社区与反馈

- Bug 反馈和功能请求：[GitHub Issues](https://github.com/funnycups/Luker/issues)
- 提交 Issue 之前请先阅读文档：[luker.cups.moe](https://luker.cups.moe/zh-CN/)

## 参与贡献

欢迎 PR。请先阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)；提交 Issue 之前请先检索是否已有相同问题。

## 许可与鸣谢

以 **AGPL-3.0** 开源。本程序按现状分发，不附带任何担保；详见 [GNU Affero 通用公共许可证](../LICENSE)。

- 构建于 **SillyTavern** —— 由 Cohee、RossAscends、Wolfsblvt 以及 300 多位贡献者共同打造：<https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 by Humi（MIT 许可）
- 部分代码源自 CncAnon 的 TavernAITurbo mod，已获授权
- Visual Novel 模式灵感来自 [PepperTaco](https://github.com/peppertaco/Tavern/)
- Noto Sans 字体 by Google（OFL 许可）
- Lexer / Parser 使用 [Chevrotain](https://github.com/chevrotain/chevrotain)（Apache-2.0）
- 图标主题 [Font Awesome](https://fontawesome.com)（图标 CC BY 4.0、字体 SIL OFL 1.1、代码 MIT）
- 默认角色内容 by @OtisAlejandro（Seraphina）和 @kallmeflocc
- Docker 指南 by [@mrguymiah](https://github.com/mrguymiah) 与 [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js 库 by [@hexgrad](https://github.com/hexgrad)（Apache-2.0）

## 主要贡献者

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
