import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { common, UIAbility } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BackendManager } from '../BackendManager';
import { launchInProcessEarly, prepareDataDir } from '../BackendLauncher';
import { LastExit, recordLastExit } from '../crash/LastExit';

const TAG: string = 'LukerEntryAbility';
const DOMAIN: number = 0xE1EC;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
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
    launchInProcessEarly(this.context as common.UIAbilityContext);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }

  onDestroy(): void {
    BackendManager.killBackend();
  }
}
