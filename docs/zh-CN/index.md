---
layout: home

hero:
  name: Luker
  text: 下一代角色扮演聊天平台
  tagline: 能够记住剧情的角色、每次回复前先完成场景规划的 agent 团队、通过对话即可修改的角色卡
  actions:
    - theme: brand
      text: 快速开始
      link: /zh-CN/guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/funnycups/Luker

features:
  - icon: 🧠
    title: 记忆图
    details: 角色能够真正记住剧情。每一场戏都会被提取成带类型的节点（角色、地点、事件、剧情线），每次回复前由召回环节选出最相关的记忆并注入上下文。
  - icon: 🎭
    title: 多Agent编排
    details: 每条回复开始撰写之前，agent 团队会先完成场景规划——压缩上下文、草拟走向、审校方案。五种执行模式，从固定流水线到整支导演团队。
  - icon: 🧩
    title: 技能
    details: 可复用的知识包，agent 按需读取，用来代替一份庞大的系统提示词。兼容 Anthropic Claude Skills 格式，并且能随角色卡和预设一起分发。
  - icon: ✨
    title: 角色卡编辑助手
    details: 通过对话修改角色卡和世界书。每一批改动都以 diff 形式供你逐条批准；带 CardApp 的角色卡直接进入完整的工作台。
  - icon: 🔍
    title: 搜索插件
    details: 角色可以在对话中途联网搜索。DuckDuckGo、SearXNG、Brave 任选——既可以作为模型自行调用的工具，也可以作为预请求 agent，在生成前自动搜索并将结果写入世界书。
  - icon: 📱
    title: Android 应用
    details: 后端完全运行在应用内，一部手机同时充当服务端和界面。安装 APK 即可使用——不需要 Termux、不需要手动配置 Node、不需要端口转发。
---
