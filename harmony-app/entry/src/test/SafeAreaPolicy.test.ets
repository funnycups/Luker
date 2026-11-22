import { describe, it, expect } from '@ohos/hypium';
import {
  AvoidAreaSnapshot,
  AvoidRect,
  NATIVE_CHROME_BACKGROUND,
  SYSTEM_BAR_DARK_CONTENT,
  SYSTEM_BAR_LIGHT_CONTENT,
  computeSafeAreaInsets,
  parseCssColor,
  prefersLightSystemBarIcons,
  resolveSystemBarStyle,
} from '../main/ets/SafeAreaPolicy';

const ZERO_RECT: AvoidRect = { left: 0, top: 0, width: 0, height: 0 };

function makeArea(
  visible: boolean,
  topRect: AvoidRect = ZERO_RECT,
  bottomRect: AvoidRect = ZERO_RECT,
  leftRect: AvoidRect = ZERO_RECT,
  rightRect: AvoidRect = ZERO_RECT,
): AvoidAreaSnapshot {
  return {
    visible: visible,
    topRect: topRect,
    bottomRect: bottomRect,
    leftRect: leftRect,
    rightRect: rightRect,
  };
}

export default function safeAreaPolicyTest(): void {
  describe('SafeAreaPolicy', () => {
    it('parses 3, 4, 6 and 8 digit hex colours and rejects malformed hex', 0, () => {
      const c3 = parseCssColor('#abc');
      expect(c3 !== null).assertTrue();
      expect(c3!.r).assertEqual(0xaa);
      expect(c3!.g).assertEqual(0xbb);
      expect(c3!.b).assertEqual(0xcc);
      expect(c3!.a).assertEqual(1);

      const c4 = parseCssColor('#0f88');
      expect(c4 !== null).assertTrue();
      expect(c4!.r).assertEqual(0x00);
      expect(c4!.g).assertEqual(0xff);
      expect(c4!.b).assertEqual(0x88);
      expect(Math.abs(c4!.a - (0x88 / 255)) < 0.001).assertTrue();

      const c6 = parseCssColor('  #172437 ');
      expect(c6 !== null).assertTrue();
      expect(c6!.r).assertEqual(0x17);
      expect(c6!.g).assertEqual(0x24);
      expect(c6!.b).assertEqual(0x37);
      expect(c6!.a).assertEqual(1);

      const c8 = parseCssColor('#171e2180');
      expect(c8 !== null).assertTrue();
      expect(c8!.r).assertEqual(0x17);
      expect(c8!.g).assertEqual(0x1e);
      expect(c8!.b).assertEqual(0x21);
      expect(Math.abs(c8!.a - (0x80 / 255)) < 0.001).assertTrue();

      expect(parseCssColor('#1z2z3z')).assertNull();
      expect(parseCssColor('#12')).assertNull();
      expect(parseCssColor('#12345')).assertNull();
      expect(parseCssColor('#1234567')).assertNull();
      expect(parseCssColor('#123456789')).assertNull();
    });

    it('parses legacy comma and modern space rgb/rgba including percentage channels', 0, () => {
      const legacy = parseCssColor('rgba(23, 30, 33, 0.61)');
      expect(legacy !== null).assertTrue();
      expect(legacy!.r).assertEqual(23);
      expect(legacy!.g).assertEqual(30);
      expect(legacy!.b).assertEqual(33);
      expect(Math.abs(legacy!.a - 0.61) < 0.0001).assertTrue();

      const pctRgb = parseCssColor('rgb(100%, 50%, 0%)');
      expect(pctRgb !== null).assertTrue();
      expect(pctRgb!.r).assertEqual(255);
      expect(pctRgb!.g).assertEqual(128);
      expect(pctRgb!.b).assertEqual(0);
      expect(pctRgb!.a).assertEqual(1);

      // Percentage RGB channels must not divide a decimal alpha by 100.
      const mixedSpace = parseCssColor('rgb(100% 0% 0% / 0.5)');
      expect(mixedSpace !== null).assertTrue();
      expect(mixedSpace!.r).assertEqual(255);
      expect(mixedSpace!.g).assertEqual(0);
      expect(mixedSpace!.b).assertEqual(0);
      expect(Math.abs(mixedSpace!.a - 0.5) < 0.0001).assertTrue();

      const pctAlpha = parseCssColor('rgb(23 30 33 / 61%)');
      expect(pctAlpha !== null).assertTrue();
      expect(pctAlpha!.r).assertEqual(23);
      expect(pctAlpha!.g).assertEqual(30);
      expect(pctAlpha!.b).assertEqual(33);
      expect(Math.abs(pctAlpha!.a - 0.61) < 0.0001).assertTrue();

      const transparent = parseCssColor('transparent');
      expect(transparent !== null).assertTrue();
      expect(transparent!.a).assertEqual(0);
    });

    it('rejects malformed rgb strings and empty inputs', 0, () => {
      expect(parseCssColor('')).assertNull();
      expect(parseCssColor('   ')).assertNull();
      expect(parseCssColor('rgbfoo(1, 2, 3)')).assertNull();
      expect(parseCssColor('rgb(10, 20)')).assertNull();
      expect(parseCssColor('rgb(10, 20, 30 / 0.5)')).assertNull();
      expect(parseCssColor('rgb(10, 20, 30, 0.5, 1)')).assertNull();
      expect(parseCssColor('rgb(10 20 / 0.5)')).assertNull();
      expect(parseCssColor('rgb(10 20 30 /)')).assertNull();
      expect(parseCssColor('oklab(0.5 0.1 -0.1)')).assertNull();
    });

    it('resolves translucent themes idempotently without blending drift', 0, () => {
      const first = resolveSystemBarStyle('rgba(23, 30, 33, 0.61)');
      const second = resolveSystemBarStyle('rgba(23, 30, 33, 0.61)');
      expect(first !== null).assertTrue();
      expect(second !== null).assertTrue();
      expect(first!.backgroundHex).assertEqual('#171e21');
      expect(second!.backgroundHex).assertEqual('#171e21');
      expect(first!.contentColor).assertEqual(SYSTEM_BAR_LIGHT_CONTENT);

      const lightTranslucent = resolveSystemBarStyle('rgba(245, 245, 245, 0.85)');
      expect(lightTranslucent !== null).assertTrue();
      expect(lightTranslucent!.backgroundHex).assertEqual('#f5f5f5');
      expect(lightTranslucent!.contentColor).assertEqual(SYSTEM_BAR_DARK_CONTENT);

      expect(resolveSystemBarStyle('rgba(0, 0, 0, 0)')).assertNull();
      expect(resolveSystemBarStyle('transparent')).assertNull();
    });

    it('chooses higher WCAG contrast icon colour across light and mid-grey tones', 0, () => {
      // Dark backgrounds prefer white icons.
      expect(prefersLightSystemBarIcons({ r: 23, g: 23, b: 23, a: 1 })).assertTrue();
      expect(prefersLightSystemBarIcons({ r: 0x66, g: 0x66, b: 0x66, a: 1 })).assertTrue();

      // #767676 sits above the WCAG equal-contrast luminance (~0.179) and prefers black icons.
      expect(prefersLightSystemBarIcons({ r: 0x76, g: 0x76, b: 0x76, a: 1 })).assertFalse();
      // Light grey (#b8b8b8) previously failed under linear-luminance < 0.5.
      expect(prefersLightSystemBarIcons({ r: 0xb8, g: 0xb8, b: 0xb8, a: 1 })).assertFalse();
      expect(prefersLightSystemBarIcons({ r: 255, g: 255, b: 255, a: 1 })).assertFalse();

      const nativeStyle = resolveSystemBarStyle(NATIVE_CHROME_BACKGROUND);
      expect(nativeStyle !== null).assertTrue();
      expect(nativeStyle!.backgroundHex).assertEqual('#15171a');
      expect(nativeStyle!.contentColor).assertEqual(SYSTEM_BAR_LIGHT_CONTENT);
    });

    it('returns zero insets when layout is not full-screen', 0, () => {
      const system = makeArea(
        true,
        { left: 0, top: 0, width: 1200, height: 120 },
        { left: 0, top: 2700, width: 1200, height: 90 },
      );
      const insets = computeSafeAreaInsets(
        false,
        false,
        system,
        null,
        null,
        { width: 1200, height: 2790 },
        (px: number) => px / 3,
      );
      expect(insets.top).assertEqual(0);
      expect(insets.bottom).assertEqual(0);
      expect(insets.left).assertEqual(0);
      expect(insets.right).assertEqual(0);
    });

    it('merges system bars, navigation indicator and landscape cutouts across all four edges', 0, () => {
      const system = makeArea(
        true,
        { left: 0, top: 0, width: 2790, height: 90 },
        ZERO_RECT,
        ZERO_RECT,
        { left: 2670, top: 0, width: 120, height: 1200 },
      );
      const indicator = makeArea(
        true,
        ZERO_RECT,
        { left: 0, top: 1128, width: 2790, height: 72 },
      );
      // Cutout visible is false on HarmonyOS, yet leftRect must still be avoided.
      const cutout = makeArea(
        false,
        ZERO_RECT,
        ZERO_RECT,
        { left: 15, top: 500, width: 90, height: 200 },
        ZERO_RECT,
      );
      const insets = computeSafeAreaInsets(
        true,
        false,
        system,
        indicator,
        cutout,
        { width: 2790, height: 1200 },
        (px: number) => px / 3,
      );
      expect(insets.top).assertEqual(30);
      expect(insets.bottom).assertEqual(24);
      expect(insets.left).assertEqual(35);
      expect(insets.right).assertEqual(40);
    });

    it('collapses vertical bars in immersive mode while keeping horizontal cutout avoidance', 0, () => {
      const system = makeArea(
        false,
        { left: 0, top: 0, width: 1200, height: 120 },
      );
      const indicator = makeArea(
        false,
        ZERO_RECT,
        { left: 0, top: 2700, width: 1200, height: 90 },
      );
      const portraitCutout = makeArea(
        false,
        { left: 450, top: 12, width: 300, height: 96 },
      );
      const portrait = computeSafeAreaInsets(
        true,
        true,
        system,
        indicator,
        portraitCutout,
        { width: 1200, height: 2790 },
        (px: number) => px / 3,
      );
      expect(portrait.top).assertEqual(0);
      expect(portrait.bottom).assertEqual(0);
      expect(portrait.left).assertEqual(0);
      expect(portrait.right).assertEqual(0);

      const landscapeCutout = makeArea(
        false,
        ZERO_RECT,
        ZERO_RECT,
        { left: 12, top: 450, width: 96, height: 300 },
      );
      const landscape = computeSafeAreaInsets(
        true,
        true,
        system,
        indicator,
        landscapeCutout,
        { width: 2790, height: 1200 },
        (px: number) => px / 3,
      );
      expect(landscape.top).assertEqual(0);
      expect(landscape.bottom).assertEqual(0);
      expect(landscape.left).assertEqual(36);
      expect(landscape.right).assertEqual(0);
    });
  });
}
