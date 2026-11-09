import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { common, UIAbility } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BackendManager } from '../BackendManager';
import { ImmersiveManager } from '../ImmersiveManager';
import { KeepAliveManager } from '../KeepAliveManager';
import { launchInProcessEarly, prepareDataDir } from '../BackendLauncher';
import { LastExit, recordLastExit } from '../crash/LastExit';
import { AppConfig } from '../AppConfig';
import { HttpAuthStore } from '../HttpAuthStore';
import { RuntimeNotification } from '../RuntimeNotification';
import {
  ACTION_OPEN_ENDPOINT_SETTINGS,
  ACTION_RELOAD_WEBVIEW,
  STORAGE_CUSTOM_ENDPOINT,
  STORAGE_PENDING_ACTION,
  STORAGE_SERVER_URL,
} from '../AppActions';

const TAG: string = 'LukerEntryAbility';
const DOMAIN: number = 0xE1EC;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    KeepAliveManager.attach(this.context);
    AppConfig.attach(this.context);
    HttpAuthStore.attach(this.context);
    RuntimeNotification.attach(this.context);
    const customEndpoint: boolean = AppConfig.usesCustomEndpoint();
    AppStorage.setOrCreate(STORAGE_SERVER_URL, AppConfig.resolveBaseUrl());
    AppStorage.setOrCreate(STORAGE_CUSTOM_ENDPOINT, customEndpoint);
    this.applyWantAction(want);
    // The debug switch is process-wide and only covers renderer processes
    // created after it is set, so it has to be armed before the page loads.
    try {
      webview.WebviewController.setWebDebuggingAccess(true);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'setWebDebuggingAccess failed: %{public}s', JSON.stringify(e));
    }
    let abnormalExit: boolean = false;
    try {
      abnormalExit = recordLastExit(this.context.filesDir, launchParam);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'recordLastExit failed: %{public}s', JSON.stringify(e));
    }
    if (abnormalExit) {
      // The previous run crashed. Hold the backend until the crash dialog is
      // handled: a crash that recurs within seconds would otherwise kill the
      // process before the dialog can export the crashed run's logs.
      hilog.warn(DOMAIN, TAG, 'previous exit abnormal (%{public}d); backend deferred',
        launchParam.lastExitReason);
      LastExit.deferBackend = true;
      prepareDataDir(this.context);
      return;
    }
    if (customEndpoint) {
      hilog.info(DOMAIN, TAG, 'custom endpoint configured; local backend skipped');
      return;
    }
    launchInProcessEarly(this.context as common.UIAbilityContext);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.applyWantAction(want);
  }

  private applyWantAction(want: Want): void {
    const action: string = want.action ?? '';
    if (action === ACTION_OPEN_ENDPOINT_SETTINGS || action === ACTION_RELOAD_WEBVIEW) {
      AppStorage.setOrCreate(STORAGE_PENDING_ACTION, action);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      ImmersiveManager.attach(windowStage.getMainWindowSync());
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'attach immersive window failed: %{public}s', JSON.stringify(e));
    }
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }

  onForeground(): void {
    KeepAliveManager.setInBackground(false);
    RuntimeNotification.setForeground(true);
  }

  onBackground(): void {
    KeepAliveManager.setInBackground(true);
    RuntimeNotification.setForeground(false);
  }

  onDestroy(): void {
    RuntimeNotification.exit();
    KeepAliveManager.release();
    BackendManager.killBackend();
  }
}
