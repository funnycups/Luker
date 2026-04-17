# Android App

Luker provides an Android APK version that lets you run Luker directly on your phone without relying on a cloud server or terminal tools like Termux.

## Overview

After installing the APK, opening the app displays the full Luker interface — no need to visit a URL in a separate browser. The app bundles the complete Luker server and frontend as a standalone application.

## Download

Download the latest APK from the GitHub Releases page:

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

Download the `.apk` file, then open it on your phone and follow the system prompts to complete installation.

::: tip
On first install, Android may warn about "unknown sources." You'll need to allow installation from this source in your system settings.
:::

## Usage

After installation, open the Luker app:

1. The app automatically starts the built-in Luker server
2. Once the interface loads, you'll see the same Luker interface as the desktop version
3. Configure API connections, import character cards, start chatting — all operations are identical to the desktop version

You don't need to manually enter any address or port; the app handles everything automatically.

## Feature Differences from Desktop

The Android version is functionally equivalent to the desktop version. You can use all core features, including multiple API connections, character card management, world info, presets, and more.

Due to differences in screen size and interaction methods on mobile devices, some interface layouts are automatically adapted for mobile display.

## Mobile Optimizations

Luker includes several optimizations for mobile devices:

- **Virtual keyboard handling** — Prevents interface jumping when the keyboard appears
- **IME compatibility** — Properly handles CJK and other IME composition input
- **Dialog adaptation** — Dialogs and popups display correctly on small screens
- **Touch interaction improvements** — Reduces accidental swipe triggers and improves touch experience
- **Performance optimization** — Reduces resource loading pressure at startup, adapting to mobile device memory constraints

::: warning
Due to Android device performance and memory limitations, handling very large amounts of chat logs or character cards may be slightly slower than on desktop. It's recommended to periodically clean up unnecessary data.
:::

## Related Pages

- [Getting Started](/guide/getting-started) — Complete installation guide
- [Configuration](/guide/configuration) — Configuration reference
