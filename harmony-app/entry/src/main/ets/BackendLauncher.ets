import fs from '@ohos.file.fs';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { startBackend } from 'libnode_ctl.so';
import { BackendManager } from './BackendManager';

const TAG: string = 'luker.boot';
const DOMAIN: number = 0xE1EC;
const BACKEND_PORT: number = 8000;
const EL2_APP_FILES: string = '/data/storage/el2/base/files';
const DATA_SUBDIR: string = 'luker-data';

function dirExists(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pickDataDir(context: common.Context): string {
  const candidates: string[] = [
    `${EL2_APP_FILES}/${DATA_SUBDIR}`,
    EL2_APP_FILES,
    `${context.filesDir}/${DATA_SUBDIR}`,
    context.filesDir
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      if (!dirExists(candidates[i])) {
        fs.mkdirSync(candidates[i], true);
      }
      const probe: string = `${candidates[i]}/.write-test`;
      fs.closeSync(fs.openSync(probe, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE));
      fs.unlinkSync(probe);
      hilog.info(DOMAIN, TAG, 'data dir: %{public}s', candidates[i]);
      return candidates[i];
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'data dir unusable: %{public}s', candidates[i]);
    }
  }
  return context.tempDir;
}

function resolveScriptPath(bundleCodeDir: string): string {
  const candidates: string[] = [
    `${bundleCodeDir}/entry/resources/resfile/luker/bootstrap.js`,
    `${bundleCodeDir}/resources/resfile/luker/bootstrap.js`
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      if (fs.statSync(candidates[i]).isFile()) {
        hilog.info(DOMAIN, TAG, 'script: %{public}s', candidates[i]);
        return candidates[i];
      }
    } catch {
      // try next candidate
    }
  }
  return candidates[0];
}

/**
 * Resolves the backend data dir without starting the backend, so the crash
 * dialog can export the previous run's node logs before a new launch rotates
 * them.
 */
export function prepareDataDir(context: common.Context): void {
  if (BackendManager.dataDir === '') {
    BackendManager.dataDir = pickDataDir(context);
  }
}

export function buildEntryParams(context: common.Context): string {
  const dataDir: string = pickDataDir(context);
  BackendManager.dataDir = dataDir;
  const scriptPath: string = resolveScriptPath(context.bundleCodeDir);
  const entryParams: string = [
    `dataDir=${dataDir}`,
    `script=${scriptPath}`,
    `port=${BACKEND_PORT}`
  ].join('\n');
  BackendManager.entryParams = entryParams;
  return entryParams;
}

export function launchInProcessEarly(context: common.Context): boolean {
  if (BackendManager.launchAttempted) {
    return BackendManager.inProcess;
  }
  BackendManager.launchAttempted = true;
  try {
    const entryParams: string = buildEntryParams(context);
    const rc: string = startBackend(entryParams);
    hilog.info(DOMAIN, TAG, 'startBackend -> %{public}s', rc);
    if (rc.startsWith('err:')) {
      return false;
    }
    BackendManager.setInProcess();
    return true;
  } catch (e) {
    hilog.error(DOMAIN, TAG, 'startBackend threw: %{public}s', JSON.stringify(e));
    return false;
  }
}
