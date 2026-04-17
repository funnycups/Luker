import { defineConfig } from 'vitepress'

const zhCNSidebar = [
  {
  text: '入门指南',
  items: [
  { text: 'Luker 是什么', link: '/zh-CN/guide/what-is-luker' },
  { text: '快速开始', link: '/zh-CN/guide/getting-started' },
  { text: '从 SillyTavern 迁移', link: '/zh-CN/guide/migration' },
  { text: '基础配置', link: '/zh-CN/guide/configuration' },
  { text: '鉴权与安全', link: '/zh-CN/guide/authentication' },
  { text: 'Android App', link: '/zh-CN/guide/android' },
  ],
  },
  {
  text: '基础概念',
  items: [
  { text: '角色卡基础', link: '/zh-CN/basics/character-cards' },
  { text: '世界书基础', link: '/zh-CN/basics/world-info' },
  { text: '预设系统', link: '/zh-CN/basics/presets' },
  { text: 'API 连接', link: '/zh-CN/basics/connections' },
  { text: '聊天管理', link: '/zh-CN/basics/chat-management' },
  ],
  },
  {
  text: '技术改进',
  items: [
  { text: '改进总览', link: '/zh-CN/improvements/overview' },
  { text: '增量同步', link: '/zh-CN/improvements/incremental-sync' },
  { text: '预设解耦', link: '/zh-CN/improvements/preset-decoupling' },
  { text: '角色卡绑定预设与人设', link: '/zh-CN/improvements/card-bound-presets' },
  { text: '函数调用运行时', link: '/zh-CN/improvements/function-call-runtime' },
  { text: '后端实时存储', link: '/zh-CN/improvements/backend-storage' },
  { text: '请求检查器', link: '/zh-CN/improvements/request-inspector' },
  { text: '统一生成层', link: '/zh-CN/improvements/generation-layer' },
      { text: '性能优化', link: '/zh-CN/improvements/performance' },
      { text: '预设关联世界书', link: '/zh-CN/improvements/preset-world-info' },
      { text: 'WebSocket 代理', link: '/zh-CN/improvements/ws-proxy' },
      { text: '认证与配额', link: '/zh-CN/improvements/auth-and-quota' },
  { text: '其他改进', link: '/zh-CN/improvements/other' },
  ],
  },
  {
  text: '独有功能',
  items: [
  { text: '记忆图', link: '/zh-CN/features/memory-graph' },
  { text: '多Agent编排', link: '/zh-CN/features/orchestrator' },
  { text: '角色卡编辑助手', link: '/zh-CN/features/card-editor' },
  { text: '搜索插件', link: '/zh-CN/features/search-tools' },
  { text: '补全预设助手', link: '/zh-CN/features/preset-assistant' },
  { text: 'CardApp', link: '/zh-CN/features/cardapp' },
  { text: '状态系统', link: '/zh-CN/features/state-system' },
      { text: '日志系统', link: '/zh-CN/features/logging' },
  { text: '提示词分组', link: '/zh-CN/features/prompt-groups' },
  { text: '预设分组', link: '/zh-CN/features/preset-groups' },
      { text: '钩子执行排序', link: '/zh-CN/features/hook-order' },
      { text: '世界书激活链路追踪', link: '/zh-CN/features/world-info-trace' },
      { text: '插件注册正则', link: '/zh-CN/features/regex-provider' },
      { text: '其他功能', link: '/zh-CN/features/other-features' },
  ],
  },
  {
  text: '开发文档',
  items: [
  { text: '插件开发基础', link: '/zh-CN/development/plugin-basics' },
  { text: 'Extension API 参考', link: '/zh-CN/development/extension-api' },
  { text: '角色卡开发者指南', link: '/zh-CN/development/card-developers' },
  { text: '贡献指南', link: '/zh-CN/development/contributing' },
  ],
  },
]

const zhTWSidebar = [
  {
    text: '入門指南',
    items: [
      { text: 'Luker 是什麼', link: '/zh-TW/guide/what-is-luker' },
      { text: '快速開始', link: '/zh-TW/guide/getting-started' },
      { text: '從 SillyTavern 遷移', link: '/zh-TW/guide/migration' },
      { text: '基礎配置', link: '/zh-TW/guide/configuration' },
    ],
  },
  {
    text: '基礎概念',
    items: [
      { text: '角色卡基礎', link: '/zh-TW/basics/character-cards' },
      { text: '世界書基礎', link: '/zh-TW/basics/world-info' },
      { text: '預設系統', link: '/zh-TW/basics/presets' },
      { text: 'API 連接', link: '/zh-TW/basics/connections' },
      { text: '聊天管理', link: '/zh-TW/basics/chat-management' },
    ],
  },
  {
    text: '技術改進',
    items: [
      { text: '改進總覽', link: '/zh-TW/improvements/overview' },
      { text: '增量同步', link: '/zh-TW/improvements/incremental-sync' },
      { text: '預設解耦', link: '/zh-TW/improvements/preset-decoupling' },
      { text: '角色卡綁定預設與人設', link: '/zh-TW/improvements/card-bound-presets' },
      { text: '函數調用運行時', link: '/zh-TW/improvements/function-call-runtime' },
      { text: '後端即時儲存', link: '/zh-TW/improvements/backend-storage' },
      { text: '請求檢查器', link: '/zh-TW/improvements/request-inspector' },
      { text: '統一生成層', link: '/zh-TW/improvements/generation-layer' },
      { text: '認證與配額', link: '/zh-TW/improvements/auth-and-quota' },
      { text: '其他改進', link: '/zh-TW/improvements/other' },
    ],
  },
  {
    text: '獨有功能',
    items: [
      { text: '記憶圖', link: '/zh-TW/features/memory-graph' },
      { text: '多Agent編排', link: '/zh-TW/features/orchestrator' },
      { text: '角色卡編輯助手', link: '/zh-TW/features/card-editor' },
      { text: '搜尋外掛', link: '/zh-TW/features/search-tools' },
      { text: '補全預設助手', link: '/zh-TW/features/preset-assistant' },
      { text: 'CardApp', link: '/zh-TW/features/cardapp' },
      { text: '提示詞分組', link: '/zh-TW/features/prompt-groups' },
      { text: '預設分組', link: '/zh-TW/features/preset-groups' },
      { text: '鉤子執行排序', link: '/zh-TW/features/hook-order' },
      { text: '其他功能', link: '/zh-TW/features/other-features' },
    ],
  },
  {
    text: '開發文檔',
    items: [
      { text: '外掛開發基礎', link: '/zh-TW/development/plugin-basics' },
      { text: 'Extension API 參考', link: '/zh-TW/development/extension-api' },
      { text: '角色卡開發者指南', link: '/zh-TW/development/card-developers' },
      { text: '貢獻指南', link: '/zh-TW/development/contributing' },
    ],
  },
]

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'What is Luker', link: '/guide/what-is-luker' },
      { text: 'Quick Start', link: '/guide/getting-started' },
      { text: 'Migrating from SillyTavern', link: '/guide/migration' },
      { text: 'Configuration', link: '/guide/configuration' },
    ],
  },
  {
    text: 'Core Concepts',
    items: [
      { text: 'Character Cards', link: '/basics/character-cards' },
      { text: 'World Info', link: '/basics/world-info' },
      { text: 'Presets', link: '/basics/presets' },
      { text: 'API Connections', link: '/basics/connections' },
      { text: 'Chat Management', link: '/basics/chat-management' },
    ],
  },
  {
    text: 'Technical Improvements',
    items: [
      { text: 'Overview', link: '/improvements/overview' },
      { text: 'Incremental Sync', link: '/improvements/incremental-sync' },
      { text: 'Preset Decoupling', link: '/improvements/preset-decoupling' },
      { text: 'Card-Bound Presets & Personas', link: '/improvements/card-bound-presets' },
      { text: 'Function Call Runtime', link: '/improvements/function-call-runtime' },
      { text: 'Backend Storage', link: '/improvements/backend-storage' },
      { text: 'Request Inspector', link: '/improvements/request-inspector' },
      { text: 'Unified Generation Layer', link: '/improvements/generation-layer' },
      { text: 'Auth & Quotas', link: '/improvements/auth-and-quota' },
      { text: 'Other Improvements', link: '/improvements/other' },
    ],
  },
  {
    text: 'Unique Features',
    items: [
      { text: 'Memory Graph', link: '/features/memory-graph' },
      { text: 'Multi-Agent Orchestrator', link: '/features/orchestrator' },
      { text: 'Card Editor Assistant', link: '/features/card-editor' },
      { text: 'Search Tools', link: '/features/search-tools' },
      { text: 'Preset Assistant', link: '/features/preset-assistant' },
      { text: 'CardApp', link: '/features/cardapp' },
      { text: 'Prompt Groups', link: '/features/prompt-groups' },
      { text: 'Preset Groups', link: '/features/preset-groups' },
      { text: 'Hook Order', link: '/features/hook-order' },
      { text: 'Other Features', link: '/features/other-features' },
    ],
  },
  {
    text: 'Development',
    items: [
      { text: 'Plugin Basics', link: '/development/plugin-basics' },
      { text: 'Extension API Reference', link: '/development/extension-api' },
      { text: 'Card Developer Guide', link: '/development/card-developers' },
      { text: 'Contributing', link: '/development/contributing' },
    ],
  },
]

export default defineConfig({
  title: 'Luker',
  description: 'Next-gen Roleplay Chat Platform',
  base: '/',

  head: [
    ['meta', { name: 'theme-color', content: '#4F46E5' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Luker — Next-gen Roleplay Chat Platform' }],
    ['meta', { property: 'og:description', content: 'Deep rebuild of SillyTavern with knowledge-graph memory, multi-agent orchestration, and AI-assisted character creation' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh-CN/',
    },
    'zh-TW': {
      label: '繁體中文',
      lang: 'zh-TW',
      link: '/zh-TW/',
    },
  },

  themeConfig: {
    logo: undefined,
    siteTitle: 'Luker',

    nav: [
      { text: 'Guide', link: '/guide/what-is-luker' },
      { text: 'Features', link: '/features/memory-graph' },
      { text: 'Development', link: '/development/plugin-basics' },
      { text: 'Changelog', link: '/changelog' },
    ],

    sidebar: {
      '/': enSidebar,
      '/zh-CN/': zhCNSidebar,
      '/zh-TW/': zhTWSidebar,
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/funnycups/Luker' },
    ],

    footer: {
      message: 'Built upon SillyTavern',
      copyright: '© 2026-present funnycups',
    },

    search: {
      provider: 'local',
    },

    outline: {
      label: 'On this page',
      level: [2, 3],
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    lastUpdated: {
      text: 'Last updated',
    },

    returnToTopLabel: 'Back to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Theme',
  },
})
