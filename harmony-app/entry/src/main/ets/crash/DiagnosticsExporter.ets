import fs from '@ohos.file.fs';
import { zlib } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { fileUri } from '@kit.CoreFileKit';
import { common, bundleManager } from '@kit.AbilityKit';
import { getBackendStatus } from 'libnode_ctl.so';
import { readAll, StoredReport } from './CrashReportStore';
import { BackendManager } from '../BackendManager';

const TAIL_BYTES: number = 512 * 1024;

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, true);
  } catch {
    // exists
  }
}

function writeText(path: string, text: string): void {
  const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
  fs.writeSync(file.fd, text);
  fs.closeSync(file);
}

function copyTail(src: string, dst: string): void {
  let size: number = 0;
  try {
    size = fs.statSync(src).size;
  } catch {
    writeText(dst, '<log not found: ' + src + '>');
    return;
  }
  const start: number = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
  const len: number = size - start;
  const inFile = fs.openSync(src, fs.OpenMode.READ_ONLY);
  const buf: ArrayBuffer = new ArrayBuffer(len);
  const bytesRead: number = fs.readSync(inFile.fd, buf, { offset: start, length: len });
  fs.closeSync(inFile);
  const outFile = fs.openSync(dst, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
  fs.writeSync(outFile.fd, buf.slice(0, bytesRead));
  fs.closeSync(outFile);
}

function buildSummary(filesDir: string): string {
  const lines: string[] = [];
  lines.push('Luker diagnostics bundle');
  lines.push('generatedAt=' + new Date().toISOString());
  lines.push('device=' + deviceInfo.brand + ' ' + deviceInfo.productModel);
  lines.push('os=' + deviceInfo.osFullName);
  try {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    lines.push('versionName=' + info.versionName + ', versionCode=' + info.versionCode);
  } catch {
    lines.push('versionName=<unknown>');
  }
  let backend: string = '<unavailable>';
  try {
    backend = getBackendStatus();
  } catch {
    // keep default
  }
  lines.push('backendStatus=' + backend);
  lines.push('filesDir=' + filesDir);
  return lines.join('\n');
}

export async function exportTo(context: common.UIAbilityContext): Promise<string> {
  const filesDir: string = context.filesDir;
  const nodeLogDir: string = BackendManager.dataDir !== '' ? BackendManager.dataDir : filesDir;
  const staging: string = context.cacheDir + '/diagnostics';
  ensureDir(staging);
  ensureDir(staging + '/crashes');
  ensureDir(staging + '/node');

  writeText(staging + '/summary.txt', buildSummary(filesDir));

  const reports: StoredReport[] = readAll(filesDir);
  for (let i = 0; i < reports.length; i++) {
    writeText(staging + '/crashes/' + reports[i].name, reports[i].body);
  }

  copyTail(nodeLogDir + '/node-boot.log', staging + '/node/node-boot.log');
  copyTail(nodeLogDir + '/node-boot.prev.log', staging + '/node/node-boot.prev.log');
  copyTail(nodeLogDir + '/bootstrap.log', staging + '/node/bootstrap.log');

  const zipPath: string = context.cacheDir + '/luker-diagnostics-' + Date.now() + '.zip';
  await zlib.compressFile(staging, zipPath, {
    level: zlib.CompressLevel.COMPRESS_LEVEL_DEFAULT_COMPRESSION,
    memLevel: zlib.MemLevel.MEM_LEVEL_DEFAULT,
    strategy: zlib.CompressStrategy.COMPRESS_STRATEGY_DEFAULT_STRATEGY
  });

  const record: systemShare.SharedRecord = {
    utd: utd.UniformDataType.ARCHIVE,
    uri: fileUri.getUriFromPath(zipPath),
    title: context.resourceManager.getStringSync($r('app.string.export_share_title').id)
  };
  const data: systemShare.SharedData = new systemShare.SharedData(record);
  const controller: systemShare.ShareController = new systemShare.ShareController(data);
  try {
    await controller.show(context, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    });
  } catch (e) {
    throw new Error('share failed for ' + zipPath + ': ' + String(e));
  }
  return zipPath;
}
