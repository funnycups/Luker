import fs from '@ohos.file.fs';
import { isPending, parseReportTime } from './CrashSummary';

const CRASH_DIR_NAME: string = 'crash';
const ACK_FILE_NAME: string = '.ack';

export interface StoredReport {
  name: string;
  path: string;
  time: number;
  body: string;
}

function crashDir(filesDir: string): string {
  return filesDir + '/' + CRASH_DIR_NAME;
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, true);
  } catch {
    // already exists
  }
}

function writeText(path: string, text: string): void {
  const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
  fs.writeSync(file.fd, text);
  fs.closeSync(file);
}

export function write(filesDir: string, name: string, body: string): string {
  const dir: string = crashDir(filesDir);
  ensureDir(dir);
  const path: string = dir + '/' + name;
  writeText(path, body);
  return path;
}

export function readAll(filesDir: string): StoredReport[] {
  const dir: string = crashDir(filesDir);
  const out: StoredReport[] = [];
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch {
    return out;
  }
  for (let i = 0; i < names.length; i++) {
    const name: string = names[i];
    if (name === ACK_FILE_NAME) {
      continue;
    }
    const path: string = dir + '/' + name;
    let body: string = '';
    try {
      body = fs.readTextSync(path);
    } catch {
      continue;
    }
    out.push({ name: name, path: path, time: parseReportTime(body), body: body });
  }
  return out;
}

export function readAck(filesDir: string): number {
  try {
    const raw: string = fs.readTextSync(crashDir(filesDir) + '/' + ACK_FILE_NAME);
    const n: number = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function listPending(filesDir: string): StoredReport[] {
  const ack: number = readAck(filesDir);
  return readAll(filesDir).filter((r: StoredReport) => isPending(r.time, ack));
}

export function acknowledge(filesDir: string, maxTime: number): void {
  const dir: string = crashDir(filesDir);
  ensureDir(dir);
  writeText(dir + '/' + ACK_FILE_NAME, String(maxTime));
}
