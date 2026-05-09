import { defineConfig } from 'vitepress'
import { createBuildTimeDiagramsPlugin } from 'vitepress-plugin-diagrams'

const diagrams = createBuildTimeDiagramsPlugin({
  diagramsDir: 'public/diagrams',
  publicPath: '/diagrams',
  diagramsDistDir: 'diagrams',
  krokiServerUrl: 'https://kroki.io',
})

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
  { text: 'Memory Graph 外部 API', link: '/zh-CN/improvements/memory-graph-external-api' },
  { text: '其他改进', link: '/zh-CN/improvements/other' },
  ],
  },
  {
  text: '独有功能',
  items: [
  { text: '记忆图', link: '/zh-CN/features/memory-graph' },
  {
    text: '多Agent编排',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh-CN/features/orchestrator/' },
      { text: 'Spec 模式', link: '/zh-CN/features/orchestrator/spec' },
      { text: '单 Agent 模式', link: '/zh-CN/features/orchestrator/single' },
      { text: 'Agenda 模式', link: '/zh-CN/features/orchestrator/agenda' },
      { text: 'Loop 模式', link: '/zh-CN/features/orchestrator/loop' },
      { text: 'AI 迭代工作台', link: '/zh-CN/features/orchestrator/iteration-studio' },
    ],
  },
  {
    text: '角色卡编辑助手',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh-CN/features/card-editor/' },
      {
        text: '从零写一个 CardApp',
        collapsed: true,
        items: [
          { text: '概览', link: '/zh-CN/features/card-editor/walkthrough/' },
          { text: '异世界生存日志', link: '/zh-CN/features/card-editor/walkthrough/isekai' },
          { text: '维多利亚案宗', link: '/zh-CN/features/card-editor/walkthrough/victorian' },
        ],
      },
      { text: '普通弹窗', link: '/zh-CN/features/card-editor/popup' },
      { text: 'CardApp Studio', link: '/zh-CN/features/card-editor/studio' },
    ],
  },
  { text: '搜索插件', link: '/zh-CN/features/search-tools' },
  { text: '补全预设助手', link: '/zh-CN/features/preset-assistant' },
  { text: '逐楼层变量', link: '/zh-CN/features/variable-op-log' },
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
  { text: '前端插件开发', link: '/zh-CN/development/frontend-plugin' },
          { text: '后端插件开发', link: '/zh-CN/development/server-plugin' },
          {
            text: 'Extension API 参考',
            collapsed: true,
            items: [
              { text: '概览', link: '/zh-CN/development/extension-api/' },
              { text: '聊天与状态', link: '/zh-CN/development/extension-api/chat-and-state' },
              { text: '预设与提示词', link: '/zh-CN/development/extension-api/presets-and-prompts' },
              { text: '生成请求', link: '/zh-CN/development/extension-api/generation' },
              { text: '插件集成', link: '/zh-CN/development/extension-api/plugin-integration' },
              { text: '底层端点', link: '/zh-CN/development/extension-api/low-level-endpoints' },
            ],
          },
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
      { text: '驗證與安全', link: '/zh-TW/guide/authentication' },
      { text: 'Android App', link: '/zh-TW/guide/android' },
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
      { text: '效能最佳化', link: '/zh-TW/improvements/performance' },
      { text: '預設關聯世界書', link: '/zh-TW/improvements/preset-world-info' },
      { text: 'WebSocket 代理', link: '/zh-TW/improvements/ws-proxy' },
      { text: '認證與配額', link: '/zh-TW/improvements/auth-and-quota' },
      { text: 'Memory Graph 外部 API', link: '/zh-TW/improvements/memory-graph-external-api' },
      { text: '其他改進', link: '/zh-TW/improvements/other' },
    ],
  },
  {
    text: '獨有功能',
    items: [
      { text: '記憶圖', link: '/zh-TW/features/memory-graph' },
      {
        text: '多Agent編排',
        collapsed: false,
        items: [
          { text: '概覽', link: '/zh-TW/features/orchestrator/' },
          { text: 'Spec 模式', link: '/zh-TW/features/orchestrator/spec' },
          { text: '單 Agent 模式', link: '/zh-TW/features/orchestrator/single' },
          { text: 'Agenda 模式', link: '/zh-TW/features/orchestrator/agenda' },
          { text: 'Loop 模式', link: '/zh-TW/features/orchestrator/loop' },
          { text: 'AI 迭代工作台', link: '/zh-TW/features/orchestrator/iteration-studio' },
        ],
      },
      {
        text: '角色卡編輯助手',
        collapsed: false,
        items: [
          { text: '概覽', link: '/zh-TW/features/card-editor/' },
          {
            text: '從零寫一個 CardApp',
            collapsed: true,
            items: [
              { text: '概覽', link: '/zh-TW/features/card-editor/walkthrough/' },
              { text: '異世界生存日誌', link: '/zh-TW/features/card-editor/walkthrough/isekai' },
              { text: '維多利亞案宗', link: '/zh-TW/features/card-editor/walkthrough/victorian' },
            ],
          },
          { text: '普通彈窗', link: '/zh-TW/features/card-editor/popup' },
          { text: 'CardApp Studio', link: '/zh-TW/features/card-editor/studio' },
        ],
      },
      { text: '搜尋外掛', link: '/zh-TW/features/search-tools' },
      { text: '補全預設助手', link: '/zh-TW/features/preset-assistant' },
      { text: '逐樓層變數', link: '/zh-TW/features/variable-op-log' },
      { text: 'CardApp', link: '/zh-TW/features/cardapp' },
      { text: '狀態系統', link: '/zh-TW/features/state-system' },
      { text: '日誌系統', link: '/zh-TW/features/logging' },
      { text: '提示詞分組', link: '/zh-TW/features/prompt-groups' },
      { text: '預設分組', link: '/zh-TW/features/preset-groups' },
      { text: '鉤子執行排序', link: '/zh-TW/features/hook-order' },
      { text: '世界書啟動鏈路追蹤', link: '/zh-TW/features/world-info-trace' },
      { text: '外掛註冊正則', link: '/zh-TW/features/regex-provider' },
      { text: '其他功能', link: '/zh-TW/features/other-features' },
    ],
  },
  {
    text: '開發文檔',
    items: [
      { text: '前端外掛開發', link: '/zh-TW/development/frontend-plugin' },
              { text: '後端外掛開發', link: '/zh-TW/development/server-plugin' },
              {
                text: 'Extension API 參考',
                collapsed: true,
                items: [
                  { text: '概覽', link: '/zh-TW/development/extension-api/' },
                  { text: '聊天與狀態', link: '/zh-TW/development/extension-api/chat-and-state' },
                  { text: '預設與提示詞', link: '/zh-TW/development/extension-api/presets-and-prompts' },
                  { text: '生成請求', link: '/zh-TW/development/extension-api/generation' },
                  { text: '外掛整合', link: '/zh-TW/development/extension-api/plugin-integration' },
                  { text: '底層端點', link: '/zh-TW/development/extension-api/low-level-endpoints' },
                ],
              },
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
      { text: 'Authentication & Security', link: '/guide/authentication' },
      { text: 'Android App', link: '/guide/android' },
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
      { text: 'Performance', link: '/improvements/performance' },
      { text: 'Preset-Associated World Info', link: '/improvements/preset-world-info' },
      { text: 'WebSocket Proxy', link: '/improvements/ws-proxy' },
      { text: 'Auth & Quotas', link: '/improvements/auth-and-quota' },
      { text: 'Memory Graph External API', link: '/improvements/memory-graph-external-api' },
      { text: 'Other Improvements', link: '/improvements/other' },
    ],
  },
  {
    text: 'Unique Features',
    items: [
      { text: 'Memory Graph', link: '/features/memory-graph' },
      {
        text: 'Multi-Agent Orchestrator',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/features/orchestrator/' },
          { text: 'Spec Mode', link: '/features/orchestrator/spec' },
          { text: 'Single Agent Mode', link: '/features/orchestrator/single' },
          { text: 'Agenda Mode', link: '/features/orchestrator/agenda' },
          { text: 'Loop Mode', link: '/features/orchestrator/loop' },
          { text: 'AI Iteration Studio', link: '/features/orchestrator/iteration-studio' },
        ],
      },
      {
        text: 'Card Editor Assistant',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/features/card-editor/' },
          {
            text: 'Build a CardApp from Scratch',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/features/card-editor/walkthrough/' },
              { text: 'Isekai Survival Log', link: '/features/card-editor/walkthrough/isekai' },
              { text: 'Victorian Case File', link: '/features/card-editor/walkthrough/victorian' },
            ],
          },
          { text: 'Popup Mode', link: '/features/card-editor/popup' },
          { text: 'CardApp Studio', link: '/features/card-editor/studio' },
        ],
      },
      { text: 'Search Tools', link: '/features/search-tools' },
      { text: 'Preset Assistant', link: '/features/preset-assistant' },
      { text: 'Per-Message Variables', link: '/features/variable-op-log' },
      { text: 'CardApp', link: '/features/cardapp' },
      { text: 'State System', link: '/features/state-system' },
      { text: 'Logging', link: '/features/logging' },
      { text: 'Prompt Groups', link: '/features/prompt-groups' },
      { text: 'Preset Groups', link: '/features/preset-groups' },
      { text: 'Hook Order', link: '/features/hook-order' },
      { text: 'World Info Activation Trace', link: '/features/world-info-trace' },
      { text: 'Plugin-Registered Regex', link: '/features/regex-provider' },
      { text: 'Other Features', link: '/features/other-features' },
    ],
  },
  {
    text: 'Development',
    items: [
      { text: 'Frontend Plugin Development', link: '/development/frontend-plugin' },
              { text: 'Server Plugin Development', link: '/development/server-plugin' },
              {
                text: 'Extension API Reference',
                collapsed: true,
                items: [
                  { text: 'Overview', link: '/development/extension-api/' },
                  { text: 'Chat & State', link: '/development/extension-api/chat-and-state' },
                  { text: 'Presets & Prompts', link: '/development/extension-api/presets-and-prompts' },
                  { text: 'Generation', link: '/development/extension-api/generation' },
                  { text: 'Plugin Integration', link: '/development/extension-api/plugin-integration' },
                  { text: 'Low-Level Endpoints', link: '/development/extension-api/low-level-endpoints' },
                ],
              },
              { text: 'Card Developer Guide', link: '/development/card-developers' },
              { text: 'Contributing', link: '/development/contributing' },
    ],
  },
]

export default defineConfig({
  title: 'Luker',
  description: 'Next-gen Roleplay Chat Platform',
  base: '/',

  // superpowers/ holds working specs and plans that aren't published docs.
  srcExclude: ['superpowers/**', '**/README.md'],

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
      { text: 'Development', link: '/development/frontend-plugin' },
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

  markdown: {
    config: (md) => {
      diagrams.configureMarkdown(md)
    },
  },

  vite: {
    plugins: [diagrams.vitePlugin()],
  },
})
