import { window, display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  AvoidAreaSnapshot,
  DEFAULT_PAGE_BACKGROUND,
  NATIVE_CHROME_BACKGROUND,
  ResolvedSystemBarStyle,
  Rgba,
  SafeAreaInsets,
  WindowSizePx,
  computeSafeAreaInsets,
  parseCssColor,
  resolveSystemBarStyle,
} from './SafeAreaPolicy';

export { DEFAULT_PAGE_BACKGROUND, NATIVE_CHROME_BACKGROUND, Rgba, parseCssColor };

const TAG: string = 'luker.safearea';
const DOMAIN: number = 0xE1EC;

/** AppStorage keys shared between the ability, this manager and the page. */
export const STORAGE_SAFE_TOP: string = 'luker.safeTop';
export const STORAGE_SAFE_BOTTOM: string = 'luker.safeBottom';
export const STORAGE_SAFE_LEFT: string = 'luker.safeLeft';
export const STORAGE_SAFE_RIGHT: string = 'luker.safeRight';
export const STORAGE_PAGE_BACKGROUND: string = 'luker.pageBackground';

/**
 * Injected into app-origin pages so the strips behind the system bars follow
 * the active theme across initial async settings load, theme switches and
 * custom CSS updates. Coalesces rapid mutations on a 120 ms trailing window.
 */
export const PAGE_THEME_REPORTER: string =
  '(function(){' +
  'if(window.__lukerPageThemeHook){window.__lukerPageThemeReport();return;}' +
  'window.__lukerPageThemeHook=true;' +
  'var pending=false;' +
  'function isTransparent(c){return !c||c==="rgba(0, 0, 0, 0)"||c==="transparent";}' +
  'function isStyleNode(n){if(!n||n.nodeType!==1){return false;}var t=n.tagName;return t==="STYLE"||t==="LINK";}' +
  'function headMutationAffectsStyle(list){' +
  'for(var i=0;i<list.length;i++){' +
  'var m=list[i];' +
  'var tgt=m.target;' +
  'if(isStyleNode(tgt)||(tgt&&isStyleNode(tgt.parentNode))){return true;}' +
  'for(var j=0;j<m.addedNodes.length;j++){if(isStyleNode(m.addedNodes[j])){return true;}}' +
  'for(var k=0;k<m.removedNodes.length;k++){if(isStyleNode(m.removedNodes[k])){return true;}}' +
  '}' +
  'return false;' +
  '}' +
  'window.__lukerPageThemeReport=function(){' +
  'if(pending){return;}pending=true;' +
  'setTimeout(function(){pending=false;' +
  'try{' +
  'var bridge=window.LukerHarmony;' +
  'if(!bridge||!bridge.setPageBackgroundColor){return;}' +
  'var el=document.body||document.documentElement;' +
  'var bg=el?getComputedStyle(el).backgroundColor:"";' +
  'if(isTransparent(bg)&&document.documentElement){bg=getComputedStyle(document.documentElement).backgroundColor;}' +
  'if(isTransparent(bg)&&el){' +
  'var tint=(getComputedStyle(el).getPropertyValue("--SmartThemeBlurTintColor")||"").trim();' +
  'if(tint){bg=tint;}' +
  '}' +
  'bridge.setPageBackgroundColor(String(bg||""));' +
  '}catch(e){}' +
  '},120);' +
  '};' +
  'window.__lukerPageThemeReport();' +
  'setTimeout(window.__lukerPageThemeReport,400);' +
  'setTimeout(window.__lukerPageThemeReport,1500);' +
  'try{document.addEventListener("DOMContentLoaded",window.__lukerPageThemeReport);}catch(e){}' +
  'try{' +
  'var attrMo=new MutationObserver(window.__lukerPageThemeReport);' +
  'if(document.body){attrMo.observe(document.body,{attributes:true,attributeFilter:["class","style"]});}' +
  'if(document.documentElement){attrMo.observe(document.documentElement,{attributes:true,attributeFilter:["class","style"]});}' +
  'if(document.head){' +
  'var headMo=new MutationObserver(function(list){if(headMutationAffectsStyle(list)){window.__lukerPageThemeReport();}});' +
  'headMo.observe(document.head,{childList:true,subtree:true,characterData:true});' +
  '}' +
  '}catch(e){}' +
  'try{window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",window.__lukerPageThemeReport);}catch(e){}' +
  '})();';

function toAvoidAreaSnapshot(area: window.AvoidArea): AvoidAreaSnapshot {
  return {
    visible: area.visible,
    topRect: {
      left: area.topRect.left,
      top: area.topRect.top,
      width: area.topRect.width,
      height: area.topRect.height,
    },
    bottomRect: {
      left: area.bottomRect.left,
      top: area.bottomRect.top,
      width: area.bottomRect.width,
      height: area.bottomRect.height,
    },
    leftRect: {
      left: area.leftRect.left,
      top: area.leftRect.top,
      width: area.leftRect.width,
      height: area.leftRect.height,
    },
    rightRect: {
      left: area.rightRect.left,
      top: area.rightRect.top,
      width: area.rightRect.width,
      height: area.rightRect.height,
    },
  };
}

/**
 * Keeps the window edge to edge and tells ArkUI how much of each edge belongs
 * to the system bars and cutouts, so the page can paint the theme colour there
 * while its own content stays clear of them.
 */
export class SafeAreaManager {
  private static mainWindow: window.Window | undefined = undefined;
  private static layoutFullScreen: boolean = false;
  private static immersiveMode: boolean = false;
  private static appliedBackground: string = '';
  private static avoidAreaListener: ((options: window.AvoidAreaOptions) => void) | undefined = undefined;
  private static windowSizeListener: (() => void) | undefined = undefined;

  static attach(mainWindow: window.Window): void {
    if (SafeAreaManager.mainWindow !== undefined) {
      SafeAreaManager.detach();
    }
    SafeAreaManager.mainWindow = mainWindow;
    SafeAreaManager.layoutFullScreen = false;
    SafeAreaManager.appliedBackground = '';
    SafeAreaManager.installListeners(mainWindow);
    SafeAreaManager.applyCurrentStyle();

    mainWindow.setWindowLayoutFullScreen(true).then(() => {
      if (SafeAreaManager.mainWindow !== mainWindow) {
        return;
      }
      SafeAreaManager.layoutFullScreen = true;
      SafeAreaManager.publishInsets();
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}d %{public}s', err.code, err.message);
      if (SafeAreaManager.mainWindow === mainWindow) {
        SafeAreaManager.layoutFullScreen = false;
        SafeAreaManager.publishInsets();
      }
    });
  }

  static detach(): void {
    const mainWindow: window.Window | undefined = SafeAreaManager.mainWindow;
    const avoidListener = SafeAreaManager.avoidAreaListener;
    const sizeListener = SafeAreaManager.windowSizeListener;
    SafeAreaManager.mainWindow = undefined;
    SafeAreaManager.avoidAreaListener = undefined;
    SafeAreaManager.windowSizeListener = undefined;
    SafeAreaManager.layoutFullScreen = false;
    SafeAreaManager.appliedBackground = '';
    if (mainWindow === undefined) {
      return;
    }
    if (avoidListener !== undefined) {
      try {
        mainWindow.off('avoidAreaChange', avoidListener);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'avoidAreaChange unsubscribe failed: %{public}s', JSON.stringify(e));
      }
    }
    if (sizeListener !== undefined) {
      try {
        mainWindow.off('windowSizeChange', sizeListener);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'windowSizeChange unsubscribe failed: %{public}s', JSON.stringify(e));
      }
    }
  }

  static refresh(): void {
    SafeAreaManager.publishInsets();
  }

  static setImmersiveMode(enabled: boolean): void {
    SafeAreaManager.immersiveMode = enabled;
    if (!enabled) {
      SafeAreaManager.reapplySystemBarColors();
    }
    SafeAreaManager.publishInsets();
  }

  static reapplySystemBarColors(): void {
    SafeAreaManager.appliedBackground = '';
    SafeAreaManager.applyCurrentStyle();
  }

  /** Restores the strip and bar icons to the native splash/error chrome colour. */
  static resetToNativeChrome(): void {
    SafeAreaManager.setPageBackground(NATIVE_CHROME_BACKGROUND);
  }

  private static installListeners(mainWindow: window.Window): void {
    const avoidListener = (options: window.AvoidAreaOptions): void => {
      if (options.type === window.AvoidAreaType.TYPE_SYSTEM
        || options.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR
        || options.type === window.AvoidAreaType.TYPE_CUTOUT) {
        SafeAreaManager.publishInsets();
      }
    };
    try {
      mainWindow.on('avoidAreaChange', avoidListener);
      SafeAreaManager.avoidAreaListener = avoidListener;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'avoidAreaChange subscribe failed: %{public}s', JSON.stringify(e));
    }

    const sizeListener = (): void => {
      SafeAreaManager.publishInsets();
    };
    try {
      mainWindow.on('windowSizeChange', sizeListener);
      SafeAreaManager.windowSizeListener = sizeListener;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'windowSizeChange subscribe failed: %{public}s', JSON.stringify(e));
    }
  }

  private static resolvePxToVp(mainWindow: window.Window): ((px: number) => number) | null {
    try {
      const uiContext = mainWindow.getUIContext();
      return (px: number): number => uiContext.px2vp(px);
    } catch (uiErr) {
      // UIContext is unavailable until loadContent finishes; use the display
      // backing this window rather than assuming density = 1.
    }
    try {
      const displayId: number | undefined = mainWindow.getWindowProperties().displayId;
      const screen: display.Display = displayId !== undefined
        ? display.getDisplayByIdSync(displayId)
        : display.getDefaultDisplaySync();
      const density: number = screen.densityPixels;
      if (density > 0) {
        return (px: number): number => px / density;
      }
      hilog.error(DOMAIN, TAG, 'invalid display density: %{public}f', density);
    } catch (displayErr) {
      hilog.error(DOMAIN, TAG, 'resolve display density failed: %{public}s', JSON.stringify(displayErr));
    }
    return null;
  }

  private static readAvoidArea(
    mainWindow: window.Window,
    type: window.AvoidAreaType,
    label: string,
  ): AvoidAreaSnapshot | null {
    try {
      return toAvoidAreaSnapshot(mainWindow.getWindowAvoidArea(type));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getWindowAvoidArea(%{public}s) failed: %{public}s', label, JSON.stringify(e));
      return null;
    }
  }

  private static readWindowSize(mainWindow: window.Window): WindowSizePx | null {
    try {
      const rect = mainWindow.getWindowProperties().windowRect;
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width, height: rect.height };
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getWindowProperties failed: %{public}s', JSON.stringify(e));
    }
    return null;
  }

  /**
   * Publishes four-edge avoid insets in vp. When full-screen layout has not
   * taken effect, insets stay 0 so ArkUI does not double-pad the content.
   */
  static publishInsets(): void {
    const mainWindow: window.Window | undefined = SafeAreaManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    if (!SafeAreaManager.layoutFullScreen) {
      SafeAreaManager.writeInsets({ top: 0, bottom: 0, left: 0, right: 0 });
      return;
    }
    const pxToVp: ((px: number) => number) | null = SafeAreaManager.resolvePxToVp(mainWindow);
    if (pxToVp === null) {
      return;
    }
    const systemArea: AvoidAreaSnapshot | null =
      SafeAreaManager.readAvoidArea(mainWindow, window.AvoidAreaType.TYPE_SYSTEM, 'TYPE_SYSTEM');
    const indicatorArea: AvoidAreaSnapshot | null = SafeAreaManager.readAvoidArea(
      mainWindow, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR, 'TYPE_NAVIGATION_INDICATOR');
    const cutoutArea: AvoidAreaSnapshot | null =
      SafeAreaManager.readAvoidArea(mainWindow, window.AvoidAreaType.TYPE_CUTOUT, 'TYPE_CUTOUT');
    const windowSize: WindowSizePx | null = SafeAreaManager.readWindowSize(mainWindow);
    const insets: SafeAreaInsets = computeSafeAreaInsets(
      SafeAreaManager.layoutFullScreen,
      SafeAreaManager.immersiveMode,
      systemArea,
      indicatorArea,
      cutoutArea,
      windowSize,
      pxToVp,
    );
    SafeAreaManager.writeInsets(insets);
  }

  private static writeInsets(insets: SafeAreaInsets): void {
    AppStorage.setOrCreate(STORAGE_SAFE_TOP, insets.top);
    AppStorage.setOrCreate(STORAGE_SAFE_BOTTOM, insets.bottom);
    AppStorage.setOrCreate(STORAGE_SAFE_LEFT, insets.left);
    AppStorage.setOrCreate(STORAGE_SAFE_RIGHT, insets.right);
  }

  /**
   * Called from the page with the background it is actually rendering. The
   * reported colour fills the system bar strips and decides whether the bar
   * icons have to be light or dark, so the whole window follows the theme.
   */
  static setPageBackground(cssColor: string): void {
    const resolved: ResolvedSystemBarStyle | null = resolveSystemBarStyle(cssColor);
    if (resolved === null) {
      return;
    }
    SafeAreaManager.applyResolvedStyle(resolved);
  }

  private static applyCurrentStyle(): void {
    const resolved: ResolvedSystemBarStyle | null =
      resolveSystemBarStyle(SafeAreaManager.currentBackground())
        ?? resolveSystemBarStyle(DEFAULT_PAGE_BACKGROUND);
    if (resolved !== null) {
      SafeAreaManager.applyResolvedStyle(resolved);
    }
  }

  private static applyResolvedStyle(style: ResolvedSystemBarStyle): void {
    if (style.backgroundHex === SafeAreaManager.appliedBackground) {
      return;
    }
    SafeAreaManager.appliedBackground = style.backgroundHex;
    AppStorage.setOrCreate(STORAGE_PAGE_BACKGROUND, style.backgroundHex);
    SafeAreaManager.applySystemBarColors(style.contentColor);
  }

  private static currentBackground(): string {
    const stored: string | undefined = AppStorage.get<string>(STORAGE_PAGE_BACKGROUND);
    return stored ?? DEFAULT_PAGE_BACKGROUND;
  }

  private static applySystemBarColors(contentColor: string): void {
    const mainWindow: window.Window | undefined = SafeAreaManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    const properties: window.SystemBarProperties = {
      statusBarColor: '#00000000',
      navigationBarColor: '#00000000',
      statusBarContentColor: contentColor,
      navigationBarContentColor: contentColor,
    };
    try {
      mainWindow.setWindowSystemBarProperties(properties).catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'setWindowSystemBarProperties failed: %{public}d %{public}s',
          err.code, err.message);
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'setWindowSystemBarProperties threw: %{public}s', JSON.stringify(e));
    }
  }
}
