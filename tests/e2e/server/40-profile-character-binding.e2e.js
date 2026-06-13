// #40 — Profile bound to character → switch character → profile follows.
//
// FIXME: As of release 2.7.0 the connection-manager extension at
// public/scripts/extensions/connection-manager/index.js does NOT implement
// per-character profile binding. The extension exposes profile create /
// switch / delete / get (via the `/profile` slash command), but there is no
// hook on CHARACTER_SELECTED / CHAT_CHANGED that swaps the active profile
// based on the current character.
//
// I searched:
//   - public/scripts/extensions/connection-manager/index.js — no
//     `characterId`, `chid`, `CHARACTER_SELECTED`, or `CHAT_CHANGED` refs
//   - the embedding/rerank companion files — same
//   - the broader public/scripts/extensions tree — no character → profile
//     binding plugin
//
// If/when this feature lands (e.g. a `profileByCharacter` map keyed by
// avatar-filename living in extensionSettings.connectionManager), the test
// scaffold below can be un-fixme-d and finished.
//
// The deliberate failure path for an absent feature is `test.fixme`, per
// the AGENT_BRIEF rule: "Blocked → test.fixme()".

import { test } from '@playwright/test';

test.describe('#40 — profile bound to character (auto-switch on character select)', () => {
    test.fixme('not implemented: no per-character profile binding in connection-manager', () => {});
});
