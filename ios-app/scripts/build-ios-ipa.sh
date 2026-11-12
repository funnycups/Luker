#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
#
# iOS counterpart of android-app/scripts/build-android-apk.sh. Builds the
# unsigned Luker IPA: install deps, fetch the Node.js Mobile runtime, stage the
# server tree, generate the Xcode project, and package Payload/Luker.app.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
IOS_APP_DIR="${REPO_ROOT}/ios-app"

MODE="${1:-debug}"
MODE="$(printf '%s' "${MODE}" | tr '[:upper:]' '[:lower:]')"

case "${MODE}" in
  debug) XC_CONFIG="Debug" ;;
  release) XC_CONFIG="Release" ;;
  *)
    echo "Usage: bash ios-app/scripts/build-ios-ipa.sh [debug|release]" >&2
    exit 1
    ;;
esac

cd "${REPO_ROOT}"

if [[ "${INSTALL_RUNTIME_DEPS:-1}" == "1" ]]; then
  npm ci --omit=dev
fi

if [[ "${FETCH_NODEJS_MOBILE:-1}" == "1" ]]; then
  node ios-app/scripts/fetch-nodejs-mobile.mjs
fi

if [[ "${PREBUILD_FRONTEND_BUNDLES:-1}" == "1" ]]; then
  # Pre-compile the three frontend Webpack bundles so the app skips the slow
  # in-process compile on first launch (mirrors the Android gradle task).
  node docker/build-lib.js
fi

# Stage the server tree with the shared mobile runtime stager:
# bootstrap.js + git-shippable server tree + pruned production node_modules +
# _prebuilt-bundles/ + .runtime-tree-version.
STAGING_DIR="${IOS_APP_DIR}/Luker/Resources/nodejs-project"
node "${REPO_ROOT}/scripts/stage-mobile-runtime.mjs" \
  --repo-root "${REPO_ROOT}" \
  --output-dir "${STAGING_DIR}" \
  --bootstrap "${REPO_ROOT}/android-app/app/src/main/assets/nodejs-project/bootstrap.js"

APP_VERSION="$(node -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('./package.json', 'utf8')).version);")"
APP_BUILD_CODE="$(node -e "
const m = /^(\\d+)\\.(\\d+)\\.(\\d+)/.exec(process.argv[1]);
if (!m) { console.error('Version is not in semver format: ' + process.argv[1]); process.exit(1); }
console.log(Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]));
" "${APP_VERSION}")"

export APP_MARKETING_VERSION="${APP_VERSION}"
export APP_BUILD_VERSION="${APP_BUILD_CODE}"

xcodegen generate --spec "${IOS_APP_DIR}/project.yml"

xcodebuild \
  -project "${IOS_APP_DIR}/Luker.xcodeproj" \
  -scheme Luker \
  -configuration "${XC_CONFIG}" \
  -sdk iphoneos \
  -arch arm64 \
  -derivedDataPath "${IOS_APP_DIR}/build" \
  MARKETING_VERSION="${APP_MARKETING_VERSION}" \
  CURRENT_PROJECT_VERSION="${APP_BUILD_VERSION}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

BUILT_APP="${IOS_APP_DIR}/build/Build/Products/${XC_CONFIG}-iphoneos/Luker.app"
if [[ ! -d "${BUILT_APP}" ]]; then
  echo "Built app bundle not found at ${BUILT_APP}" >&2
  exit 1
fi

DIST_DIR="${IOS_APP_DIR}/dist"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/Payload"
cp -R "${BUILT_APP}" "${DIST_DIR}/Payload/Luker.app"
(
  cd "${DIST_DIR}"
  zip -qry "Luker-${APP_VERSION}-ios-unsigned.ipa" Payload
)
rm -rf "${DIST_DIR}/Payload"

IPA_PATH="${DIST_DIR}/Luker-${APP_VERSION}-ios-unsigned.ipa"
echo "Unsigned IPA: ${IPA_PATH}"
