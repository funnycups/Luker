---
description: Luker 提供了鸿蒙应用，让你直接在设备上运行完整的 Luker 服务与界面，无需依赖云服务器或终端工具。指南介绍从源码构建 HAP 并安装到设备的完整步骤。
---

# HarmonyOS App

> **为什么必须自己构建？** 鸿蒙的开发者工具必须登录华为账号才能下载，且其许可禁止再分发。公开 CI 服务因此无法合法构建鸿蒙应用，没有可直接安装的 HAP 提供下载，只能从源码构建。签名与安装同样依赖这些工具，每一步都绕不开华为开发者账号。若鸿蒙生态允许，Luker 会直接发布现成的 HAP。

Luker 提供了鸿蒙应用，让你直接在设备上运行完整的 Luker 服务与界面，无需依赖云服务器或终端工具。

## 概述

安装 HAP 后，打开应用即可直接显示完整的 Luker 界面，不需要另外使用浏览器访问地址。应用内置了完整的 Luker 服务端和前端，是一个独立运行的应用。

## 从源码构建

### 前置条件

- Node.js 24 或更高版本
- DevEco Studio，安装并登录一次，它提供鸿蒙工具链与 `hvigorw`

### 设置包名

包名在 `harmony-app/AppScope/app.json5` 中配置，默认为 `com.luker.hmos`。鸿蒙应用的包名在 AppGallery 内必须全局唯一，且不能与其他 Android 应用重复，因此请在构建前换成你自己的包名。如果 AppGallery 提示名称已被占用，换一个并同步修改这个文件。

包名至少包含三段，以点号分隔，每段只能使用字母、数字与下划线。以下保留字不能单独作为一段：`oh`、`ohos`、`harmony`、`harmonyos`、`openharmony`、`system`。例如 `com.yourname.luker` 可用，`com.yourname.harmony` 不可用。

APP ID 创建后包名不能修改，填写时必须与这里设置的包名一致。

### macOS 与 Linux

```bash
git clone https://github.com/funnycups/Luker.git
cd Luker
bash harmony-app/scripts/build.sh
```

### Windows

```powershell
git clone https://github.com/funnycups/Luker.git
cd Luker
powershell -ExecutionPolicy Bypass -File harmony-app\scripts\build.ps1
```

构建完成后，未签名的 HAP 位于 `harmony-app/entry/build/default/outputs/default/entry-default-unsigned.hap`。

## 签名与安装

### 1. 创建应用

登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)，进入 **证书、App ID 和 Profile**，选择 **HarmonyOS**，创建应用。填写应用名称、`app.json5` 中设置的包名以及其余应用信息。

### 2. 创建签名证书

在 DevEco Studio 里生成密钥与证书请求文件：依次选择 **Build** → **Generate Key and CSR**，设置密钥库名称与路径、密钥库密码、密钥别名与密钥密码。

然后创建证书与描述文件：

1. 在 **证书** 下创建 **调试** 证书，上传 `.csr` 文件，下载生成的 `.cer` 文件。
2. 连接设备，执行 `hdc shell bm get --udid` 读取设备 UDID。在 **设备** 下用该 UDID 添加设备。
3. 在 **Profile** 下为这个包名创建 **调试** 描述文件，选择证书与设备，下载 `.p7b` 文件。

### 3. 签名 HAP

用鸿蒙 SDK 里的 `hap-sign-tool.jar` 为构建出的 HAP 签名：

```bash
java -jar hap-sign-tool.jar sign-app \
  -keyAlias <密钥别名> \
  -signAlg SHA256withECDSA \
  -mode localSign \
  -appCertFile <证书>.cer \
  -profileFile <描述文件>.p7b \
  -inFile entry-default-unsigned.hap \
  -keystoreFile <密钥库>.p12 \
  -outFile luker-signed.hap \
  -keyPwd <密钥密码> \
  -keystorePwd <密钥库密码>
```

### 4. 安装 HAP

在设备上启用 **开发者选项** 与 **USB 调试**，连接设备后安装：

```bash
hdc install -r luker-signed.hap
```

::: tip
也可以用 DevEco Studio 完成签名与安装：打开项目，在 **File** → **Project Structure** → **Signing Configs** 里配置自动签名，再在已连接的设备上运行应用。
:::

::: warning
调试描述文件只能安装到其中已登记 UDID 的设备。要在另一台设备上安装，需在 AppGallery Connect 里把该设备加入描述文件并重新下载。
:::

## 使用方式

安装完成后，打开 Luker 应用：

1. 应用会自动启动内置的 Luker 服务
2. 界面加载完成后，你会看到与桌面版完全相同的 Luker 界面
3. 配置 API 连接、导入角色卡、开始对话——所有操作与桌面版一致

你不需要手动输入任何地址或端口，应用会自动处理一切。

## 与桌面版的功能差异

鸿蒙版本与桌面版在功能上基本一致，你可以使用所有核心功能，包括多 API 连接、角色卡管理、世界书、预设等。

由于移动设备的屏幕尺寸和交互方式不同，部分界面布局会自动适配移动端显示。

## 相关页面

- [快速开始](/zh-CN/guide/getting-started) —— 完整的安装指南
- [基础配置](/zh-CN/guide/configuration) —— 配置项说明
