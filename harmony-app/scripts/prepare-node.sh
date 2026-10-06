#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

NODE_VERSION="${NODE_VERSION:-24.2.0}"
RELEASE_REPO="${RELEASE_REPO:-electerm/ohos-node-shared}"
RELEASE_TAG="${RELEASE_TAG:-ohos-node-shared-v${NODE_VERSION}}"
ASSET_NAME="libnode-arm64.so"
ABI="arm64-v8a"
DOWNLOAD_URL="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
EXPECTED_SHA256="3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_sha256() {
  local file="$1" actual
  actual="$(sha256_of "${file}")"
  if [ "${actual}" != "${EXPECTED_SHA256}" ]; then
    echo "ERROR: sha256 mismatch for ${file}" >&2
    echo "  expected: ${EXPECTED_SHA256}" >&2
    echo "  actual:   ${actual}" >&2
    return 1
  fi
  echo "==> sha256 verified: ${actual}"
}

LIBS_DIR="${PROJECT_ROOT}/entry/libs/${ABI}"
OUT_BIN="${LIBS_DIR}/libnode.so"
mkdir -p "${LIBS_DIR}"

if [ ! -s "${OUT_BIN}" ]; then
  echo "==> Downloading ${DOWNLOAD_URL}"
  curl -fL --retry 5 --retry-all-errors --retry-delay 5 -o "${OUT_BIN}.tmp" "${DOWNLOAD_URL}"
  if ! verify_sha256 "${OUT_BIN}.tmp"; then
    rm -f "${OUT_BIN}.tmp"
    exit 1
  fi
  mv "${OUT_BIN}.tmp" "${OUT_BIN}"
else
  verify_sha256 "${OUT_BIN}" || exit 1
fi

echo "==> Verifying ${OUT_BIN} is a real shared library (ET_DYN, no PT_INTERP)"
python3 - "${OUT_BIN}" <<'PYEOF'
import struct, sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read(64)
    if data[:4] != b'\x7fELF':
        sys.exit("not an ELF file")
    ei_data = data[5]
    e_type = struct.unpack('<H' if ei_data == 1 else '>H', data[16:18])[0]
    e_phoff = struct.unpack('<Q' if ei_data == 1 else '>Q', data[32:40])[0]
    e_phentsize = struct.unpack('<H' if ei_data == 1 else '>H', data[54:56])[0]
    e_phnum = struct.unpack('<H' if ei_data == 1 else '>H', data[56:58])[0]
    has_interp = False
    with open(path, 'rb') as f:
        for i in range(e_phnum):
            f.seek(e_phoff + i * e_phentsize)
            ph = f.read(e_phentsize)
            if struct.unpack('<I' if ei_data == 1 else '>I', ph[0:4])[0] == 3:
                has_interp = True
    if not (e_type == 3 and not has_interp):
        sys.exit("REJECTED: not a true shared library")
    print("OK: ET_DYN without PT_INTERP")
PYEOF

echo "==> Ready: ${OUT_BIN} ($(du -h "${OUT_BIN}" | cut -f1))"
