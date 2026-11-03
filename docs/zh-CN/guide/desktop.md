---
description: Luker 提供桌面版应用，让 macOS、Windows 与 Linux 用户以独立应用的形式运行完整的 Luker 服务与界面。指南介绍下载、安装、首次启动的系统安全提示放行、数据目录位置与卸载。
---

# 桌面端 App

Luker 提供桌面版应用，让 macOS、Windows 与 Linux 用户以独立应用的形式运行完整的 Luker 服务与界面。打开应用即可直接显示完整的 Luker 界面，不需要另外使用浏览器访问地址。

## 下载方式

前往 GitHub Releases 页面下载最新版：

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

发布版本同时提供 macOS、Windows 与 Linux 的安装包与免安装包，文件名包含版本、平台与架构，例如 `Luker-2.8.0-mac-arm64.dmg`。

| 文件名 | 说明 |
| --- | --- |
| `Luker-<version>-mac-<arch>.dmg` | macOS 磁盘映像，把应用拖入「应用程序」文件夹 |
| `Luker-<version>-mac-<arch>.zip` | macOS 压缩包，内容相同，解压到任意位置即可 |
| `Luker-<version>-win-<arch>.exe` | Windows 安装包，安装应用并创建快捷方式 |
| `Luker-<version>-win-<arch>.zip` | Windows 免安装压缩包，解压后直接运行 |
| `Luker-<version>-linux-x86_64.AppImage` 与 `Luker-<version>-linux-arm64.AppImage` | Linux 免安装包，`chmod +x` 后直接运行，不依赖发行版 |
| `Luker-<version>-linux-amd64.deb` 与 `Luker-<version>-linux-arm64.deb` | Debian 与 Ubuntu 安装包 |
| `Luker-<version>-linux-x86_64.rpm` 与 `Luker-<version>-linux-aarch64.rpm` | Fedora 与 openSUSE 安装包 |

`<arch>` 在 Apple Silicon Mac 与 Windows on ARM 上为 `arm64`，在 Intel Mac 与 Intel 或 AMD 处理器的 Windows 上为 `x64`。请选择与你的设备匹配的文件。

Linux 的文件名按格式采用不同的架构写法：`.AppImage` 为 `x86_64` 与 `arm64`，`.deb` 为 `amd64` 与 `arm64`，`.rpm` 为 `x86_64` 与 `aarch64`。

## 安装

安装包与免安装包任选其一即可。

### macOS

- **`.dmg`**：打开后把 **Luker** 拖入「应用程序」文件夹。
- **`.zip`**：解压后把 `Luker.app` 移入「应用程序」文件夹。

### Windows

- **`.exe`**：运行后按安装向导操作。
- **`.zip`**：解压后直接运行文件夹里的 `Luker.exe`。

杀毒软件有时会误报 `.exe`，因为安装包没有代码签名。遇到这种情况，放行后重新运行即可。

### Linux

- **`.AppImage`**：执行 `chmod +x` 后直接运行。
- **`.deb`**：交给包管理器安装。
- **`.rpm`**：交给包管理器安装。

Ubuntu 24.04 及之后，AppImage 可能需要在启动参数里加上 `--no-sandbox` 才能启动。`.deb` 与 `.rpm` 安装后不需要。

## 首次启动

应用未使用付费代码签名证书，因此 macOS 与 Windows 在首次打开时都会显示安全提示。这是正常现象，放行后应用即可正常运行。

### macOS

macOS 会以无法验证应用为由阻止首次启动。前往**系统设置** → **隐私与安全性**，找到关于 Luker 的提示，点击**仍要打开**，并在随后的对话框中确认。

### Windows

SmartScreen 会显示「Windows 已保护你的电脑」窗口，发布者显示为未知。点击**更多信息**，再点击**仍要运行**。

## 数据目录

应用把自身数据全部存放在同一个目录下：

| 平台 | 位置 |
| --- | --- |
| macOS | `~/Library/Application Support/Luker` |
| Windows | `%APPDATA%\Luker` |
| Linux | `~/.config/Luker` |

目录内的内容：

- `config.yaml`：服务端配置文件
- `data/`：聊天、预设、世界书的存储根目录
- `backups/`：聊天备份
- `plugins/`：服务端插件
- `extensions/third-party/`：第三方扩展

## 卸载

卸载应用只移除应用本身，不会删除数据目录，安装包与免安装包均如此。聊天、预设与配置均会保留，之后重新安装即可继续使用。

若要一并清除全部数据，卸载后手动删除上方的数据目录。

## 关闭窗口

在 Windows 与 macOS 上，关闭窗口不会结束应用：服务端与仍在生成的回复会在后台继续，重新打开窗口回到原来的页面。结束时从菜单退出应用。

Windows 上关闭窗口会把应用收进通知区域，托盘菜单可以打开窗口、打开数据目录、退出应用。Windows 11 会把新的通知区域图标收进折叠面板，首次关闭后图标可能在那里。

macOS 上关闭窗口后应用留在 Dock，点击 Dock 图标重新打开窗口，通过「Luker」菜单的「打开数据目录」进入数据目录，⌘Q 退出应用。

Linux 上没有托盘，关闭窗口就是退出应用，服务端也会一并停止。

## 存储后端

桌面版支持 `fs`、`mysql`、`postgres` 存储后端。`sqlite` 后端不受支持，本地存储请使用 `fs`。

## 从源码运行

在代码仓库中执行 `npm run start:electron` 会以仓库里的代码启动同一个应用。它使用与安装版相同的数据目录，而不是仓库里的 `./data`，因此写入的配置、聊天与预设互相可见。

## 更新

有新版本时，应用会在界面里显示更新提示。点击**下载更新**会把当前平台的安装包交给系统安装程序。

Linux 上 AppImage 会被就地替换，替换完成后提示重启应用。`.deb` 与 `.rpm` 更新会交给系统安装程序。

## 相关页面

- [快速开始](/zh-CN/guide/getting-started) —— 完整的安装指南
- [基础配置](/zh-CN/guide/configuration) —— 配置项说明
- [存储后端](/zh-CN/guide/configuration#存储后端) —— 服务端支持的存储后端
