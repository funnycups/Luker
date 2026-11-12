#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"

RESFILE_DIR="${PROJECT_ROOT}/entry/src/main/resources/resfile/luker"
BUNDLES_DIR="${RESFILE_DIR}/_prebuilt-bundles"

echo "==> Building frontend bundles"
cd "${REPO_ROOT}"
node docker/build-lib.js

echo "==> Staging Luker project into resfile"
node "${REPO_ROOT}/scripts/stage-mobile-runtime.mjs" \
  --repo-root "${REPO_ROOT}" \
  --output-dir "${RESFILE_DIR}" \
  --bootstrap "${PROJECT_ROOT}/resfile-src/bootstrap.js"

echo "==> resfile ready: ${RESFILE_DIR} ($(du -sh "${RESFILE_DIR}" | cut -f1))"
