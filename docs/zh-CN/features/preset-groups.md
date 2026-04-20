# 预设分组

预设分组是 Luker 为预设选择器引入的分组展示功能。当你积累了大量预设后，扁平的下拉列表会变得难以管理。预设分组允许你将预设归入命名分组，在下拉选择器中以分组 header + 成员的层级结构展示。

## 数据模型

每个分组包含以下字段：

```js
{
    id: string,         // 分组 ID（当前实现为 pg-<timestamp>-<random>）
    name: string,       // 分组名称
    presets: string[]    // 成员预设名称列表
}
```

分组数据按 API 类型存储在 `power_user.preset_groups[apiId]` 中，通过 `getPresetGroups()` 读取，并由 `createPresetGroup()`、`renamePresetGroup()`、`deletePresetGroup()`、`addPresetToGroup()`、`removePresetFromGroup()` 等方法修改，随后通过设置保存持久化。

## 每个 API 类型独立维护

预设分组按 API 类型（如 Chat Completion、Text Completion 等）独立维护。不同 API 类型的预设分组互不影响，切换 API 类型时会加载对应的分组配置。

## 分组展示

### 分组 Header 可折叠

在预设下拉选择器中，每个分组显示为一个可折叠的 header。点击 header 可以展开或收起该分组下的所有预设，方便在大量预设中快速定位。

### 成员缩进展示

分组内的预设成员以缩进的方式展示在 header 下方，形成清晰的层级视觉结构。

### 未分组预设保持顶层

未归入任何分组的预设保持在下拉列表的顶层位置，不受分组结构的影响。

## 分组管理

### 右键菜单

预设分组的管理操作通过右键菜单完成：

- **创建分组**：新建一个命名分组
- **重命名分组**：修改已有分组的名称
- **删除分组**：移除分组，组内预设回到未分组状态
- **移入/移出分组**：将预设添加到分组或从分组中移除

### 预设生命周期同步

分组系统会自动响应预设的生命周期事件：

- **预设重命名**：分组中的成员名称自动同步更新
- **预设删除**：自动从所属分组中移除

## Select2 适配器

Luker 实现了自定义的 Select2 适配器，用于在下拉选择器中渲染分组结构和操作按钮：

1. 收集所有真实 option 元素（跳过分组 header）
2. 保留自定义属性（如 `data-luker-char-bound`）
3. 清空 select 后先添加未分组预设
4. 按分组顺序添加 header 和成员

## 相关功能

- [提示词分组](/zh-CN/features/prompt-groups) — 提示词管理器中的分组系统
- [补全预设助手](/zh-CN/features/preset-assistant) — AI 辅助理解和调整预设参数
