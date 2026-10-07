export function parseField(report: string, key: string): string | null {
  const prefix: string = key + '=';
  const lines: string[] = report.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      return lines[i].substring(prefix.length);
    }
  }
  return null;
}

export function parseReportTime(report: string): number {
  const raw: string | null = parseField(report, 'time');
  if (raw === null) {
    return 0;
  }
  const n: number = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function isPending(reportTime: number, ackTime: number): boolean {
  return reportTime > ackTime;
}

export function isArkWebCrashReason(reason: number): boolean {
  return reason === 2 || reason === 3 || reason === 4;
}

export function buildCrashSummary(report: string): string {
  const keys: string[] = ['crash_type', 'time', 'exception', 'renderExitReason'];
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const value: string | null = parseField(report, keys[i]);
    if (value !== null) {
      parts.push(keys[i] + '=' + value);
    }
  }
  return parts.join('\n');
}
