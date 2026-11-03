# 存储审查

存储审查查看账户数据占用了多少空间，分为服务端与浏览器两部分，入口都在**用户设置 → 账户**。两部分采用相同的布局：配额行、堆叠使用条、图例与可下钻的列表。

## 服务端存储审查

**入口：**「用户设置」→「账户」→**「存储审查」**

按磁盘占用把账户数据分成十类：聊天、角色卡、世界书、图片、附件、预设、扩展、向量、备份、其它。点进任意类别可以查看具体文件。

审查工具本身只读，清理通过对应界面完成：在聊天面板删除聊天，在角色列表删除角色卡。`secrets.json` 这类敏感文件只显示大小。

管理员在「管理员面板」→「存储管理」里可以查看任一账户，或全部账户的汇总。

![服务端存储总览](/images/storage-inspector/01-self-l1.png)

![聊天下钻](/images/storage-inspector/02-self-chats-drilldown.png)

![Admin 聚合视图](/images/storage-inspector/05-admin-aggregate.png)

## 浏览器存储审查

**入口：**「用户设置」→「账户」→**「浏览器存储」**

按站点来源展示 `localStorage`、`sessionStorage`、`IndexedDB`、`Cache Storage` 与存储配额。点进任意类别可查看单个键、数据库、对象存储或缓存。

可以删除 `localStorage` / `sessionStorage` 键、清空对象存储、删除数据库或删除缓存。删除前二次确认，不可撤销。配额视图只读。

浏览器存储属于当前设备，同一账户在其他设备上的数据不在此显示。

![浏览器存储总览](/images/browser-storage-inspector/01-browser-l1.png)

![IndexedDB 下钻](/images/browser-storage-inspector/02-indexeddb-l2.png)

![删除确认](/images/browser-storage-inspector/03-delete-confirm.png)

## 常见问题

**配额显示「无限」是什么意思？**
部分浏览器不上报该站点的配额，Luker 显示「无限」。此时配额由浏览器的默认上限决定。

**删掉某个 `localStorage` 键会破坏 Luker 吗？**
取决于所选的键。界面语言覆盖、未保存的草稿与部分连接地址保存在 `localStorage`，删除后对应设置在下次加载时恢复默认值。确认弹窗会列出键名。

**为什么 IndexedDB 与 Cache Storage 的大小显示 `?`？**
浏览器不提供查询单个数据库或缓存字节总量的接口，精确计算需要逐条读取记录或缓存响应。顶部的数字来自浏览器上报的估算值。

**删了整个 IndexedDB 数据库，某个功能坏了。**
语音合成、模型缓存和离线资源把状态存储在 IndexedDB 与 Cache Storage。刷新页面后，它们会重新获取或初始化。
