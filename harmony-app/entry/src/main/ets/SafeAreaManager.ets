import { window, display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'luker.safearea';
const DOMAIN: number = 0xE1EC;

/** AppStorage keys shared between the ability, this manager and the page. */
export const STORAGE_SAFE_TOP: string = 'luker.safeTop';
export const STORAGE_SAFE_BOTTOM: string = 'luker.safeBottom';
export const STORAGE_PAGE_BACKGROUND: string = 'luker.pageBackground';

/** SillyTavern's default dark background (--SmartThemeBlurTintColor). */
export const DEFAULT_PAGE_BACKGROUND: string = '#171717';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clampByte(value: number): number {
  if (value < 0) {
    return 0;
  }
  return value > 255 ? 255 : Math.round(value);
}

function parseHexColor(text: string): Rgba | null {
  const body: string = text.substring(1);
  if (body.length === 3) {
    const r: number = parseInt(body.substring(0, 1) + body.substring(0, 1), 16);
    const g: number = parseInt(body.substring(1, 2) + body.substring(1, 2), 16);
    const b: number = parseInt(body.substring(2, 3) + body.substring(2, 3), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) {
      return null;
    }
    return { r: r, g: g, b: b, a: 1 };
  }
  if (body.length === 6 || body.length === 8) {
    const r: number = parseInt(body.substring(0, 2), 16);
    const g: number = parseInt(body.substring(2, 4), 16);
    const b: number = parseInt(body.substring(4, 6), 16);
    const a: number = body.length === 8 ? parseInt(body.substring(6, 8), 16) / 255 : 1;
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) {
      return null;
    }
    return { r: r, g: g, b: b, a: a };
  }
  return null;
}

function parseRgbColor(text: string): Rgba | null {
  const numbers: string[] | null = text.match(/-?[0-9]*\.?[0-9]+/g);
  if (numbers === null || numbers.length < 3) {
    return null;
  }
  const r: number = Number.parseFloat(numbers[0]);
  const g: number = Number.parseFloat(numbers[1]);
  const b: number = Number.parseFloat(numbers[2]);
  let a: number = 1;
  if (numbers.length >= 4) {
    a = Number.parseFloat(numbers[3]);
  }
  // The modern space separated form may carry the alpha as a percentage.
  if (text.indexOf('%') >= 0 && numbers.length >= 4) {
    a = Number.parseFloat(numbers[3]) / 100;
  }
  if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) {
    return null;
  }
  return { r: r, g: g, b: b, a: Math.max(0, Math.min(1, a)) };
}

/**
 * Parses the colour strings a browser reports through getComputedStyle, so the
 * window background can follow whatever theme the page is actually rendering.
 */
export function parseCssColor(input: string): Rgba | null {
  const text: string = input.trim().toLowerCase();
  if (text.length === 0) {
    return null;
  }
  if (text === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (text.startsWith('#')) {
    return parseHexColor(text);
  }
  if (text.startsWith('rgb')) {
    return parseRgbColor(text);
  }
  return null;
}

function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const alpha: number = top.a + bottom.a * (1 - top.a);
  if (alpha <= 0) {
    return { r: bottom.r, g: bottom.g, b: bottom.b, a: 1 };
  }
  return {
    r: clampByte((top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha),
    g: clampByte((top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha),
    b: clampByte((top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha),
    a: 1,
  };
}

function toHexColor(color: Rgba): string {
  const hex = (value: number): string => {
    const text: string = clampByte(value).toString(16);
    return text.length === 1 ? '0' + text : text;
  };
  return '#' + hex(color.r) + hex(color.g) + hex(color.b);
}

function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const srgb: number = clampByte(value) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Runs on every page load and again whenever the page restyles itself, so the
 * strip the window paints behind the system bars always matches the theme the
 * web UI is currently showing.
 */
export const PAGE_THEME_REPORTER: string =
  '(function(){' +
  'if(window.__lukerPageThemeHook){window.__lukerPageThemeReport();return;}' +
  'window.__lukerPageThemeHook=true;' +
  'var pending=false;' +
  'window.__lukerPageThemeReport=function(){' +
  'if(pending){return;}pending=true;' +
  'setTimeout(function(){pending=false;' +
  'try{' +
  'var el=document.body||document.documentElement;' +
  'var bg=el?getComputedStyle(el).backgroundColor:"";' +
  'if(!bg||bg==="rgba(0, 0, 0, 0)"||bg==="transparent"){bg=getComputedStyle(document.documentElement).backgroundColor;}' +
  'var root=getComputedStyle(document.body||document.documentElement);' +
  'var tint=(root.getPropertyValue("--SmartThemeBlurTintColor")||"").trim();' +
  'var bridge=window.LukerHarmony;' +
  'if(bridge&&bridge.setPageBackgroundColor){' +
  'if((!bg||bg==="rgba(0, 0, 0, 0)"||bg==="transparent")&&tint){bg=tint;}' +
  'bridge.setPageBackgroundColor(String(bg||""));' +
  '}' +
  '}catch(e){}' +
  '},120);' +
  '};' +
  'window.__lukerPageThemeReport();' +
  'setTimeout(window.__lukerPageThemeReport,400);' +
  'setTimeout(window.__lukerPageThemeReport,1500);' +
  'try{document.addEventListener("DOMContentLoaded",window.__lukerPageThemeReport);}catch(e){}' +
  'try{' +
  'var mo=new MutationObserver(window.__lukerPageThemeReport);' +
  'if(document.body){mo.observe(document.body,{attributes:true,attributeFilter:["class","style"]});}' +
  'mo.observe(document.documentElement,{attributes:true,attributeFilter:["class","style"]});' +
  'if(document.head){mo.observe(document.head,{childList:true,subtree:true,characterData:true});}' +
  '}catch(e){}' +
  'try{window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",window.__lukerPageThemeReport);}catch(e){}' +
  '})();';

/**
 * Keeps the window edge to edge and tells ArkUI how much of the top and bottom
 * belongs to the system bars, so the page can paint the theme colour there
 * while its own content stays clear of the status bar and the navigation bar.
 */
export class SafeAreaManager {
  private static mainWindow: window.Window | undefined = undefined;
  private static listening: boolean = false;
  private static appliedBackground: string = '';

  static attach(mainWindow: window.Window): void {
    SafeAreaManager.mainWindow = mainWindow;
    mainWindow.setWindowLayoutFullScreen(true).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}d %{public}s', err.code, err.message);
    });
    SafeAreaManager.applySystemBarColors({ r: 23, g: 23, b: 23, a: 1 });
    if (!SafeAreaManager.listening) {
      SafeAreaManager.listening = true;
      try {
        mainWindow.on('avoidAreaChange', () => {
          SafeAreaManager.publishInsets();
        });
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'avoidAreaChange subscribe failed: %{public}s', JSON.stringify(e));
      }
      try {
        mainWindow.on('windowSizeChange', () => {
          SafeAreaManager.publishInsets();
        });
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'windowSizeChange subscribe failed: %{public}s', JSON.stringify(e));
      }
    }
    SafeAreaManager.publishInsets();
  }

  static refresh(): void {
    SafeAreaManager.publishInsets();
  }

  /**
   * Publishes the system bar heights in vp. Immersive mode hides the bars and
   * the insets collapse to zero, which is exactly what a full screen page needs.
   */
  static publishInsets(): void {
    const mainWindow: window.Window | undefined = SafeAreaManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    let density: number = 1;
    try {
      density = display.getDefaultDisplaySync().densityPixels;
    } catch (e) {
      density = 1;
    }
    if (density <= 0) {
      density = 1;
    }
    let topPx: number = 0;
    let bottomPx: number = 0;
    try {
      const systemArea: window.AvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      if (systemArea.visible) {
        topPx = systemArea.topRect.height;
        bottomPx = systemArea.bottomRect.height;
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getWindowAvoidArea(TYPE_SYSTEM) failed: %{public}s', JSON.stringify(e));
    }
    try {
      const indicatorArea: window.AvoidArea =
        mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      if (indicatorArea.visible && indicatorArea.bottomRect.height > bottomPx) {
        bottomPx = indicatorArea.bottomRect.height;
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getWindowAvoidArea(TYPE_NAVIGATION_INDICATOR) failed: %{public}s', JSON.stringify(e));
    }
    const topVp: number = topPx > 0 ? topPx / density : 0;
    const bottomVp: number = bottomPx > 0 ? bottomPx / density : 0;
    AppStorage.setOrCreate(STORAGE_SAFE_TOP, topVp);
    AppStorage.setOrCreate(STORAGE_SAFE_BOTTOM, bottomVp);
  }

  /**
   * Called from the page with the background it is actually rendering. The
   * reported colour fills the system bar strips and decides whether the bar
   * icons have to be light or dark, so the whole window follows the theme.
   */
  static setPageBackground(cssColor: string): void {
    const parsed: Rgba | null = parseCssColor(cssColor);
    if (parsed === null) {
      return;
    }
    const base: Rgba = parseCssColor(SafeAreaManager.currentBackground()) ?? { r: 23, g: 23, b: 23, a: 1 };
    const opaque: Rgba = parsed.a >= 1 ? parsed : compositeOver(parsed, base);
    const hex: string = toHexColor(opaque);
    if (hex === SafeAreaManager.appliedBackground) {
      return;
    }
    SafeAreaManager.appliedBackground = hex;
    AppStorage.setOrCreate(STORAGE_PAGE_BACKGROUND, hex);
    SafeAreaManager.applySystemBarColors(opaque);
  }

  private static currentBackground(): string {
    const stored: string | undefined = AppStorage.get<string>(STORAGE_PAGE_BACKGROUND);
    return stored ?? DEFAULT_PAGE_BACKGROUND;
  }

  private static applySystemBarColors(background: Rgba): void {
    const mainWindow: window.Window | undefined = SafeAreaManager.mainWindow;
    if (mainWindow === undefined) {
      return;
    }
    const dark: boolean = relativeLuminance(background) < 0.5;
    const contentColor: string = dark ? '#FFFFFF' : '#000000';
    const properties: window.SystemBarProperties = {
      statusBarColor: '#00000000',
      navigationBarColor: '#00000000',
      statusBarContentColor: contentColor,
      navigationBarContentColor: contentColor,
      isStatusBarLightIcon: dark,
      isNavigationBarLightIcon: dark,
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
