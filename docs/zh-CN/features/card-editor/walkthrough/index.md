# 从零写一个 CardApp

这一节用具体题材演示**怎么让 CardApp Studio 从零联动起来** —— 全程不用自己写代码，用自然语言指挥 Studio 设计 schema、loop、世界书、CardApp 面板。

两个示例按题材和复杂度挑一个看：

| 示例 | 题材 | 涵盖能力 | 适合 |
| --- | --- | --- | --- |
| [异世界生存日志](/zh-CN/features/card-editor/walkthrough/isekai) | 西式低魔异世界生存 RP | 顶部状态栏（Day / Stamina / Hunger / Mood）+ 世界书 + 场景插画（可选） | 想最快看到 CardApp 跑起来 |
| [维多利亚案宗](/zh-CN/features/card-editor/walkthrough/victorian) | 1888 伦敦福尔摩斯式侦探卡 | memory-graph 派生 schema + orchestrator loop（draft → critique → revise）+ 卡专用世界书 + 变量驱动 CardApp 面板 | 想看 schema / loop / 变量驱动 UI 全栈协同 |

两个示例的总章程一致 —— Studio 提案 / 你点头 / Studio 落地，每个工具调用都有 diff 让你审。差别在于覆盖的能力层次不同。

刚接触 Studio 没建过卡，从[异世界生存日志](/zh-CN/features/card-editor/walkthrough/isekai)开始；想看完整能力叠在一张卡上，看[维多利亚案宗](/zh-CN/features/card-editor/walkthrough/victorian)。
