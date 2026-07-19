# 存储审查

Luker 提供两个互补的存储审查工具，一个针对服务端的用户数据目录，一个针对当前设备浏览器本地的存储。两者入口都在**「用户设置」→「帐户」**下，共用同一套视觉布局：配额行、堆叠使用条、图例，以及可下钻的列表。

## 服务端存储审查

**入口：**「用户设置」→「帐户」→**「存储审查」**

**展示什么：** 你账户在磁盘上的十大类内容：聊天、角色卡、世界书、图片、附件、预设、扩展、向量、备份、其它。堆叠条按字节数汇总每一类，列表可以下钻进任意类别查看具体文件（聊天存档、角色卡文件、世界书 JSON、背景图等）。

**Admin 可以做什么：** 管理员在「管理员面板」→「存储管理」标签里，可以单独查看任一用户账户的存储，或者查看跨全部用户的聚合视图。

**做不了什么：** 这个审查工具**只读**，不提供删除功能。需要清理请走对应的界面（在聊天面板删聊天，在角色列表删角色卡等）。像 `secrets.json` 这类敏感文件只显示大小，不允许下钻查看内容。

![服务端存储总览](/images/storage-inspector/01-self-l1.png)

![聊天下钻](/images/storage-inspector/02-self-chats-drilldown.png)

![Admin 聚合视图](/images/storage-inspector/05-admin-aggregate.png)

## 浏览器存储审查

**入口：**「用户设置」→「帐户」→**「浏览器存储」**

**展示什么：** 浏览器为每个 origin 提供的五大类存储：`localStorage`、`sessionStorage`、`IndexedDB`（数据库与对象存储）、`Cache Storage`（Service Worker 缓存），以及存储配额（浏览器对此 origin 的用量与总量估算）。下钻进任意类别查看具体项：单个 localStorage 键、单个数据库及其对象存储、单个缓存。

**可以删除什么：** 可以删除单个 `localStorage` 或 `sessionStorage` 键、清空单个 `IndexedDB` 对象存储、删除整个 `IndexedDB` 数据库，或删除单个 Cache Storage 缓存。每次删除前都会二次确认，且不可撤销。存储配额视图是纯信息展示，不可删除。

**做不了什么：** 它不会碰服务器上的账户数据，只影响你当前使用的这个浏览器 —— 用同一账户在其他设备上登录时，那边浏览器的存储是独立的。

![浏览器存储总览](/images/browser-storage-inspector/01-browser-l1.png)

![IndexedDB 下钻](/images/browser-storage-inspector/02-indexeddb-l2.png)

![删除确认](/images/browser-storage-inspector/03-delete-confirm.png)

## 常见问题

**存储配额显示「无限」是什么意思？**
有些浏览器不上报此 origin 的配额，Luker 显示为「无限」。实际上浏览器仍会静默地施加它自己的限制。

**删除某个 `localStorage` 键会不会破坏 Luker？**
有可能。Luker 会把当前界面语言覆盖、未保存的草稿、某些连接地址存进 `localStorage`。删掉某一项之后，对应设置在下次页面加载时会回落到默认值。确认弹窗会给出具体的 key 名，让你自己判断。

**为什么 IndexedDB 与 Cache Storage 的大小列显示 `?`？**
浏览器没有提供快速查询单库或单缓存字节总量的 API。要精确得知就得逐条记录、逐个响应地读，对大规模存储非常慢。审查器顶部展示的是浏览器给出的聚合估算（`navigator.storage.estimate()`）作为参考。

**两个审查器看到的是同一份数据吗？**
不是。服务端存储审查看的是 Luker 服务器磁盘上的文件（同账户下所有设备共享）。浏览器存储审查只看当前这个浏览器 origin 本地的存储（每设备独立）。

**我删了整个 IndexedDB 数据库，然后某个功能坏了怎么办？**
某些 Luker 功能与第三方库（语音合成、模型缓存、离线资源）用 IndexedDB 与 Cache Storage 存状态。删掉之后，下次加载时会强制重新拉取或重新初始化。删除后刷新页面，功能通常会自动重新填充所需存储。
