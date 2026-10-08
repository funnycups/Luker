import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import http from '@ohos.net.http';
import { getBackendStatus } from 'libnode_ctl.so';
import { BackendManager } from '../BackendManager';
import { launchInProcessEarly } from '../BackendLauncher';
import { promptAction } from '@kit.ArkUI';
import { listPending, acknowledge, StoredReport } from '../crash/CrashReportStore';
import { buildCrashSummary, isArkWebCrashReason } from '../crash/CrashSummary';
import { exportTo } from '../crash/DiagnosticsExporter';
import { writeArkWebExit } from '../crash/CrashCapture';
import { LastExit } from '../crash/LastExit';

const TAG: string = 'luker.Index';
const DOMAIN: number = 0xE1EC;
const SERVER_URL: string = 'http://127.0.0.1:8000';
const BOOT_TIMEOUT_MS: number = 120_000;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State serverReady: boolean = false;
  @State statusMessage: string = '';
  private exporting: boolean = false;
  private crashDialogDone: boolean = false;

  aboutToAppear(): void {
    this.statusMessage = this.res($r('app.string.starting_engine').id, '0s');
    let dialogShown: boolean = false;
    try {
      dialogShown = this.checkPendingCrash();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'checkPendingCrash failed: %{public}s', JSON.stringify(e));
    }
    if (!dialogShown) {
      this.start();
    }
  }

  private res(id: number, arg?: string): string {
    const mgr = getContext(this).resourceManager;
    return arg === undefined ? mgr.getStringSync(id) : mgr.getStringSync(id, arg);
  }

  private crashFilesDir(): string {
    return (getContext(this) as common.UIAbilityContext).filesDir;
  }

  private async doExport(): Promise<void> {
    if (this.exporting) {
      return;
    }
    this.exporting = true;
    try {
      await exportTo(getContext(this) as common.UIAbilityContext);
    } catch (e) {
      promptAction.showToast({
        message: this.res($r('app.string.export_failed').id, String(e))
      });
    } finally {
      this.exporting = false;
    }
  }

  /**
   * Shows the crash dialog when the previous run ended abnormally or an
   * unacknowledged report exists. Returns true when the dialog is shown; the
   * backend start then waits for the dialog, so an export captures the crashed
   * run's node logs before a new launch rotates them.
   */
  private checkPendingCrash(): boolean {
    const pending: StoredReport[] = listPending(this.crashFilesDir());
    if (pending.length === 0 && !LastExit.deferBackend) {
      return false;
    }
    let summary: string = '';
    for (let i = 0; i < pending.length; i++) {
      summary += buildCrashSummary(pending[i].body) + '\n\n';
    }
    if (summary.trim().length === 0) {
      summary = this.res($r('app.string.no_crash_report').id);
    }
    promptAction.showDialog({
      title: this.res($r('app.string.crash_dialog_title').id),
      message: this.res($r('app.string.crash_dialog_intro').id) + '\n\n' + summary,
      buttons: [
        { text: this.res($r('app.string.crash_dialog_close').id), color: '#8b93a7' },
        { text: this.res($r('app.string.export_diagnostics').id), color: '#4aa3ff' }
      ]
    }).then(async (result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        await this.doExport();
      }
      this.finishCrashDialog();
    }).catch(() => {
      this.finishCrashDialog();
    });
    return true;
  }

  private finishCrashDialog(): void {
    if (this.crashDialogDone) {
      return;
    }
    this.crashDialogDone = true;
    // Acknowledge with the current time: a hiAppEvent report for the same
    // crash that arrives later carries an earlier time and stays acknowledged.
    acknowledge(this.crashFilesDir(), Date.now());
    LastExit.deferBackend = false;
    this.start();
  }

  async start(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    if (!BackendManager.launchAttempted) {
      launchInProcessEarly(context);
    }
    const startedAt: number = Date.now();
    while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
      if (await this.probe()) {
        this.serverReady = true;
        this.controller.loadUrl(SERVER_URL);
        return;
      }
      const secs: number = Math.round((Date.now() - startedAt) / 1000);
      const status: string = getBackendStatusSafe();
      this.statusMessage =
        this.res($r('app.string.starting_engine').id, `${secs}s`) + '\n' +
        this.res($r('app.string.backend_status').id, status);
      if (status.startsWith('failed:')) {
        this.statusMessage = this.res($r('app.string.engine_failed').id, status);
        return;
      }
      await this.sleep(200);
    }
    this.statusMessage = this.res($r('app.string.engine_timeout').id);
  }

  async probe(): Promise<boolean> {
    const client = http.createHttp();
    try {
      const resp = await client.request(SERVER_URL, {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000,
        usingCache: false
      });
      return resp.responseCode >= 200 && resp.responseCode < 500;
    } catch {
      return false;
    } finally {
      client.destroy();
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
  }

  build() {
    Stack() {
      Web({ src: $rawfile('loading.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onRenderExited((event) => {
          if (event && isArkWebCrashReason(event.renderExitReason)) {
            writeArkWebExit(this.crashFilesDir(), event.renderExitReason);
          }
        })

      if (!this.serverReady) {
        Column({ space: 16 }) {
          Text('Luker').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#cfd6e4')
          LoadingProgress().width(36).height(36).color('#4aa3ff')
          Button(this.res($r('app.string.export_diagnostics').id))
            .fontSize(12)
            .backgroundColor('#23262c')
            .fontColor('#cfd6e4')
            .onClick(() => { this.doExport(); })
          Text(this.statusMessage)
            .fontSize(12)
            .fontColor('#8b93a7')
            .textAlign(TextAlign.Center)
            .padding({ left: 24, right: 24 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#15171a')
      }
    }
    .width('100%')
    .height('100%')
  }
}

function getBackendStatusSafe(): string {
  try {
    return getBackendStatus();
  } catch {
    return 'unavailable';
  }
}
