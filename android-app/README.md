# Luker Android App (Backend-in-App)

This directory contains an Android shell app that runs Luker backend locally on the phone and opens it in a WebView.

## Architecture

- **WebView UI**: loads `http://127.0.0.1:8000`
- **Backend runtime**: Node.js Mobile (`libnode.so` + JNI bridge)
- **App boot flow**:
  1. copy runtime assets to app-private runtime storage
  2. start Node with `bootstrap.js`
  3. wait for local server
  4. open WebView

## Local build

From repository root:

```bash
npm ci --omit=dev
bash android-app/scripts/build-android-apk.sh debug
```

Equivalent manual steps:

```bash
node android-app/scripts/fetch-nodejs-mobile.mjs
android-app/gradlew -p android-app :app:assembleDebug
```

Debug APK outputs (per-ABI and universal):

`android-app/app/build/outputs/apk/debug/app-<abi>-debug.apk` (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `universal`)

Runtime fetch policy:

- Default runtime asset:
  - `https://github.com/funnycups/nodejs-mobile/releases/download/v1.0.1/nodejs-mobile-android.zip`
- By default the script enforces `Node major >= 24`.
- Override knobs:
  - `NODEJS_MOBILE_ASSET_URL` (direct runtime zip URL)
  - `NODEJS_MOBILE_ASSET_NAME` (optional display/name hint)
  - `NODEJS_MOBILE_ASSET_FILE` (local runtime zip path; if omitted, `./nodejs-mobile-android.zip` is auto-detected when present)
  - `NODEJS_MOBILE_RUNTIME_MAJOR` (manual major version hint when URL/name does not include version)
  - `NODEJS_MOBILE_TAG` (`latest` or concrete tag, used when no direct asset URL is provided)
  - `NODEJS_MOBILE_OWNER` / `NODEJS_MOBILE_REPO` (used when no direct asset URL is provided)
  - `NODEJS_MOBILE_MIN_MAJOR` (default `24`)
  - `NODEJS_MOBILE_ENFORCE_MIN_MAJOR` (`1` by default; set `0` to bypass)

## Release build (signed)

Set environment variables before Gradle release build:

- `ANDROID_KEYSTORE_FILE`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Then run:

```bash
bash android-app/scripts/build-android-apk.sh release
```

## CI model

- `push` on any branch: build debug APK artifact.
- `push` on any tag: build signed release APK and publish/update the GitHub Release for that tag.
- `workflow_dispatch`: supports manual `debug` / `release` selection.

## Update model

- No in-app APK auto-update is implemented.
- Recommend GitHub Release distribution with user-side APK overlay install.
- App data stays in app-specific storage and survives overlay install.
- Preferred persistent root is `Android/data/<package>/files/luker-data`.
- Server plugins and global third-party extensions live directly under that root:
  - `plugins/`
  - `extensions/third-party/`
