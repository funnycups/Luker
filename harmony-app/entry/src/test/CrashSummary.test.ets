import { describe, it, expect } from '@ohos/hypium';
import { buildCrashSummary, parseReportTime, isPending, isArkWebCrashReason } from '../main/ets/crash/CrashSummary';

export default function crashSummaryTest(): void {
  describe('CrashSummary', () => {
    it('extracts crash_type and time', 0, () => {
      const report = 'source=hiappevent\ncrash_type=NativeCrash\ntime=1503045716054\n';
      expect(buildCrashSummary(report)).assertContain('crash_type=NativeCrash');
      expect(parseReportTime(report)).assertEqual(1503045716054);
    });

    it('returns empty string when no fields found', 0, () => {
      expect(buildCrashSummary('nothing here')).assertEqual('');
    });

    it('includes exception and renderExitReason when present', 0, () => {
      const report = 'crash_type=JsError\nexception={"name":"SyntaxError"}\nrenderExitReason=3\n';
      const out = buildCrashSummary(report);
      expect(out).assertContain('exception={"name":"SyntaxError"}');
      expect(out).assertContain('renderExitReason=3');
    });

    it('isPending compares report time against ack time', 0, () => {
      expect(isPending(100, 50)).assertTrue();
      expect(isPending(50, 100)).assertFalse();
      expect(isPending(50, 50)).assertFalse();
    });

    it('isArkWebCrashReason only accepts crash-like reasons', 0, () => {
      expect(isArkWebCrashReason(2)).assertTrue();
      expect(isArkWebCrashReason(3)).assertTrue();
      expect(isArkWebCrashReason(4)).assertTrue();
      expect(isArkWebCrashReason(0)).assertFalse();
      expect(isArkWebCrashReason(1)).assertFalse();
    });
  });
}
