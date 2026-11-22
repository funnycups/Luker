import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SafeAreaManager } from './SafeAreaManager';

const TAG: string = 'luker.immersive';
const DOMAIN: number = 0xE1EC;

/**
 * Native immersive mode for HarmonyOS: the window always lays out edge to edge
 * (SafeAreaManager owns that), so immersive mode only hides the system bars
 * and bottom navigation indicator. The frontend routes the immersive toggle
 * here instead of the web Fullscreen API, which is what lets the back key tell
 * a user immersive apart from a page-requested fullscreen.
 */
export class ImmersiveManager {
  private static mainWindow: window.Window | undefined = undefined;

  static attach(mainWindow: window.Window): void {
    ImmersiveManager.mainWindow = mainWindow;
  }

  static detach(): void {
    ImmersiveManager.mainWindow = undefined;
  }

  static setEnabled(enabled: boolean): void {
    const mainWindow: window.Window | undefined = ImmersiveManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    // The layout stays full screen either way: when the bars come back the page
    // keeps painting the theme colour behind them instead of showing a system
    // coloured strip.
    mainWindow.setWindowLayoutFullScreen(true).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(err));
    });
    mainWindow.setWindowSystemBarEnable(enabled ? [] : ['status', 'navigation']).then(() => {
      SafeAreaManager.setImmersiveMode(enabled);
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setWindowSystemBarEnable failed: %{public}s', JSON.stringify(err));
      SafeAreaManager.setImmersiveMode(enabled);
    });
    mainWindow.setSpecificSystemBarEnabled('navigationIndicator', !enabled).then(() => {
      SafeAreaManager.refresh();
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'setSpecificSystemBarEnabled(navigationIndicator) failed: %{public}s',
        JSON.stringify(err));
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
