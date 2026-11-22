/**
 * Pure colour and safe-area geometry helpers shared by SafeAreaManager and its
 * unit tests. Kept free of ArkUI / window imports so Hypium unit tests run on
 * the host without a device window.
 */

/** Background shared by the launch splash, loading overlay and crash screen. */
export const NATIVE_CHROME_BACKGROUND: string = '#15171a';

/** Initial page background before the web UI reports its active theme colour. */
export const DEFAULT_PAGE_BACKGROUND: string = NATIVE_CHROME_BACKGROUND;

export const SYSTEM_BAR_LIGHT_CONTENT: string = '#FFFFFF';
export const SYSTEM_BAR_DARK_CONTENT: string = '#000000';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface AvoidRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AvoidAreaSnapshot {
  visible: boolean;
  topRect: AvoidRect;
  bottomRect: AvoidRect;
  leftRect: AvoidRect;
  rightRect: AvoidRect;
}

export interface WindowSizePx {
  width: number;
  height: number;
}

export interface ResolvedSystemBarStyle {
  backgroundHex: string;
  contentColor: string;
  color: Rgba;
}

const HEX_BODY_PATTERN: RegExp = /^[0-9a-f]+$/;
const RGB_FUNC_PATTERN: RegExp = /^rgba?\(\s*([^)]+)\s*\)$/;
const NUMBER_WITH_OPTIONAL_PERCENT: RegExp = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(%?)$/;

function clampByte(value: number): number {
  if (!isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 255 ? 255 : Math.round(value);
}

function clampUnit(value: number): number {
  if (!isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

function parseHexColor(text: string): Rgba | null {
  const body: string = text.substring(1);
  if (!HEX_BODY_PATTERN.test(body)) {
    return null;
  }
  if (body.length === 3 || body.length === 4) {
    const r: number = parseInt(body.substring(0, 1) + body.substring(0, 1), 16);
    const g: number = parseInt(body.substring(1, 2) + body.substring(1, 2), 16);
    const b: number = parseInt(body.substring(2, 3) + body.substring(2, 3), 16);
    const a: number = body.length === 4
      ? parseInt(body.substring(3, 4) + body.substring(3, 4), 16) / 255
      : 1;
    return { r: r, g: g, b: b, a: a };
  }
  if (body.length === 6 || body.length === 8) {
    const r: number = parseInt(body.substring(0, 2), 16);
    const g: number = parseInt(body.substring(2, 4), 16);
    const b: number = parseInt(body.substring(4, 6), 16);
    const a: number = body.length === 8 ? parseInt(body.substring(6, 8), 16) / 255 : 1;
    return { r: r, g: g, b: b, a: a };
  }
  return null;
}

function parseRgbChannel(token: string): number | null {
  const match: RegExpExecArray | null = NUMBER_WITH_OPTIONAL_PERCENT.exec(token);
  if (match === null) {
    return null;
  }
  const isPercent: boolean = match[1] === '%';
  const raw: number = Number.parseFloat(isPercent ? token.substring(0, token.length - 1) : token);
  if (!isFinite(raw)) {
    return null;
  }
  return clampByte(isPercent ? (raw / 100) * 255 : raw);
}

function parseAlphaChannel(token: string): number | null {
  const match: RegExpExecArray | null = NUMBER_WITH_OPTIONAL_PERCENT.exec(token);
  if (match === null) {
    return null;
  }
  const isPercent: boolean = match[1] === '%';
  const raw: number = Number.parseFloat(isPercent ? token.substring(0, token.length - 1) : token);
  if (!isFinite(raw)) {
    return null;
  }
  return clampUnit(isPercent ? raw / 100 : raw);
}

function parseRgbColor(text: string): Rgba | null {
  const outer: RegExpExecArray | null = RGB_FUNC_PATTERN.exec(text);
  if (outer === null) {
    return null;
  }
  const body: string = outer[1].trim();
  if (body.length === 0) {
    return null;
  }

  let channelTokens: string[];
  let alphaToken: string | null = null;

  if (body.indexOf(',') >= 0) {
    // Legacy comma-separated form does not mix with '/'.
    if (body.indexOf('/') >= 0) {
      return null;
    }
    const parts: string[] = body.split(',').map((part: string) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) {
      return null;
    }
    channelTokens = [parts[0], parts[1], parts[2]];
    if (parts.length === 4) {
      alphaToken = parts[3];
    }
  } else {
    const slashParts: string[] = body.split('/');
    if (slashParts.length > 2) {
      return null;
    }
    channelTokens = slashParts[0].trim().split(/\s+/).filter((token: string) => token.length > 0);
    if (channelTokens.length !== 3) {
      return null;
    }
    if (slashParts.length === 2) {
      alphaToken = slashParts[1].trim();
      if (alphaToken.length === 0) {
        return null;
      }
    }
  }

  const r: number | null = parseRgbChannel(channelTokens[0]);
  const g: number | null = parseRgbChannel(channelTokens[1]);
  const b: number | null = parseRgbChannel(channelTokens[2]);
  if (r === null || g === null || b === null) {
    return null;
  }
  let a: number = 1;
  if (alphaToken !== null) {
    const parsedAlpha: number | null = parseAlphaChannel(alphaToken);
    if (parsedAlpha === null) {
      return null;
    }
    a = parsedAlpha;
  }
  return { r: r, g: g, b: b, a: a };
}

/**
 * Parses the colour strings a browser reports through getComputedStyle or CSS
 * custom properties (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`,
 * `rgba(...)`, and `'transparent'`).
 */
export function parseCssColor(input: string): Rgba | null {
  if (typeof input !== 'string') {
    return null;
  }
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

export function toHexColor(color: Rgba): string {
  const hex = (value: number): string => {
    const text: string = clampByte(value).toString(16);
    return text.length === 1 ? '0' + text : text;
  };
  return '#' + hex(color.r) + hex(color.g) + hex(color.b);
}

/** WCAG 2.1 relative luminance in linear sRGB space (range 0..1). */
export function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const srgb: number = clampByte(value) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Returns true when white system-bar icons provide higher WCAG contrast against
 * `background` than black icons:
 *   (1 + 0.05) / (L + 0.05) > (L + 0.05) / 0.05  <=>  (L + 0.05)^2 < 0.0525
 */
export function prefersLightSystemBarIcons(background: Rgba): boolean {
  const lum: number = relativeLuminance(background);
  return (lum + 0.05) * (lum + 0.05) < 1.05 * 0.05;
}

/**
 * Resolves a reported CSS background colour into an opaque strip colour and the
 * contrasting system-bar icon colour.
 *
 * Fully transparent colours (`a <= 0`) carry no page surface colour and return
 * null so the current strip colour is preserved. Translucent colours (`0 < a < 1`)
 * take their RGB channels directly (matching the Android and iOS shells) rather
 * than blending repeatedly over the previous strip colour, which would pollute
 * theme switches and drift across repeated reports.
 */
export function resolveSystemBarStyle(cssColor: string): ResolvedSystemBarStyle | null {
  const parsed: Rgba | null = parseCssColor(cssColor);
  if (parsed === null || parsed.a <= 0) {
    return null;
  }
  const opaque: Rgba = {
    r: clampByte(parsed.r),
    g: clampByte(parsed.g),
    b: clampByte(parsed.b),
    a: 1,
  };
  const contentColor: string = prefersLightSystemBarIcons(opaque)
    ? SYSTEM_BAR_LIGHT_CONTENT
    : SYSTEM_BAR_DARK_CONTENT;
  return {
    backgroundHex: toHexColor(opaque),
    contentColor: contentColor,
    color: opaque,
  };
}

function edgeInsetTop(rect: AvoidRect): number {
  if (rect.height <= 0) {
    return 0;
  }
  return Math.max(0, rect.top) + rect.height;
}

function edgeInsetLeft(rect: AvoidRect): number {
  if (rect.width <= 0) {
    return 0;
  }
  return Math.max(0, rect.left) + rect.width;
}

function edgeInsetBottom(rect: AvoidRect, windowSize: WindowSizePx | null): number {
  if (rect.height <= 0) {
    return 0;
  }
  if (windowSize !== null && windowSize.height > 0 && rect.top >= 0 && rect.top <= windowSize.height) {
    return Math.max(rect.height, windowSize.height - rect.top);
  }
  return rect.height;
}

function edgeInsetRight(rect: AvoidRect, windowSize: WindowSizePx | null): number {
  if (rect.width <= 0) {
    return 0;
  }
  if (windowSize !== null && windowSize.width > 0 && rect.left >= 0 && rect.left <= windowSize.width) {
    return Math.max(rect.width, windowSize.width - rect.left);
  }
  return rect.width;
}

/**
 * Computes four-edge window safe-area padding in vp.
 *
 * - When the window is not laid out full-screen, the system already insets the
 *   content view, so padding stays 0 to avoid double-insetting.
 * - `systemArea` and `indicatorArea` honour `visible` so hiding bars collapses
 *   their insets.
 * - `cutoutArea` represents physical screen cutouts; its `visible` flag is not
 *   meaningful on HarmonyOS, so non-zero rects are always inspected. In
 *   immersive mode only horizontal cutout edges (landscape camera notch) are
 *   kept so portrait immersive mode remains edge-to-edge vertically.
 */
export function computeSafeAreaInsets(
  isLayoutFullScreen: boolean,
  immersiveMode: boolean,
  systemArea: AvoidAreaSnapshot | null,
  indicatorArea: AvoidAreaSnapshot | null,
  cutoutArea: AvoidAreaSnapshot | null,
  windowSize: WindowSizePx | null,
  pxToVp: (px: number) => number,
): SafeAreaInsets {
  if (!isLayoutFullScreen) {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
  let topPx: number = 0;
  let bottomPx: number = 0;
  let leftPx: number = 0;
  let rightPx: number = 0;

  if (systemArea !== null && systemArea.visible) {
    topPx = Math.max(topPx, edgeInsetTop(systemArea.topRect));
    bottomPx = Math.max(bottomPx, edgeInsetBottom(systemArea.bottomRect, windowSize));
    leftPx = Math.max(leftPx, edgeInsetLeft(systemArea.leftRect));
    rightPx = Math.max(rightPx, edgeInsetRight(systemArea.rightRect, windowSize));
  }

  if (indicatorArea !== null && indicatorArea.visible) {
    bottomPx = Math.max(bottomPx, edgeInsetBottom(indicatorArea.bottomRect, windowSize));
  }

  if (cutoutArea !== null) {
    if (!immersiveMode) {
      topPx = Math.max(topPx, edgeInsetTop(cutoutArea.topRect));
      bottomPx = Math.max(bottomPx, edgeInsetBottom(cutoutArea.bottomRect, windowSize));
    }
    leftPx = Math.max(leftPx, edgeInsetLeft(cutoutArea.leftRect));
    rightPx = Math.max(rightPx, edgeInsetRight(cutoutArea.rightRect, windowSize));
  }

  return {
    top: topPx > 0 ? Math.max(0, pxToVp(topPx)) : 0,
    bottom: bottomPx > 0 ? Math.max(0, pxToVp(bottomPx)) : 0,
    left: leftPx > 0 ? Math.max(0, pxToVp(leftPx)) : 0,
    right: rightPx > 0 ? Math.max(0, pxToVp(rightPx)) : 0,
  };
}
