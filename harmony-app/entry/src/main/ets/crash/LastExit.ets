import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { write } from './CrashReportStore';

const LAST_EXIT_FILE_NAME: string = 'luker-last-exit.txt';

/**
 * The system reports why the previous run ended synchronously in
 * UIAbility.onCreate (launchParam.lastExitReason), unlike the hiAppEvent
 * APP_CRASH event, which arrives asynchronously some time after launch. The
 * crash dialog keys off this value so it appears on the very next launch.
 */
export class LastExit {
  /** Set when the previous run ended abnormally: the backend waits for the crash dialog. */
  static deferBackend: boolean = false;
}

function abnormalReasonName(reason: AbilityConstant.LastExitReason): string | null {
  switch (reason) {
    case AbilityConstant.LastExitReason.CPP_CRASH:
      return 'CPP_CRASH';
    case AbilityConstant.LastExitReason.JS_ERROR:
      return 'JS_ERROR';
    case AbilityConstant.LastExitReason.APP_FREEZE:
      return 'APP_FREEZE';
    case AbilityConstant.LastExitReason.PERFORMANCE_CONTROL:
      return 'PERFORMANCE_CONTROL';
    case AbilityConstant.LastExitReason.RESOURCE_CONTROL:
      return 'RESOURCE_CONTROL';
    default:
      return null;
  }
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Writes a crash report for an abnormal previous exit and returns true; returns
 * false when the previous run ended normally. `time` is the launch time so the
 * report is newer than any earlier acknowledgement.
 */
export function recordLastExit(filesDir: string, launchParam: AbilityConstant.LaunchParam): boolean {
  const name: string | null = abnormalReasonName(launchParam.lastExitReason);
  if (name === null) {
    return false;
  }
  const lines: string[] = [
    'source=launchParam',
    'crash_type=' + name,
    'time=' + Date.now(),
    'exception=' + oneLine(launchParam.lastExitMessage ?? '')
  ];
  const detail: AbilityConstant.LastExitDetailInfo | undefined = launchParam.lastExitDetailInfo;
  if (detail !== undefined) {
    lines.push('exitTimestamp=' + detail.timestamp);
    lines.push('pid=' + detail.pid);
    lines.push('processName=' + detail.processName);
    lines.push('exitSubReason=' + detail.exitSubReason);
    lines.push('exitMsg=' + oneLine(detail.exitMsg ?? ''));
    lines.push('rss=' + detail.rss);
    lines.push('pss=' + detail.pss);
  }
  write(filesDir, LAST_EXIT_FILE_NAME, lines.join('\n') + '\n');
  return true;
}
