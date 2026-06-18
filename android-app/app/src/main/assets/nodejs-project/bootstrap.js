// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimeRoot = path.resolve(__dirname);
const dataRoot = path.join(runtimeRoot, 'data');
const logFile = path.join(runtimeRoot, 'bootstrap.log');

const appendLog = (level, ...args) => {
  const timestamp = new Date().toISOString();
  const text = args
    .map((item) => (item instanceof Error ? (item.stack || item.message) : String(item)))
    .join(' ');
  try {
    fs.appendFileSync(logFile, `[${timestamp}] [${level}] ${text}\n`, 'utf8');
  } catch {
    // Ignore logging failures to avoid affecting runtime startup.
  }
};

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

console.log = (...args) => {
  appendLog('LOG', ...args);
  originalConsole.log(...args);
};
console.info = (...args) => {
  appendLog('INFO', ...args);
  originalConsole.info(...args);
};
console.warn = (...args) => {
  appendLog('WARN', ...args);
  originalConsole.warn(...args);
};
console.error = (...args) => {
  appendLog('ERROR', ...args);
  originalConsole.error(...args);
};

process.on('uncaughtException', (error) => {
  appendLog('UNCAUGHT_EXCEPTION', error);
});
process.on('unhandledRejection', (reason) => {
  appendLog('UNHANDLED_REJECTION', reason);
});
process.on('beforeExit', (code) => {
  appendLog('BEFORE_EXIT', `code=${code}`);
});
process.on('exit', (code) => {
  appendLog('EXIT', `code=${code}`);
});

if (!fs.existsSync(dataRoot)) {
  fs.mkdirSync(dataRoot, { recursive: true });
}

// The APK packager releases prebuilt frontend Webpack bundles into
// runtime root under _prebuilt-bundles/. The server picks them up via this
// env var and skips its in-process Webpack compile when all three files
// (lib.core.bundle.js, lib.optional.bundle.js, codemirror.bundle.js) are
// present, which is the biggest single win on cold start.
if (!process.env.LUKER_PREBUILT_BUNDLES_DIR) {
  const candidate = path.join(runtimeRoot, '_prebuilt-bundles');
  if (fs.existsSync(candidate)) {
    process.env.LUKER_PREBUILT_BUNDLES_DIR = candidate;
  }
}

process.chdir(runtimeRoot);
appendLog('BOOT', `argv=${JSON.stringify(process.argv)}`);
appendLog('BOOT', `cwd=${process.cwd()}`);
appendLog('BOOT', `runtimeRoot=${runtimeRoot}`);
appendLog('BOOT', `dataRoot=${dataRoot}`);

const appendArg = (flag, value) => {
  if (!process.argv.includes(flag)) {
    process.argv.push(flag, value);
  }
};

appendArg('--port', '8000');
appendArg('--dataRoot', dataRoot);
appendLog('BOOT', `argv(after append)=${JSON.stringify(process.argv)}`);

// Run Luker server entry.
const serverEntryUrl = pathToFileURL(path.join(runtimeRoot, 'server.js')).href;
appendLog('BOOT', `importing ${serverEntryUrl}`);
await import(serverEntryUrl);
appendLog('BOOT', 'server.js import resolved');
