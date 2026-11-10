#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

# Print the changelog section for a release tag, without the heading itself.
# Usage: release-notes.sh <tag> [changelog-path]

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tag> [changelog-path]" >&2
  exit 2
fi

tag="$1"
changelog="${2:-docs/changelog.md}"
version="${tag#v}"
target="## v${version} ("

if [[ ! -f "$changelog" ]]; then
  echo "Changelog not found: ${changelog}" >&2
  exit 1
fi

body="$(awk -v target="$target" '
  index($0, target) == 1 { found = 1; next }
  found && /^## / { exit }
  found { lines[++count] = $0 }
  END {
    if (!found) exit 1
    while (count > 0 && lines[count] ~ /^[[:space:]]*$/) count--
    start = 1
    while (start <= count && lines[start] ~ /^[[:space:]]*$/) start++
    for (i = start; i <= count; i++) {
      line = lines[i]
      if (line ~ /^###+ /) sub(/^#/, "", line)
      print line
    }
  }
' "$changelog")" || {
  echo "No '## v${version}' section in ${changelog}. Add the release section before tagging." >&2
  exit 1
}

if [[ -z "$body" ]]; then
  echo "Section '## v${version}' in ${changelog} is empty." >&2
  exit 1
fi

printf '%s\n' "$body"
