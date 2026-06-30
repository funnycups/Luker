# 聊天合并与拆分

按你选择的顺序，把几个聊天合并成一个，并可对每个来源裁剪范围；或者在你选择的切点，把一个聊天拆成多个新聊天。源聊天始终保留不变。

## 合并聊天

1. 打开 **过往聊天**（当前角色或群组的聊天列表弹窗），点击弹窗顶部的合并图标。

   ![两个待合并的聊天](/screenshots/chat-merge-split/01-two-chats-ready.png)

2. 点击 **+ 添加聊天** 选择源聊天。可以添加任意多个，同一个聊天也可以重复添加。

   ![合并对话框含两个源](/screenshots/chat-merge-split/02-merge-dialog-two-sources.png)

3. **拖动每行左侧的 ⋮⋮ 把手** 重新排序。有三个或更多来源时，可将任一行拖到任意位置。

   ![合并对话框含三个源](/screenshots/chat-merge-split/04-merge-dialog-three-sources.png)

   ![拖拽重排后的效果](/screenshots/chat-merge-split/05-merge-dialog-after-drag.png)

4. **设置 `起始` / `结束` 数字** 来只包含源的一部分。彩色条显示当前包含的消息范围。点击 **全选** 把某一行恢复为完整聊天。

   ![已裁剪的段](/screenshots/chat-merge-split/06-merge-dialog-trimmed.png)

5. 在顶部输入 **目标名称**，点击 **合并**。新聊天会自动打开。

   ![新合并的聊天](/screenshots/chat-merge-split/03-merged-chat-opened.png)

## 拆分聊天

1. 找到你想要拆分的位置那条消息，点击该消息按钮栏里的 ✂ **拆分聊天** 图标。
2. 弹窗会以这条消息的索引为初始切点。点击 **+ 添加切点** 增加更多切点；在数字输入框里微调位置。

   ![三段拆分对话框](/screenshots/chat-merge-split/07-split-dialog-three-segments.png)

3. 按需要重命名每段，然后点击 **拆分**。新聊天会出现在聊天列表里，源聊天保持不变。

## 群组聊天

群组聊天的合并方式完全一致。从群组打开过往聊天，按上面的合并流程操作即可。

![待合并的群组聊天](/screenshots/chat-merge-split/20-group-two-chats-ready.png)

![群组合并对话框](/screenshots/chat-merge-split/21-group-merge-dialog-two-sources.png)

合并后的群组聊天会自动注册到群组里，因此会出现在该群组的过往聊天列表中，可以像任何其他群组聊天一样打开。

## 注意事项

- 新聊天只包含消息。**插件状态——记忆图、编排器、搜索工具等每聊天侧档——不会迁移。** 你需要在新聊天里重新生成。
- 源聊天永远不会被修改或删除。
- 如果目标名称已被占用，系统会自动追加 ` (2)`、` (3)` 等后缀。
- 在单角色聊天和群组聊天里行为一致。同源限制：不能把角色聊天和群组聊天合并到一起。

## 实现原理

服务端端点 `POST /api/chats/merge` 与 `POST /api/chats/split`（以及对应的 `/group/*` 版本）通过 `ChatRepo` 读取每个源，在内存中构建新的消息数组和聊天头，再通过 `ChatRepo.save(...)` 写入新聊天。由于读写都走同一个仓储抽象层，无论底层是文件系统、SQLite、MySQL 还是 PostgreSQL，功能行为完全一致。
