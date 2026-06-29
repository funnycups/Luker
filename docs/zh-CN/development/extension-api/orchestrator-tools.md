# 编排器工具 API

注册可被编排器四种模式（loop、spec、agenda、director）调度的工具。

## 什么时候用这个 API

你的扩展提供了一项能力，让某个编排 agent 自主调用会更顺手——查数据库、调第三方 API、跑 Stable Diffusion 出图，都行。如果用户装了编排器扩展，你注册的工具会出现在他们的编排编辑器「自定义工具 → 扩展（来自其他插件）」分组里，由他们按编排粒度决定开还是关。

如果用户没装编排器，你的工具也不会丢——注册调用会静默 no-op。你的扩展独立使用时仍然完整可用。

## API 入口

编排器扩展通过 Luker 的扩展注册表暴露 API。三种入口指向同一组函数引用——按你的代码情境挑一种：

```js
import { getExtensionApi } from '/scripts/extensions.js';

// 1. 通过 getExtensionApi（最常用）
const orch = getExtensionApi('orchestrator');
if (orch) orch.registerOrchestrationTool({ /* ... */ });

// 2. 通过 SillyTavern context（扩展会收到这个对象）
ctx.getExtensionApi('orchestrator')?.registerOrchestrationTool({ /* ... */ });

// 3. 直接 ES module 导入（只在 Luker 树内合适）
import { registerOrchestrationTool } from
    '/scripts/extensions/orchestrator/register-custom-tool.js';
```

任何时候都加一层「编排器是否在场」的保护，让你的扩展在独立装的场景下仍然可用。

## registerOrchestrationTool(spec)

```ts
{
  name: string,            // /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/。不能跟内置工具
                           // 或别的扩展工具重名。
  description: string,     // 写给 LLM 看的，不是给用户。
  parameters: object,      // OpenAI 风格的 JSON Schema。
  exec: async (args, ctx) => any,
  mode: 'read' | 'write',  // 必填。写工具在模拟评审期会被隔离。
  simulate?: async (args, ctx) => any,  // 可选。写工具进入模拟评审时，
                                        // 改调用它而不是 exec。不提供时，
                                        // 写工具返回占位
                                        // { ok: true, simulated: true,
                                        //   unvalidated: true }。
  displayName?: string,
}
```

`exec` 被调用时拿到 LLM 解析后的参数和编排 ctx。返回值就是 LLM 看到的工具结果。`throw` 把错误抛回给 agent。

### ctx 参数

`ctx` 原型链上继承 SillyTavern `getContext()` 的所有字段，外加编排运行时挂的几个内部字段。用法跟你在 Luker 任何其他地方用 context 一样。

来自 SillyTavern:

- `ctx.chat`、`ctx.characters`、`ctx.characterId`、`ctx.groups`、`ctx.groupId`、`ctx.name1`、`ctx.name2`
- `ctx.eventSource`、`ctx.eventTypes` —— 运行时事件总线
- `ctx.getExtensionApi(name)` —— 其他扩展发布的 API
- `ctx.registerOrchestrationTool`、`ctx.bridgeSillyTavernTool` 等 —— 本文档介绍的整套 API 都挂在 ctx 上

编排运行时挂的（只在编排过程中存在）:

| 字段 | 用途 |
|---|---|
| `ctx.__lukerRun` | 本次 run 的运行时状态。`ctx.__lukerRun.activatedEntryKeys` 是一个 `Set`，里面是本轮已被注入的 World Info 条目 key（供 lorebook 风格的工具去重）。`ctx.__lukerRun.abortSignal` 是本 run 的 abort signal —— 可取消的工作要尊重它。 |
| `ctx.__floorStateForNotes` | `note_open` / `note_close` 工具底层的 floor-state 实例。想跟笔记系统协作就读它。 |
| `ctx.__customToolRegistry` | 本 run 的 Layer-3（手写）工具注册表。绝大多数工具用不到。 |
| `ctx.__memoryGraphSession` | 由本 run 内第一次 `memory_*` 工具调用 lazy 打开；在那之前不存在。 |

命名：SillyTavern 占顶层 key；编排运行时只挂 `__` 前缀字段，两边互不踩。

保守一些 —— 只依赖你这个工具真正需要的字段，这样下游 context 演进时你也不会坏。

## 错误处理

`exec` 和 `simulate` 都可以 `throw`。普通 `Error` 就够用；想要 LLM 能从结构化失败里恢复，附带 `{ code, hint }`：

```js
throw Object.assign(new Error('Database is read-only.'), {
    code: 'DB_READONLY',
    hint: 'Wait for the next write window or use a different store.',
});
```

编排器内部会把你抛的错包成 `ToolError` 形状，再以 `role: tool` 消息的形式交回给 LLM。

## unregisterOrchestrationTool(name)

把工具从注册表里摘掉。在你的扩展要关停、或者要换工具面的时候调用。

## listExtensionTools()

返回当前所有已注册扩展工具的 `{ name, mode, description, displayName, hasSimulate, source }`。给「展示有哪些工具可用」的 UI 用。

## ST function tool 桥接

如果你的扩展已经在用 SillyTavern 的 `registerFunctionTool` API，用户可以在编排编辑器里通过「桥接 SillyTavern 工具……」选择器把它桥接进来。桥接出来的工具叫 `st_<你的工具名>`，默认 `mode: 'write'`。你这边不用改任何代码。

如果你想精确控制 mode 和 simulate 语义，就用 `registerOrchestrationTool` 包一层；不在意的话桥接是零成本路径。选择器的标签和模式选项通过 `listAvailableSillyTavernTools()` / `bridgeSillyTavernTool(name, { mode })` 暴露，调用方想自己驱动桥接也行。

## 角色级 override 访问器

除了工具注册接口，`'orchestrator'` 这个 extension api 还发布了六个访问器加一个写入 helper，其他插件用它读取或写入角色级编排 override。CardApp 的 `ctx.getOrchestratorOverride` / `setOrchestratorOverride` / `clearOrchestratorOverride`，以及 CardApp Studio 的工具 `character_get_orchestrator` / `character_update_orchestrator` / `character_clear_orchestrator` 都走这同一套接口。

```js
const orch = ctx.getExtensionApi('orchestrator');
if (!orch) { /* 编排器未安装 */ return; }

const override = orch.getCharacterOverrideByAvatar(ctx, avatar);
const charIndex = orch.getCharacterIndexByAvatar(ctx, avatar);
const prev = orch.getCharacterExtensionDataByAvatar(ctx, avatar);

const next = orch.normalizeCharacterOverrideMode({ ...override, mode: 'agenda' });
await orch.persistOrchestratorCharacterExtension(ctx, charIndex, { ...prev, override: next });

// 同步 extension_settings.orchestrator.executionMode，让 dispatcher 下次生成
// 时挑到 override 的分支。不做这一步的话，切换 mode 的 override 会被运行时
// 静默忽略。
orch.applyCharacterExecutionModeForAvatar(ctx, ctx.extensionSettings?.orchestrator, avatar);
```

| 方法 | 用途 |
| --- | --- |
| `getCharacterOverrideByAvatar(ctx, avatar)` | 读取 `avatar` 对应角色卡上的 `character.data.extensions.orchestrator.override` 原始 payload；不存在时返回 `null`。 |
| `getCharacterIndexByAvatar(ctx, avatar)` | 解析 `persistOrchestratorCharacterExtension` 需要的角色索引；找不到返回 `-1`。 |
| `getCharacterExtensionDataByAvatar(ctx, avatar)` | 读取完整的 `character.data.extensions.orchestrator` blob（override 及其它兄弟键）。写入前 spread 一下，避免误删兄弟子键。 |
| `normalizeCharacterOverrideMode(override)` | 根据存在的子 payload（`spec` / `agenda` / `loop` / `director`）和最新的 `updatedAt` 钉住 `override.mode`。会原地修改 override 并返回它。 |
| `applyCharacterExecutionModeForAvatar(ctx, settings, avatar)` | 把 `settings.executionMode` 重新对齐到该角色已保存的 mode；变更时返回 `true`。 |
| `persistOrchestratorCharacterExtension(ctx, characterIndex, modulePayload)` | 通过 `ctx.writeExtensionField` 持久化整个 `extensions.orchestrator` blob。传 `null` 作为 `modulePayload` 会把整个 blob 删除；成功返回 `true`。 |

这些访问器只动角色卡，从来不修改全局编排器设置。

## Iter-studio 技能工具目录

编排器的 iter-studio 弹窗用一组技能管理工具（库存查询、创作、策略绑定、迁移 helper），其它 iter-studio 风格的弹窗可以把它们 splice 进自己的工具目录。Extension api 上有三个属性暴露这个目录：

| 属性 | 类型 | 用途 |
| --- | --- | --- |
| `SKILL_ITER_STUDIO_TOOL_DEFS` | `readonly array` | OpenAI 形状的工具定义（编排器 iter-studio 暴露的 17 个 `skill_*` 工具）。按 `function.name` 过滤出弹窗想要的子集。 |
| `isSkillIterStudioTool(name)` | `(string) => boolean` | 判断一个工具调用名是否属于技能工具的谓词。 |
| `runSkillIterStudioTool(call, mutationCtx)` | `async ({name, args}, {getWorkingProfile}) => result` | 单次技能工具调用的分发器。纯库存 / 创作 / 迁移 handler 忽略 `mutationCtx`；策略绑定类 handler（`skill_bind_to_agent` / `skill_unbind_from_agent` / `skill_set_mode_defaults` / `skill_replace_in_systemprompt`）则要求 `getWorkingProfile()` 返回一个可变的编排器工作 profile。 |

CPA 的迭代工作台消费了这套接口，把与 profile 无关的技能工具 splice 进自己的 preset iter-studio（见 `completion-preset-assistant/cpa-iteration/tools.js`）。没有编排器工作 profile 的兄弟弹窗传 `{ getWorkingProfile: () => null }`，只暴露与 profile 无关的 handler。

## 示例 —— memory-graph

memory-graph 扩展正是通过这套 API 发布它的读 / 写工具，pattern 如下：

```js
// memory-graph/orchestrator-tools.js
import { getExtensionApi } from '/scripts/extensions.js';

export function registerMemoryGraphOrchestrationTools() {
    const orch = getExtensionApi('orchestrator');
    if (!orch || typeof orch.registerOrchestrationTool !== 'function') return;
    for (const spec of SCHEMAS) {
        orch.registerOrchestrationTool(spec);
    }
}
```

在 memory-graph 的 init handler 里调一次。每个工具的具体 spec 参见 [记忆图扩展 API](./memory-graph.md)。

## 相关页面

- [自定义工具（用户文档）](/zh-CN/features/orchestrator/custom-tools) —— 用户视角下三条通道（扩展 / SillyTavern 桥接 / 手写）在编排编辑器里的呈现方式
- [插件集成](./plugin-integration.md) —— 注册 `'orchestrator'` 与其他扩展入口的扩展 API 注册表全貌
- [记忆图扩展 API](./memory-graph.md) —— 本 API 的参考消费者
