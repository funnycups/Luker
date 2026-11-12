import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'luker.immersive';
const DOMAIN: number = 0xE1EC;

/**
 * Native immersive mode for HarmonyOS: takes the main window into full layout
 * and hides the system bars. The frontend routes the immersive toggle here
 * instead of the web Fullscreen API, which is what lets the back key tell a
 * user immersive apart from a page-requested fullscreen.
 */
export class ImmersiveManager {
  private static mainWindow: window.Window | undefined = undefined;

  static attach(mainWindow: window.Window): void {
    ImmersiveManager.mainWindow = mainWindow;
  }

  static setEnabled(enabled: boolean): void {
    const mainWindow: window.Window | undefined = ImmersiveManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    mainWindow.setWindowLayoutFullScreen(enabled).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(err));
    });
    mainWindow.setWindowSystemBarEnable(enabled ? [] : ['status', 'navigation']).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setWindowSystemBarEnable failed: %{public}s', JSON.stringify(err));
    });
  }

  static setKeepScreenOn(keepScreenOn: boolean): void {
    const mainWindow: window.Window | undefined = ImmersiveManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    mainWindow.setWindowKeepScreenOn(keepScreenOn).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setWindowKeepScreenOn failed: %{public}s', JSON.stringify(err));
    });
  }
}
