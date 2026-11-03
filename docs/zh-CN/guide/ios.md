# iOS

Luker 可以在 iPhone 与 iPad 上以自签名应用的方式运行。应用内置后端，打开后直接显示与桌面版相同的界面，不需要另外运行服务器。

## 为什么不在 App Store 上架

Luker 以 AGPL-3.0 授权。App Store 的条款与该许可要求的自由复制、修改、再分发冲突，构成[应用商店的法律障碍](https://en.wikipedia.org/wiki/GNU_General_Public_License#Legal_barrier_to_application_stores)，因此 Luker 不通过 App Store 分发。iOS 安装包以未签名 IPA 发布，由你用自己的 Apple ID 签名。

## 准备

- iPhone 或 iPad，iOS 16 或更高版本。
- 一台电脑，用于首次安装 AltStore 或 SideStore。
- 一个 Apple ID。免费账号即可。付费开发者账号可以把签名有效期从 7 天延长到 1 年。
- 从 GitHub Releases 下载的未签名 IPA。

## 下载

从 [GitHub Releases](https://github.com/funnycups/Luker/releases/latest) 下载最新的 iOS 安装包，文件名以 `-ios-unsigned.ipa` 结尾。

## 安装

1. 在 iPhone 或 iPad 上安装 AltStore 或 SideStore，按 [altstore.io](https://altstore.io/) 或 [sidestore.io](https://sidestore.io/) 的引导完成首次设置。AltStore Classic 需要电脑运行 AltServer；SideStore 在设置时生成配对文件。
2. 把 IPA 保存到设备。
3. 在 AltStore 或 SideStore 中打开 IPA，登录 Apple ID，开始签名。
4. 打开「设置」→「通用」→「VPN 与设备管理」，信任开发者证书。
5. 如果 iOS 提示，打开「设置」→「隐私与安全性」→「开发者模式」，开启后重启设备。
6. 打开 Luker。

::: warning
免费 Apple ID 的签名 7 天后过期，设备上最多同时保留 3 个自签名应用。到期前重新签名即可。付费开发者账号的签名为 1 年。
:::

## 首次启动

Luker 会启动本地服务器并打开界面。首次启动需要一点时间准备本地环境。API 连接、角色卡导入等操作与桌面版相同。

应用在本机运行。安装完成后不需要电脑或远程服务器。

## 后台生成与通知

在「用户设置」中开启「后台保活」后，生成会在 Luker 进入后台时继续运行。系统资源紧张时 iOS 可能暂停应用，因此不保证生成一定完成。

开启「当 Luker 在后台时，消息生成完成后显示通知。」后，回复在后台完成时会发送本地通知。开启开关时系统会请求通知权限。仅在 Luker 运行时发送通知。

启动失败或应用异常退出时，Luker 会提示导出诊断包。诊断包包含原生日志、崩溃报告、内置服务日志与网页控制台记录。

## 限制

- 后台生成是尽力而为。iOS 在资源紧张时可能暂停应用。
- 更新从 GitHub Releases 下载并重新签名。建议使用同一个 Apple ID 签名并覆盖安装。
- 如果需要更换签名用的 Apple ID，请先[备份数据](/zh-CN/features/user-settings-additions#备份、迁移与存储)，再卸载旧版应用并安装新版本。

这里指的是给 App 签名用的 Apple ID；设备上登录的 iCloud 或 App Store 账号不影响更新。

## 用浏览器访问 Luker

也可以不安装应用，直接在浏览器中使用 Luker。在一台电脑上运行 Luker，然后在 Safari 中打开：

1. 在电脑上开启网络访问：
   - 同一网络内 —— 见[局域网访问](/zh-CN/guide/lan-access)。
   - 从网络之外 —— 见[远程访问](/zh-CN/guide/remote-access)。
2. 在 iPhone 或 iPad 上打开 Safari，输入主机地址。局域网内形如 `http://192.168.1.23:8000`；经代理或隧道访问时，输入你的域名。
3. 若启用了鉴权，需先登录。

## 添加到主屏幕

Luker 可以作为主屏幕图标安装，打开时在自己的窗口中运行，而不是浏览器标签页。

1. 在 Safari 中打开 Luker。
2. 轻点**分享**按钮。
3. 轻点**添加到主屏幕**。
4. 命名后轻点**添加**。

图标会在独立窗口中打开 Luker，不显示 Safari 地址栏，并使用 Luker 图标。

## 相关页面

- [局域网访问](/zh-CN/guide/lan-access) —— 让同一网络内的设备访问 Luker
- [远程访问](/zh-CN/guide/remote-access) —— 从网络之外访问 Luker
- [Android App](/zh-CN/guide/android) —— Android 平台的应用
- [HarmonyOS App](/zh-CN/guide/harmonyos) —— HarmonyOS 平台的应用
- [桌面端 App](/zh-CN/guide/desktop) —— 桌面平台的应用
