---
description: Luker provides a HarmonyOS app that runs the complete Luker server and interface directly on your device, without a cloud server or terminal tools. This guide covers building the HAP from source and signing and installing it.
---

# HarmonyOS App

> **Why must I build it myself?** HarmonyOS's developer tools can only be downloaded after signing in with a Huawei account, and their license forbids redistribution. That rules out building the app on any public CI service, so there is no ready-to-install HAP to download — you build it from source. The same tools are required to sign and install the app on your device. Luker would ship a prebuilt HAP if the HarmonyOS ecosystem allowed it.

Luker provides a HarmonyOS app that runs the complete Luker server and interface directly on your device, without a cloud server or terminal tools.

## Overview

After installing the app, opening it displays the full Luker interface — there is no separate address to open in a browser. The app bundles the complete Luker server and frontend as a standalone application.

## Build from Source

### Prerequisites

- Node.js 24 or newer
- DevEco Studio, installed and signed in once (it provides the HarmonyOS toolchain and `hvigorw`)

### macOS and Linux

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

The build writes the unsigned HAP to `harmony-app/entry/build/default/outputs/default/entry-default-unsigned.hap`.

## Sign and Install

### 1. Create a signing certificate

Generate a key and a certificate signing request in DevEco Studio: choose **Build** → **Generate Key and CSR**, then set the keystore name and path, the keystore password, the key alias, and the key password.

Then create the certificate and the provisioning profile in AppGallery Connect:

1. Sign in to [AppGallery Connect](https://developer.huawei.com/consumer/en/service/josp/agc/index.html) and open **Certificates, App ID and Profile**.
2. Under **Certificates**, create a **debug** certificate and upload the `.csr` file. Download the resulting `.cer` file.
3. Connect your device and run `hdc shell bm get --udid` to read its UDID. Under **Devices**, add the device with that UDID.
4. Under **Profile**, create a **debug** profile for the bundle name `com.luker.harmony`, select the certificate and the device, then download the `.p7b` file.

### 2. Sign the HAP

Sign the built HAP with `hap-sign-tool.jar` from the HarmonyOS SDK:

```bash
java -jar hap-sign-tool.jar sign-app \
  -keyAlias <key-alias> \
  -signAlg SHA256withECDSA \
  -mode localSign \
  -appCertFile <certificate>.cer \
  -profileFile <profile>.p7b \
  -inFile entry-default-unsigned.hap \
  -keystoreFile <keystore>.p12 \
  -outFile luker-signed.hap \
  -keyPwd <key-password> \
  -keystorePwd <keystore-password>
```

### 3. Install the HAP

Enable **Developer options** and **USB debugging** on the device, connect it, then install:

```bash
hdc install -r luker-signed.hap
```

::: tip
DevEco Studio can also sign and install the app for you: open the project, configure automatic signing under **File** → **Project Structure** → **Signing Configs**, then run the app on the connected device.
:::

::: warning
A debug profile installs only on devices whose UDID is registered in it. To install on another device, add that device to the profile in AppGallery Connect and download the profile again.
:::

## Usage

After installation, open the Luker app:

1. The app automatically starts the built-in Luker server
2. Once the interface loads, you see the same Luker interface as the desktop version
3. Configure API connections, import character cards, and start chatting — all operations are identical to the desktop version

You do not enter any address or port; the app handles it automatically.

## Feature Differences from Desktop

The HarmonyOS version is functionally equivalent to the desktop version, with multiple API connections, character card management, world info, presets, and the rest.

Because mobile screen sizes and interaction methods differ, some interface layouts adapt to the mobile display.

## Related Pages

- [Getting Started](/guide/getting-started) — Complete installation guide
- [Configuration](/guide/configuration) — Configuration reference
