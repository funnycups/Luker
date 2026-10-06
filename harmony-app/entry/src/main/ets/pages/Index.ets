import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import http from '@ohos.net.http';
import { getBackendStatus } from 'libnode_ctl.so';
import { BackendManager } from '../BackendManager';
import { launchInProcessEarly } from '../BackendLauncher';

const TAG: string = 'luker.Index';
const DOMAIN: number = 0xE1EC;
const SERVER_URL: string = 'http://127.0.0.1:8000';
const BOOT_TIMEOUT_MS: number = 120_000;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State serverReady: boolean = false;
  @State statusMessage: string = 'Starting Luker …';

  aboutToAppear(): void {
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
      this.statusMessage = `Starting Luker … ${secs}s\nbackend: ${status}`;
      if (status.startsWith('failed:')) {
        this.statusMessage = `Engine failed: ${status}`;
        return;
      }
      await this.sleep(200);
    }
    this.statusMessage = 'Engine timeout';
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

      if (!this.serverReady) {
        Column({ space: 16 }) {
          Text('Luker').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#cfd6e4')
          LoadingProgress().width(36).height(36).color('#4aa3ff')
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
