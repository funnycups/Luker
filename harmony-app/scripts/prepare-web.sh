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
rm -rf "${RESFILE_DIR}"
mkdir -p "${RESFILE_DIR}" "${BUNDLES_DIR}"

# -L: hvigor's resfile copy aborts on symbolic links, so dereference them.
for item in server.js webpack.config.js package.json package-lock.json plugins.js src public default plugins node_modules; do
  cp -RL "${REPO_ROOT}/${item}" "${RESFILE_DIR}/"
done

if [ -f "${REPO_ROOT}/config.yaml" ]; then
  cp "${REPO_ROOT}/config.yaml" "${RESFILE_DIR}/config.yaml"
else
  cp "${REPO_ROOT}/default/config.yaml" "${RESFILE_DIR}/config.yaml"
fi

cp "${PROJECT_ROOT}/resfile-src/bootstrap.js" "${RESFILE_DIR}/bootstrap.js"

echo "==> Collecting prebuilt bundles"
for bundle in lib.core.bundle.js lib.optional.bundle.js codemirror.bundle.js; do
  src=$(find "${REPO_ROOT}/dist/_webpack" -name "${bundle}" -type f -print -quit)
  if [ -z "${src}" ]; then
    echo "missing bundle: ${bundle}" >&2
    exit 1
  fi
  cp "${src}" "${BUNDLES_DIR}/${bundle}"
done

echo "==> resfile ready: ${RESFILE_DIR} ($(du -sh "${RESFILE_DIR}" | cut -f1))"
