# Edits 库

带 op 类型的结构化编辑，具备漂移感知应用与交互式冲突解决。

## 何时使用

当你的插件具有以下形态时，使用本库：

1. AI 工具调用对一个用户拥有的结构化对象（JSON、preset、角色卡、图等）
   提出修改建议
2. 用户审阅这些修改建议，并决定是否应用
3. 该对象在"提出建议"与"应用"之间，可能被外部编辑

不使用本库时，你必须自己手动维护基线、检测漂移，并为每个插件单独写
冲突 UI。使用本库后，所有消费者共享同一套合并引擎与同一套解决 UX。

## 概念

- **Edit** —— 一个带标签的对象，描述一次带 op 类型的修改。
  内置 op：`set`、`unset`、`str_replace`、`str_insert`、`str_delete`、
  `list_insert`、`list_remove`、`list_move`。
- **Apply** —— `applyEdits(edits, live)` 返回 `{ newLive, clean,
  conflicts, alreadyDone }`。引擎在改动之前，会针对当前 live 对每条
  编辑做漂移检查。
- **Inverse** —— `inverseEdit(edit)` 返回能够撤销该编辑的反向编辑，
  适合用于回退。
- **自定义 op** —— `registerOp(name, handler)` 允许插件定义领域特定的
  变更。

## API

三层接口暴露同一套表面：

```js
// Layer 1 — ESM
import { applyEdits, inverseEdit, registerOp, getRegisteredOp,
         listRegisteredOps, showConflictResolution,
         BUILT_IN_OPS } from '/scripts/lib/edits/index.js';

// lukerContext
lukerContext.edits.applyEdits(...);
lukerContext.edits.showConflictResolution(...);

// getContext
SillyTavern.getContext().edits.applyEdits(...);
SillyTavern.getContext().edits.showConflictResolution(...);
```

`showConflictResolution` 同时也从 `/scripts/lib/edits/conflict-ui.js`
re-export 出来以保持向后兼容，但新代码应从 `index.js` 导入（或走
`lukerContext` / `getContext()` 这两层），以便与 API 的其余部分保持一致。

### `applyEdits(edits, live)`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `edits` | `Edit[]` | 按顺序应用的带 op 类型编辑列表 |
| `live`  | `any`    | 当前 live 对象（内部深克隆，不会被修改） |

返回：

```js
{
    newLive: any,                   // 应用后的 live
    clean:    Edit[],               // 无冲突应用的编辑(部分 op 会就地补充信息以支持反向)
    conflicts: ConflictEntry[],     // 锚点 / 基线与当前 live 不匹配的编辑
    alreadyDone: Edit[],            // 效果已经存在于当前 live 中的编辑
}
```

### `inverseEdit(edit)`

返回能够撤销 `edit` 的反向编辑。某些 op 要求 `edit` 必须先经过
`applyEdits`（以便填充诸如 `_inserted_at` 或 `_anchor_context` 之类
的内部锚点上下文）—— 当你保存的是 `result.clean` 而非原始编辑数组
时，引擎会自动帮你处理这一点。

### `registerOp(name, handler)`

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `apply(deps, edit, live)` | 是 | 就地修改 live 并返回它 |
| `inverse(edit)` | 是 | 返回反向 Edit |
| `detectConflict(deps, edit, live)` | 是 | 干净时返回 `null`，冲突时返回 `{reason, baseline?, current?}`，无操作时返回 `{reason: 'already_done'}` |
| `renderConflict(entry)` | 否 | 可选，自定义冲突 UI 的 DOM |

`deps` 是 `{get, set, unset, isEqual, cloneDeep}`（lodash 方法）。
保留的 op 名：`set`、`unset`、`str_*`、`list_*`。自定义 op 请使用
`domain.action` 命名（如 `node.add`、`entry.update`）。

### 内置 op 参考

#### `set`
```js
{ op: 'set', path, oldValue, newValue }
```
替换 lodash path 处的值。当前值既不是 `oldValue` 也不是 `newValue`
时冲突；当前值等于 `newValue` 时视为已完成。

#### `unset`
```js
{ op: 'unset', path, expected_value? }
```
删除某个键（区别于将其设为 undefined）。path 不存在时视为已完成。
设置了 `expected_value` 且当前值与之深度不等时冲突。

#### `str_replace`
```js
{ op: 'str_replace', path, find, replace, expected_count? }
```
替换 `path` 处字符串中所有出现的 `find`。`expected_count` 默认为 1
—— 当 AI 想要替换多处时需要显式设置。冲突：`anchor_missing`
（计数为 0）、`anchor_ambiguous`（计数 ≠ 预期）。

#### `str_insert`
```js
{ op: 'str_insert', path, after_text, insert_text }
```
在 `after_text` 的唯一出现之后插入 `insert_text`。冲突：锚点缺失
或不唯一。

#### `str_delete`
```js
{ op: 'str_delete', path, find }
```
从字符串中删除唯一的 `find`。在 apply 时捕获周边上下文，以便反向
的 `str_insert` 能找回正确的位置。

#### `list_insert`
```js
{ op: 'list_insert', path, anchor: { before_index|after_index|after_value }, value }
```
将 `value` 插入数组。`after_value` 是最抗漂移的锚点（只要该值仍然
唯一，即使发生了重新排序也能保留）。

#### `list_remove`
```js
{ op: 'list_remove', path, index, expected_value? }
```
splice 掉 `index` 处的元素。`expected_value` 用于防范外部的偏移。

#### `list_move`
```js
{ op: 'list_move', path, from_index, to_index, expected_value? }
```
移动一个元素。`from === to` 时为无操作。

## 冲突 UI

`showConflictResolution(conflicts, opts?)` 返回 `Promise<Resolution[] | null>`。
- `null` 表示用户取消了整次应用。
- 每个 `Resolution` 为以下之一：
  - `{ decision: 'apply-mine', edit }` —— 用提案覆盖 live
  - `{ decision: 'keep-theirs', edit }` —— 跳过这条编辑
  - `{ decision: 'manual', edit, newValue }` —— 用户提供的值

要让用户的决策生效，请用解析后的值重新构建编辑数组，并再次调用
`applyEdits`（如果用户选择的是确定性的解决方案，结果中应该不会再
有冲突）。

## 范围外提醒

- 本库**不**管理编辑历史、journal、撤销栈或会话 —— 这是你的插件的
  责任。典型做法是把 `result.clean` 存到产生这些编辑的消息上，然后
  通过 `inverseEdit` 逆序遍历来完成回退。
- 本库**不**会在冲突时去提示 AI —— 由用户决定。如果你想要 AI 驱动
  的合并，请在你的插件里基于冲突结果自行实现。
