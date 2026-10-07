import { hiAppEvent, hilog } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import { write } from './CrashReportStore';

const TAG: string = 'luker.crash';
const DOMAIN: number = 0xE1EC;

export const NATIVE_JS_REPORT: string = 'luker-last-crash-report.txt';
export const FREEZE_REPORT: string = 'luker-last-appfreeze.txt';
export const ARKWEB_REPORT: string = 'luker-last-webview-crash-report.txt';

let gFilesDir: string = '';

function paramString(params: Record<string, Object>, key: string): string {
  const v: Object | undefined = params[key];
  if (v === undefined || v === null) {
    return '';
  }
  return String(v);
}

function paramJson(params: Record<string, Object>, key: string): string {
  const v: Object | undefined = params[key];
  if (v === undefined || v === null) {
    return '';
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function paramLines(params: Record<string, Object>, key: string): string {
  const v: Object | undefined = params[key];
  if (v === undefined || v === null) {
    return '';
  }
  if (Array.isArray(v)) {
    const arr: Object[] = v as Object[];
    const out: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(String(arr[i]));
    }
    return out.join('\n');
  }
  return String(v);
}

function readExternalLog(params: Record<string, Object>): string {
  const v: Object | undefined = params['external_log'];
  if (v === undefined || v === null || !Array.isArray(v)) {
    return '<external_log unavailable>';
  }
  const paths: Object[] = v as Object[];
  const chunks: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path: string = String(paths[i]);
    chunks.push('--- external_log (' + path + ') ---');
    try {
      chunks.push(fs.readTextSync(path));
    } catch (e) {
      chunks.push('<unreadable>');
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : '<external_log unavailable>';
}

function buildReport(eventName: string, params: Record<string, Object>): string {
  const lines: string[] = [];
  lines.push('source=hiappevent');
  lines.push('event=' + eventName);
  lines.push('crash_type=' + paramString(params, 'crash_type'));
  lines.push('time=' + paramString(params, 'time'));
  lines.push('foreground=' + paramString(params, 'foreground'));
  lines.push('release_type=' + paramString(params, 'release_type'));
  lines.push('cpu_abi=' + paramString(params, 'cpu_abi'));
  lines.push('bundle_version=' + paramString(params, 'bundle_version'));
  lines.push('pid=' + paramString(params, 'pid'));
  lines.push('uid=' + paramString(params, 'uid'));
  lines.push('process_life_time=' + paramString(params, 'process_life_time'));
  lines.push('log_over_limit=' + paramString(params, 'log_over_limit'));
  lines.push('exception=' + paramJson(params, 'exception'));
  lines.push('memory=' + paramJson(params, 'memory'));
  lines.push('--- hilog ---');
  lines.push(paramLines(params, 'hilog'));
  lines.push('--- external_log ---');
  lines.push(readExternalLog(params));
  return lines.join('\n');
}

function reportFileName(eventName: string, crashType: string): string {
  if (eventName === hiAppEvent.event.APP_FREEZE || crashType === 'APP_FREEZE' || crashType === 'AppFreeze') {
    return FREEZE_REPORT;
  }
  return NATIVE_JS_REPORT;
}

function handleEvent(eventName: string, info: hiAppEvent.AppEventInfo): void {
  const params: Record<string, Object> = info.params as Record<string, Object>;
  const crashType: string = paramString(params, 'crash_type');
  const time: number = Number(paramString(params, 'time'));
  const body: string = buildReport(eventName, params);
  const name: string = reportFileName(eventName, crashType);
  const path: string = write(gFilesDir, name, body);
  hilog.info(DOMAIN, TAG, 'crash report written: %{public}s', path);
}

export function installCrashWatcher(filesDir: string): void {
  if (gFilesDir !== '') {
    return;
  }
  const watcher: hiAppEvent.Watcher = {
    name: 'luker_crash_watcher',
    appEventFilters: [
      {
        domain: hiAppEvent.domain.OS,
        names: [hiAppEvent.event.APP_CRASH, hiAppEvent.event.APP_FREEZE]
      }
    ],
    onReceive: (domain: string, appEventGroups: hiAppEvent.AppEventGroup[]) => {
      for (let g = 0; g < appEventGroups.length; g++) {
        const group: hiAppEvent.AppEventGroup = appEventGroups[g];
        for (let i = 0; i < group.appEventInfos.length; i++) {
          handleEvent(group.name, group.appEventInfos[i]);
        }
      }
    }
  };
  try {
    hiAppEvent.addWatcher(watcher);
  } catch (e) {
    hilog.error(DOMAIN, TAG, 'failed to install crash watcher: %{public}s', JSON.stringify(e));
    return;
  }
  gFilesDir = filesDir;
  hilog.info(DOMAIN, TAG, 'crash watcher installed');
}

export function writeArkWebExit(filesDir: string, reason: number): void {
  const now: number = Date.now();
  const body: string = 'source=arkweb-render-exit\ntime=' + String(now) + '\nrenderExitReason=' + String(reason);
  write(filesDir, ARKWEB_REPORT, body);
}
