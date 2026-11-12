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

# Stage the server tree with the same layout the Android packager ships:
# bootstrap.js + the Luker server tree + _prebuilt-bundles/, all inside the
# nodejs-project folder reference that the runtime manager copies out on
# first boot.
STAGING_DIR="${IOS_APP_DIR}/Luker/Resources/nodejs-project"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"

rsync -a \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='*.map' \
  --include='/server.js' \
  --include='/webpack.config.js' \
  --include='/package.json' \
  --include='/package-lock.json' \
  --include='/plugins.js' \
  --include='/config.yaml' \
  --include='/src/' --include='/src/***' \
  --include='/public/' --include='/public/***' \
  --include='/default/' --include='/default/***' \
  --include='/plugins/' --include='/plugins/***' \
  --include='/node_modules/' --include='/node_modules/***' \
  --exclude='*' \
  ./ "${STAGING_DIR}/"

PREBUILT_DIR="${STAGING_DIR}/_prebuilt-bundles"
mkdir -p "${PREBUILT_DIR}"
for bundle in lib.core.bundle.js lib.optional.bundle.js codemirror.bundle.js; do
  # build-lib.js writes outputs to dist/_webpack/<cacheVersion>/output/*.js.
  found="$(find "${REPO_ROOT}/dist/_webpack" -type f -name "${bundle}" -path '*/output/*' | head -n 1)"
  if [[ -z "${found}" ]]; then
    echo "Prebuilt frontend bundle missing: ${bundle}" >&2
    exit 1
  fi
  cp "${found}" "${PREBUILT_DIR}/${bundle}"
done

cp "${REPO_ROOT}/android-app/app/src/main/assets/nodejs-project/bootstrap.js" \
  "${STAGING_DIR}/bootstrap.js"

# Content hash of the staged tree. The iOS shell keys its runtime marker on it,
# so app updates that ship the same server tree skip the full copy on first
# launch.
RUNTIME_TREE_VERSION="$(node "${SCRIPT_DIR}/runtime-tree-version.mjs" "${STAGING_DIR}")"
printf '%s\n' "${RUNTIME_TREE_VERSION}" > "${STAGING_DIR}/.runtime-tree-version"
echo "Runtime tree version: ${RUNTIME_TREE_VERSION}"

APP_VERSION="$(node -p "require('./package.json').version")"
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
