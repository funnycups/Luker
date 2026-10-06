import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read-only source bundle: this bootstrap runs from the HAP resfile, which
// cannot be written. server.js chdir()s to its own directory and creates
// runtime dirs relative to cwd (e.g. mkdir 'backups/'), so the server must
// run from a writable copy instead.
const sourceRoot = path.resolve(__dirname);

const dataRoot = process.env.LUKER_DATA_ROOT || path.join(sourceRoot, 'data');
// Writable runtime copy. Derived as a sibling of the data root so it is
// guaranteed to live under the same el2 (or filesDir) tree.
const runtimeRoot =
  process.env.LUKER_RUNTIME_ROOT || path.join(path.dirname(dataRoot), 'luker-runtime');
const port = process.env.PORT || '8000';

fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });

const logFile = path.join(dataRoot, 'bootstrap.log');

const appendLog = (level, ...args) => {
  const timestamp = new Date().toISOString();
  const text = args
    .map((item) => (item instanceof Error ? (item.stack || item.message) : String(item)))
    .join(' ');
  try {
    fs.appendFileSync(logFile, `[${timestamp}] [${level}] ${text}\n`, 'utf8');
  } catch {
    // logging must never affect startup
  }
};

process.on('uncaughtException', (error) => appendLog('UNCAUGHT_EXCEPTION', error));
process.on('unhandledRejection', (reason) => appendLog('UNHANDLED_REJECTION', reason));

// The read-only bundle is re-staged on every rebuild/reinstall. Any change
// anywhere in the tree (src/, public/, plugins/, _prebuilt-bundles/, config.yaml,
// …) must invalidate the copy, so the cache key is a metadata-only walk of the
// whole source tree: each entry's relative path + size + mtime, sorted for
// determinism. Re-launches with an unchanged bundle skip the ~600MB copy.
function collectBundleEntries(root, relBase, out) {
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const rel = relBase ? `${relBase}/${dirent.name}` : dirent.name;
    const full = path.join(root, dirent.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      out.push(`${rel}:missing`);
      continue;
    }
    if (st.isDirectory()) {
      out.push(`${rel}/:dir`);
      collectBundleEntries(full, rel, out);
    } else {
      out.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  }
}

function bundleSignature(root) {
  const entries = [];
  collectBundleEntries(root, '', entries);
  entries.sort();
  return entries.join('|');
}

const signature = bundleSignature(sourceRoot);
const markerFile = path.join(runtimeRoot, '.bundle-marker');
let currentMarker = '';
try {
  currentMarker = fs.readFileSync(markerFile, 'utf8');
} catch {
  // no marker yet — first launch
}

if (currentMarker !== signature) {
  const startedAt = Date.now();
  appendLog('BOOT', `staging runtime copy ${sourceRoot} -> ${runtimeRoot}`);
  try {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    for (const entry of fs.readdirSync(sourceRoot)) {
      fs.cpSync(path.join(sourceRoot, entry), path.join(runtimeRoot, entry), {
        recursive: true,
        force: true,
        dereference: false
      });
    }
    fs.writeFileSync(markerFile, signature, 'utf8');
    appendLog('BOOT', `runtime copy done in ${Date.now() - startedAt}ms`);
  } catch (error) {
    appendLog('BOOT', `runtime copy FAILED after ${Date.now() - startedAt}ms`, error);
    throw error;
  }
} else {
  appendLog('BOOT', 'runtime copy up to date; skipping');
}

const prebuilt = path.join(runtimeRoot, '_prebuilt-bundles');
if (fs.existsSync(prebuilt)) {
  process.env.LUKER_PREBUILT_BUNDLES_DIR = prebuilt;
}

process.chdir(dataRoot);
appendLog('BOOT', `sourceRoot=${sourceRoot}`);
appendLog('BOOT', `runtimeRoot=${runtimeRoot}`);
appendLog('BOOT', `dataRoot=${dataRoot}`);
appendLog('BOOT', `prebuilt=${process.env.LUKER_PREBUILT_BUNDLES_DIR || '<none>'}`);

const appendArg = (flag, value) => {
  if (!process.argv.includes(flag)) {
    process.argv.push(flag, value);
  }
};

appendArg('--port', port);
appendArg('--dataRoot', dataRoot);

appendLog('BOOT', `argv=${JSON.stringify(process.argv)}`);
const serverEntryUrl = pathToFileURL(path.join(runtimeRoot, 'server.js')).href;
appendLog('BOOT', `importing ${serverEntryUrl}`);
await import(serverEntryUrl);
appendLog('BOOT', 'server.js import resolved');
