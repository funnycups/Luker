# 实战：异世界生存日志

本页用一张完整的生存题材角色卡，演示如何用一段需求让 [CardApp Studio](/zh-CN/features/card-editor/studio) 生成界面、世界书与开场白，再通过几轮追问调整细节。全程只需描述效果。

## 最终结果

最终成品是一张名为「异世界生存日志」的单人沉浸式角色扮演角色卡。发送第一条消息后，界面如下：

![成品截图](/images/walkthrough/isekai/step-08-end-to-end.png)

- 顶部状态栏显示天数 / 体力 / 饱食度 / 心情
- 主角穿越到陌生森林的西式低魔异世界，AI 担任环境与叙事者
- 一本随卡绑定的世界书，包含状态记录、世界观约定和几个 NPC 设定
- 沉浸式按钮命名（停笔 / 改写 / 旧册 / 新章 / 合卷），覆盖常用的对话操作

整个过程只需要用中文描述需求，**AI 会处理界面、世界书条目、状态变量和开场白，并把各项内容关联到角色卡**。

## 前置条件

- 一个可用的 Luker 实例
- 已配置完成的 LLM API，推荐使用 Claude、GPT-5 等支持工具调用的模型
- 已配置完成的 Stable Diffusion / ComfyUI 后端，用于进阶步骤

## 1. 创建空白角色卡并进入 Studio

打开右侧角色管理面板，点击「新建角色」并填写名称（本文使用「异世界生存日志」）。描述、第一条消息与世界书绑定由 Studio AI 生成。

接下来打开「扩展」面板 → 展开「角色卡编辑助手」→ 点击 **「&lt;/&gt; CardApp Studio」**：

![Studio 入口位置](/images/walkthrough/isekai/step-01-studio-entry.png)

Studio 是覆盖在主界面上的三栏布局：左侧 AI 对话、中间实时预览、右侧代码编辑器。新角色卡的 CardApp 尚未启用，Studio 检测到该状态后会主动询问是否启用。

![Studio 初始空状态](/images/walkthrough/isekai/step-02-studio-empty.png)

::: tip 阅读重点
右侧代码编辑器会随 AI 的工作刷新。阅读本页时关注**左栏对话**与**中间预览**即可。
:::

## 2. 一段需求完成骨架、世界书与开场白

点击左侧输入框，**完整复制**以下内容：

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

![输入第一条需求](/images/walkthrough/isekai/step-03-first-prompt.png)

发送后，Studio 不会直接开始编写，而是先查看这张卡的现状，再说明打算怎么做。新卡还没有启用 CardApp，它会先询问是否启用（回复「好」即可）。

确认后，它一次完成以下工作：

- 启用这张卡的 CardApp
- 编写界面代码，包括状态栏、消息区、输入区和常用操作按钮
- 创建配套世界书，写入状态记录和世界观约定
- 编写开场白，并初始化状态变量
- 把世界书关联到这张卡

每项修改都会弹出对话框显示改动内容，确认后才会写入。

![AI 工作过程：修改与确认](/images/walkthrough/isekai/step-04-first-round-work.png)

::: tip AI 内容放入世界书，不修改主提示词
AI 不会修改角色卡的主提示词，这是 [Luker 的 CardApp 创作约定](/zh-CN/development/card-developers)：角色卡的主提示词会覆盖聊天补全预设原本设计的系统部分，把卡片内容放入世界书条目才能与预设共存。Studio AI 默认遵守该约定。
:::

AI 全部完成后，Studio 中间预览区自动重载，显示生成的 CardApp：

![首次运行效果](/images/walkthrough/isekai/step-05-first-round-running.png)

## 3. 不满意时继续追问 AI

完成一轮后，你可能想更换配色、调整按钮顺序、修改 AI 描述的氛围，或补充某个 NPC 的设定；这些均可在左栏继续追问，Studio AI 会结合上下文继续修改：

措辞不准确时补充说明即可，AI 会继续修改。

## 4. 端到端测试

发送一条角色扮演输入（内容不限），观察顶部状态栏的数值随剧情变化。

到这里，你已经通过多轮自然语言对话，得到了一张：

- ✓ 自带前端界面（状态栏和常用操作按钮）
- ✓ 自带世界观和 NPC 设定（绑定的世界书）
- ✓ 开场白会初始化状态
- ✓ 具备沉浸感的角色扮演角色卡

上述内容由 Studio 生成并写入，CardApp 在确认后启用。

## 5.（进阶）接入图像生成

::: warning 前置：SD/ComfyUI 后端
本节需要先配置 SillyTavern 自带的 [图像生成扩展](https://docs.sillytavern.app/extensions/stable-diffusion/) 后端（本地 Stable Diffusion、ComfyUI 或远程 API 均可）。后端不可用时跳过本节。
:::

```
我想要每次 AI 描述新场景时 CardApp 自动配图。玩家纯对话 / 内心戏不画。
另外底部加一个「画下所见」按钮,可以手动让最近一条 AI 消息的场景重画。

对没配置画图后端的用户:静默跳过或隐藏按钮,不要弹出错误,
不要影响 CardApp 其他功能。
```

![消息上方插画](/images/walkthrough/isekai/step-09-scene-image.png)

![「画下所见」按钮触发](/images/walkthrough/isekai/step-10-redraw-button.png)

## 提示词实践要点

有效的 Studio 需求描述不需要很长，说明目标即可。以下为几条要点：

1. **描述外观与行为**
   - 示例：「顶部状态栏 4 格，显示天数、体力、饱食度与心情」
   - 实现方式交给 Studio 决定，例如何时重新渲染状态栏

2. **区分约束与自由度**
   - 必须固定的内容写成约束，例如变量使用 `isj_` 前缀。
   - 其余内容交由 Studio 决定，例如配色、字体与排版。

3. **说明与预期的偏差**
   - 指出期望结果与当前结果，例如「状态栏应有四项，目前只有两项，请补齐」。
   - 在原需求上追加说明即可。

4. **批准前查看改动**
   - 每项修改都会弹出确认，可以逐项检查。
   - Studio 会处理常用操作、变量记录、世界书关联与转义。

5. **让 Studio 解释机制**
   - 例如「状态变量在哪一步写入？」「这个世界书条目什么时候触发？」
   - Studio 可以读取项目文件与文档，回答与当前角色卡相关的问题。

## 下一步

- [CardApp 概览](/zh-CN/features/cardapp) —— CardApp 的核心概念
- [角色卡开发者指南](/zh-CN/development/card-developers) —— CardApp 的完整接口和创作约定
- [变量记录](/zh-CN/features/variable-op-log) —— 变量如何随对话更新
- [状态系统](/zh-CN/features/state-system) —— 楼层状态、触发器和全局变量
- [Studio 能力清单](/zh-CN/features/card-editor/studio) —— 编辑器、版本记录和 AI 操作一览
