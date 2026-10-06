#!/usr/bin/env bash
# build.sh — build the unsigned Luker HAP for HarmonyOS from source.
#
# For macOS and Linux. On Windows use build.ps1.
#
# Prerequisites:
#   - Node.js 24 or newer
#   - DevEco Studio installed (it provides the HarmonyOS toolchain and hvigorw)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"

echo "==> Installing Node dependencies"
cd "${REPO_ROOT}"
npm install

echo "==> Preparing the Node runtime"
bash "${SCRIPT_DIR}/prepare-node.sh"

echo "==> Preparing the web assets"
bash "${SCRIPT_DIR}/prepare-web.sh"

find_hvigorw() {
  if [ -n "${HVIGORW:-}" ] && [ -x "${HVIGORW}" ]; then
    echo "${HVIGORW}"; return 0
  fi
  if command -v hvigorw >/dev/null 2>&1; then
    command -v hvigorw; return 0
  fi
  for candidate in \
    "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw" \
    "${HOME}/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw"; do
    if [ -x "${candidate}" ]; then echo "${candidate}"; return 0; fi
  done
  return 1
}

HVIGORW_BIN="$(find_hvigorw || true)"
if [ -z "${HVIGORW_BIN}" ]; then
  echo "ERROR: hvigorw not found." >&2
  echo "  Install DevEco Studio, add its tools/hvigor/bin to PATH, or set HVIGORW." >&2
  exit 1
fi

# DevEco ships the SDK and a Node.js that hvigor is compatible with. The system
# Node may be too new (hvigor calls fs.rmdirSync with recursive, removed in Node 26).
DEVECO_HOME="$(cd "$(dirname "${HVIGORW_BIN}")/../../.." 2>/dev/null && pwd || true)"
if [ -n "${DEVECO_HOME}" ] && [ -d "${DEVECO_HOME}/sdk" ]; then
  export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-${DEVECO_HOME}/sdk}"
  export DEVECO_NODE_HOME="${DEVECO_NODE_HOME:-${DEVECO_HOME}/tools/node}"
  export NODE_HOME="${NODE_HOME:-${DEVECO_HOME}/tools/node}"
  export PATH="${DEVECO_NODE_HOME}/bin:${DEVECO_HOME}/tools/ohpm/bin:${DEVECO_HOME}/tools/hvigor/bin:${PATH}"
fi

echo "==> Building the HAP"
cd "${PROJECT_ROOT}"
"${HVIGORW_BIN}" assembleHap -p product=default -p buildMode=release --no-daemon

HAP="$(find "${PROJECT_ROOT}/entry/build" -name '*.hap' -type f -print -quit)"
echo "==> Done. HAP: ${HAP}"
