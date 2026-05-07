# 从零写一个 CardApp

::: tip 这篇文档解决什么问题
[CardApp Studio](/zh-CN/features/card-editor/studio) 的页面讲它有什么能力,这篇用一个完整角色卡演示**怎么用人话指挥它干活**。

读完你能从零做出一张能跑、有 RP 沉浸感的 CardApp,过程中不用自己写一行 JavaScript。
:::

## 你会得到什么

最终成品是一张名叫「异世界生存日志」的单人沉浸式 RP 角色卡。第一条消息发出去,你会看到这样:

![成品截图](/images/cardapp-studio-walkthrough/step-08-end-to-end.png)

- 顶部 4 格状态栏:天数 / 体力 / 饱食度 / 心情
- 主角穿越到陌生森林的西式低魔异世界,AI 担任环境与叙事者
- 一个绑定的世界书,内含状态注入条目 + 世界观锚点 + 几个 NPC 设定
- 沉浸式按钮命名(停笔 / 改写 / 旧册 / 新章 / 合卷),覆盖必备 UX

整个过程你只需要用中文描述需求 — **AI 会处理代码、Git 提交、世界书条目、变量初始化、字段绑定**。

## 前置条件

- 一个能跑的 Luker / SillyTavern 实例
- 已配通的 LLM API,推荐有工具调用能力的模型(Claude / GPT-5 等)
- (进阶段需要)已配通 Stable Diffusion / ComfyUI 后端

## 1. 创建空白角色卡 → 进入 Studio

打开右侧角色管理面板,点「新建角色」,起个名字(本文用「异世界生存日志」)。**不需要填任何字段** — 描述 / 第一条消息 / 世界书绑定全部交给 Studio AI。

接下来打开「扩展」面板 → 展开「角色卡编辑助手」→ 点 **「&lt;/&gt; CardApp Studio」**:

![Studio 入口位置](/images/cardapp-studio-walkthrough/step-01-studio-entry.png)

Studio 是覆盖在主界面上的三栏布局:左 AI 对话 / 中实时预览 / 右代码编辑器。新角色卡 CardApp 还没启用,Studio 看到这个状态会主动问你要不要开 — 别担心。

![Studio 初始空状态](/images/cardapp-studio-walkthrough/step-02-studio-empty.png)

::: tip 不用读代码也能跟下去
右侧代码编辑器会随着 AI 的工作刷新,但本文不要求你看里面的代码。只需要看 **左栏的对话** 和 **中间的预览** — 这就是 vibe 编码该有的样子。
:::

## 2. 一发 prompt 把骨架 + 世界书 + 开场白全做了

点左侧输入框,**完整复制**下面这段:

```
我想做一个轻小说风味的西式异世界冒险角色卡,主角穿越到陌生森林独自求生,
AI 担任环境和叙事者(第三人称视角描写主角看到 / 感受到什么)。
不要东方仙侠 / 修真 / 都市 / 校园风,也不要末日 dark fantasy。

先帮我搭一个最小可用的 CardApp:
- 顶部状态栏 4 格:天数、体力、饱食度、心情
- 中间是消息渲染区
- 下面是输入框和发送按钮
- 必须的快捷按钮(停止生成、切换聊天、新存档、关闭聊天)放底部

状态变量都用 isj_ 前缀(isj_day / isj_hp / isj_food / isj_mood)。
风格请配合"轻小说西式异世界"的氛围,具体配色 / 字体 / 排版你来定。
```

![输入第一轮 prompt](/images/cardapp-studio-walkthrough/step-03-first-prompt.png)

发送后,Studio AI 不会埋头猛写,而是会先:

1. 调 `list_files` / `character_get_fields` 看现状
2. 发现 CardApp 没启用,**先问你要不要开**(回个「好」即可)
3. 把方案讲一遍让你过一眼

确认后,它会一并完成下面这些事 — 一次性,不用你分轮发 prompt:

- 启用 CardApp toggle(`cardapp_set_enabled`)
- 写 `index.js` / `style.css`(状态栏 / 消息区 / 输入区 / 必备 UX 按钮)
- 配套绑一本世界书,建状态注入条目 + 世界观锚点
- 改写 `first_mes`(主角穿越的开场白,带 setvar 初始化变量)
- 把 `world` 字段绑定到新建的世界书

每个工具调用都会**弹出审批**让你看 diff — 一般可以放心点「批准」一并通过。

![AI 工作过程:工具调用 + diff 审批](/images/cardapp-studio-walkthrough/step-04-first-round-work.png)

::: tip "AI 内容放世界书,不动 system_prompt"
你会注意到 AI 没碰 `system_prompt` — 这是 [Luker 的 CardApp 创作约定](/zh-CN/development/card-developers#cardapp-内容存放约定):角色卡的 `system_prompt` 会盖掉聊天补全预设原本设计好的 system 部分,把卡片内容塞进世界书 entry 才能跟预设和平共存。Studio AI 默认遵守。
:::

::: tip 看到 AI 在世界书条目里写 <code v-pre>\{{...}}</code> 别奇怪
AI 在 entry 里教模型怎么用 `setvar` / `addvar` 等 macros — 这些教学示范必须**反斜杠转义**(<code v-pre>\{{...}}</code>),否则它们会在每次 prompt build 时被引擎执行,污染你的变量。Studio AI 自动会处理这层 escape。
:::

AI 全部完成后,Studio 中间预览区会自动重载,你能看到一张能跑的 CardApp:

![第一轮跑起来的样子](/images/cardapp-studio-walkthrough/step-05-first-round-running.png)

## 3. 不满意就追问 AI

跑过一轮你可能发现配色想换一种、按钮顺序想调一下、AI 描述的氛围跟你想的不一样、某个 NPC 的设定想再丰满一点 — 这些都直接在左栏追问就行,Studio AI 会顺着上下文继续改:

::: tip 都可以大大方方追问
- "底部按钮顺序换成 寄出 / 改写 / 旧册 / 新章 / 合卷"
- "状态栏的字号能不能调大一点"
- "NPC 那条 keyed entry 加点暗示玩家可以送什么礼物"
- "开场白结尾那段太冷,换个更明亮一点的画面"

不用纠结 prompt 的措辞,把诉求说清楚 AI 就能改。如果改完不对,继续追问。
:::

## 4. 端到端跑一次

试着发一条 RP 输入(随便说点什么):

![完整对话 + 状态变化](/images/cardapp-studio-walkthrough/step-08-end-to-end.png)

到这里,你已经通过 1-2 轮自然语言对话,得到了一张:

- ✓ 自带前端 UI(状态栏 + 必备 UX 按钮)
- ✓ 自带世界观和 NPC 设定(绑定的世界书)
- ✓ 自带初始化逻辑的开场白
- ✓ 跑起来有沉浸感的 RP 角色卡

整个过程你**没看过一行代码**,也没有手动开过 CardApp toggle、没有手动建过世界书条目。

## 5.(进阶)接入图像生成

::: warning 前置:SD/ComfyUI 后端
本节需要先配通 SillyTavern 自带的 [图像生成扩展](https://docs.sillytavern.app/extensions/stable-diffusion/) 的后端(本地 Stable Diffusion / ComfyUI / 远程 API 任选)。后端不通时,这一节直接跳过。
:::

```
我想要每次 AI 描述新场景时 CardApp 自动配图。玩家纯对话 / 内心戏不画。
另外底部加一个「画下所见」按钮,可以手动让最近一条 AI 消息的场景重画。

对没配置画图后端的用户:静默跳过 / 隐藏按钮就行,别弹错误,
不要影响 CardApp 其他功能。
```

![消息上方插画](/images/cardapp-studio-walkthrough/step-09-scene-image.png)

![「画下所见」按钮触发](/images/cardapp-studio-walkthrough/step-10-redraw-button.png)

## 提示词实践小抄

跑过一轮你会发现,有效的 Studio prompt 不需要长 — 关键是把"方向"说清楚。下面几条经验:

1. **描述外观和行为,不描述实现**
   - ✓ "顶部状态栏 4 格,天数 / 体力 / 饱食度 / 心情"
   - ✗ "用 ctx.registerRenderer 注册一个监听 GENERATION_ENDED 的 renderer"

2. **把"约束"和"自由度"分开写清楚**
   - "用 isj_ 前缀"是约束(方向)
   - "具体配色 / 字体 / 排版你来定"是自由度(交给 AI)
   - AI 把自由度发挥到具体内容(NPC 名字、配色、按钮命名),把约束当不可逾越的红线 — 这是它最擅长的工作模式

3. **AI 跑出来跟你想的不一样,不是 bug**
   - 这是工作循环的一部分。看到偏差,精准描述给 AI 听:"我想要 X(具体说出来),你给的偏向 Y(指出哪里偏了),改一下"
   - 不要回头自己改文件,也不要重写整个 prompt

4. **看 diff 再批准**
   - 每个工具调用都会弹出审批,真出问题时就能拦住
   - 但一般信任默认 — Studio 系统提示词已经把 [Required UX](/zh-CN/features/cardapp#必备-ux)、[op-log 用法](/zh-CN/features/variable-op-log)、[世界书绑定](/zh-CN/development/card-developers#cardapp-内容存放约定)、宏 escape 这些都内置了

5. **不会的就让它解释**
   - "为什么这里要用 <code v-pre>\{{...}}</code> 而不是 <code v-pre>{{...}}</code>?"
   - 它会用人话讲给你听,顺带帮你把这块的来龙去脉理清楚

## 下一步

- [CardApp 概览](/zh-CN/features/cardapp) — CardApp 的核心概念
- [角色卡开发者指南](/zh-CN/development/card-developers) — `ctx` API 全集 + 创作约定
- [变量 op-log](/zh-CN/features/variable-op-log) — <code v-pre>{{setvar}}</code> 等宏的运行机制
- [State System](/zh-CN/features/state-system) — Floor State / 触发器 / 全局变量
- [Studio 能力清单](/zh-CN/features/card-editor/studio) — 编辑器、Git、AI 工具一览
