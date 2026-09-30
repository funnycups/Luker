#!/usr/bin/env node
/**
 * record.js — controlled Playwright recording for Luker README GIFs
 * Usage:  node record.js <scenario> <output-dir>
 * scenarios: warmup, orch, cardapp, memgraph
 * Reads a scenario module from ./scenarios/<name>.js which exports
 *   async function run(page, ctx) { ... }
 * Records the whole session as webm at 1280x720.
 *
 * Every run wipes any pre-existing chat artifacts AND restarts the Luker
 * server. Restart is required because the server keeps an in-memory recent-chat
 * index that survives filesystem changes; without restart the welcome page
 * still shows chats from prior recordings.
 */
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { chromium } = require(resolvePlaywright());

/**
 * Resolve a playwright install whose bundled browser revision is actually on
 * disk. A globally installed playwright can be newer than the browsers in
 * ~/Library/Caches/ms-playwright, which fails at launch with "Executable
 * doesn't exist". Prefer the repo-local copy used by the e2e suite.
 */
function resolvePlaywright() {
  const candidates = [
    path.resolve(__dirname, '../../tests/node_modules/playwright'),
    '/opt/homebrew/lib/node_modules/playwright',
    'playwright',
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      require(candidate);
      const version = require(path.join(candidate, 'package.json')).version;
      console.log(`[branding] playwright ${version} from ${candidate}`);
      return candidate;
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`no usable playwright install:\n${errors.join('\n')}`);
}

const SERVER_LOG = '/tmp/luker-branding-server.log';
const SERVER_URL = 'http://127.0.0.1:8123/';

function killExistingServer() {
  try {
    const pids = execSync('lsof -ti :8123', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { execSync(`kill ${pid}`); } catch (_) {}
      }
      // wait for socket release
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const still = execSync('lsof -ti :8123', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          if (!still) break;
        } catch (_) { break; }
        require('child_process').execFileSync('sleep', ['0.2']);
      }
    }
  } catch (_) { /* nothing on port */ }
}

async function startServer() {
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn('node', ['server.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      execSync(`curl -sf -o /dev/null ${SERVER_URL}`);
      return child.pid;
    } catch (_) { /* not ready */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('server failed to start within 20s');
}

async function main() {
  const scenario = process.argv[2];
  const outDir = process.argv[3] || './recordings';
  if (!scenario) { console.error('missing scenario'); process.exit(2); }
  const modPath = path.resolve(`./tools/branding/scenarios/${scenario}.cjs`);
  if (!fs.existsSync(modPath)) { console.error('no scenario file:', modPath); process.exit(2); }
  const scenarioMod = require(modPath);

  fs.mkdirSync(outDir, { recursive: true });

  // Wipe prior chat history for a clean welcome screen. Only affects the branding-recording data root, never the main tree.
  const chatsRoot = path.resolve('./data/default-user/chats');
  const groupChatsRoot = path.resolve('./data/default-user/group chats');
  let wiped = 0;
  for (const root of [chatsRoot, groupChatsRoot]) {
    if (!fs.existsSync(root)) continue;
    for (const sub of fs.readdirSync(root)) {
      const full = path.join(root, sub);
      try {
        // Nuke everything INSIDE the character dir (jsonl + sidecars) rather than the dir itself.
        // The dir gets recreated by the server on next chat write, and Explorer/etc keeping a
        // handle to it can prevent recursive removal on macOS.
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          for (const inner of fs.readdirSync(full)) {
            fs.rmSync(path.join(full, inner), { recursive: true, force: true });
            wiped++;
          }
        } else {
          fs.rmSync(full, { force: true });
          wiped++;
        }
      } catch (e) { console.error('wipe failed for', full, e.message); }
    }
  }
  console.log('[branding] wiped', wiped, 'chat artifacts');

  // Restart the server so its in-memory recent-chat index rebuilds from the wiped disk.
  console.log('[branding] restarting server...');
  killExistingServer();
  const pid = await startServer();
  console.log('[branding] server ready, pid', pid);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  page.on('console', msg => {
    if (msg.text().includes('[branding]')) console.log('[browser]', msg.text());
  });

  // Intercept /version so the badge in the top bar renders as clean "Luker 2.7.0" instead of showing the feature branch name.
  await page.route('**/version', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.gitBranch = 'release';
    body.gitRevision = '';
    await route.fulfill({ response: resp, json: body });
  });

  // Inject pretty-mode overrides on every navigation so both firstRun and normal UI stay clean.
  await page.addInitScript(() => {
    try { localStorage.setItem('language', 'en-us'); } catch (_) {}

    // Persistent pretty-mode: rewrite version badge every time it renders, hide upstream-only Discord links.
    const injectCss = () => {
      const id = '__luker_branding_css__';
      if (document.getElementById(id)) return;
      const el = document.createElement('style');
      el.id = id;
      el.textContent = `
        a[href*="discord.gg/sillytavern"] { display: none !important; }
      `;
      (document.head || document.documentElement).appendChild(el);
    };
    const scrubBadge = () => {
      const v = document.querySelector('#version_display');
      if (v && v.textContent !== 'Luker') {
        console.log('[branding] scrubBadge: was', JSON.stringify(v.textContent).slice(0, 80));
        v.textContent = 'Luker';
      }
    };
    const start = () => {
      injectCss(); scrubBadge();
      const mo = new MutationObserver(() => { scrubBadge(); injectCss(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      // Also poll for safety (some frames swap version_display via textContent under an animation)
      setInterval(scrubBadge, 250);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  });

  page.on('load', async () => {
    try {
      // no-op; the init script handles per-frame patching. Kept as a hook for future tweaks.
    } catch (_) {}
  });

  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' });

  try {
    await scenarioMod.run(page);
  } catch (err) {
    console.error('scenario failed:', err && err.message);
  }

  const video = page.video();
  await context.close();
  await browser.close();
  const videoPath = await video.path();
  console.log('video:', videoPath);
}

main().catch(err => { console.error(err); process.exit(1); });
