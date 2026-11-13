import { describe, it, expect } from '@ohos/hypium';
import {
  WebRecoverySnapshot,
  onRendererExitedState,
  onPageBeginState,
  planReload,
} from '../main/ets/WebRecoveryState';

interface StateOverrides {
  rendererExited?: boolean;
  rendererExitReason?: number;
  controllerAttached?: boolean;
  serverReady?: boolean;
  webInstanceKey?: number;
  reloadWhenReady?: boolean;
}

function makeState(overrides?: StateOverrides): WebRecoverySnapshot {
  return {
    rendererExited: overrides?.rendererExited ?? false,
    rendererExitReason: overrides?.rendererExitReason ?? -1,
    controllerAttached: overrides?.controllerAttached ?? true,
    serverReady: overrides?.serverReady ?? true,
    webInstanceKey: overrides?.webInstanceKey ?? 0,
    reloadWhenReady: overrides?.reloadWhenReady ?? false,
  };
}

export default function webRecoveryStateTest(): void {
  describe('WebRecoveryState', () => {
    it('marks rendererExited and detaches controller on renderer exit', 0, () => {
      const next = onRendererExitedState(makeState({ controllerAttached: true }), 2);
      expect(next.rendererExited).assertTrue();
      expect(next.rendererExitReason).assertEqual(2);
      expect(next.controllerAttached).assertFalse();
    });

    it('defers reload when serverReady is false', 0, () => {
      const result = planReload(makeState({ serverReady: false, controllerAttached: false }));
      expect(result.strategy).assertEqual('defer');
      expect(result.next.reloadWhenReady).assertTrue();
      expect(result.next.webInstanceKey).assertEqual(0);
    });

    it('defers reload when controller is not attached yet and renderer has not exited', 0, () => {
      const result = planReload(makeState({ serverReady: true, controllerAttached: false, rendererExited: false }));
      expect(result.strategy).assertEqual('defer');
      expect(result.next.reloadWhenReady).assertTrue();
      expect(result.next.webInstanceKey).assertEqual(0);
    });

    it('recreates web instance on reload after renderer exit even when controllerAttached is false', 0, () => {
      const exited = onRendererExitedState(makeState({ controllerAttached: true, webInstanceKey: 0 }), 2);
      const result = planReload(exited);
      expect(result.strategy).assertEqual('recreate');
      expect(result.next.webInstanceKey).assertEqual(1);
      expect(result.next.rendererExited).assertFalse();
      expect(result.next.controllerAttached).assertFalse();
      expect(result.next.reloadWhenReady).assertFalse();
    });

    it('refreshes existing controller when serverReady, attached, and not exited', 0, () => {
      const result = planReload(makeState({ serverReady: true, controllerAttached: true, rendererExited: false }));
      expect(result.strategy).assertEqual('refresh');
      expect(result.next.webInstanceKey).assertEqual(0);
      expect(result.next.reloadWhenReady).assertFalse();
    });

    it('reports recoveredFromExit on first onPageBegin after renderer exit or recreate, then false afterwards', 0, () => {
      const directResult = onPageBeginState(makeState({ rendererExited: true, rendererExitReason: 2 }));
      expect(directResult.recoveredFromExit).assertTrue();
      expect(directResult.next.rendererExited).assertFalse();
      expect(directResult.next.rendererExitReason).assertEqual(-1);

      const exited = onRendererExitedState(makeState({}), 2);
      const planned = planReload(exited);
      const afterRecreate = onPageBeginState(planned.next);
      expect(afterRecreate.recoveredFromExit).assertTrue();
      expect(afterRecreate.next.rendererExited).assertFalse();
      expect(afterRecreate.next.rendererExitReason).assertEqual(-1);

      const normal = onPageBeginState(afterRecreate.next);
      expect(normal.recoveredFromExit).assertFalse();
    });
  });
}
