// #101 — Upload a custom avatar for a persona; the file should be served
// after restart and the thumbnail endpoint should return it.
//
// BLOCKER: in this worktree, `/api/avatars/upload` cannot complete. The
// upload handler runs incoming bytes through Jimp's `applyAvatarCropResize`
// which encodes via the squoosh WASM PNG codec; squoosh loads its WASM
// over a `file://` URL anchored at the resolved package location. The
// worktree's `node_modules` is symlinked to the main repo (Syncthing
// workflow) so Node resolves @jimp/wasm-png to a realpath under
// `/Users/funnycups/Desktop/projects/open-source/Luker/...` — outside
// `serverDirectory` (`/Users/funnycups/worktree/luker-e2e-expand`).
// `src/fetch-patch.js` rejects file:// fetches whose target sits outside
// serverDirectory, so the WASM init throws and the upload responds 400
// "Is not a valid image". Server logs:
//
//   [generateThumbnail] Failed to process image user-default.png: Error:
//   Requested file path is outside of the server directory.
//
// This is a worktree-only constraint, not a Luker bug — the same code
// works in a non-symlinked checkout. The test stays as fixme so the
// upload assertion isn't silently glossed over; lifting the fixme is
// just a matter of running in a real checkout (or copying node_modules
// instead of symlinking).
//
// Persona-CRUD coverage that does NOT depend on avatar upload lives in
// #99 (#99 pre-seeds the persona directly and exercises name1 + bubble
// + outbound-prompt propagation, which is the load-bearing behaviour).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'avatar-upload' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#101 — persona avatar upload persists to disk and is served', () => {
    test.fixme('upload custom avatar; restart; file is still served + thumbnail responds', async ({ page }) => {
        // See block comment at top of file. /api/avatars/upload is blocked by
        // the squoosh-WASM file:// fetch check in this worktree setup, so the
        // whole upload + thumbnail round-trip can't be exercised here.
        expect(server).toBeTruthy();
        expect(page).toBeTruthy();
    });
});
