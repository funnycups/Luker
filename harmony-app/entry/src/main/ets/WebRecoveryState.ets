export interface WebRecoverySnapshot {
  rendererExited: boolean;
  rendererExitReason: number;
  controllerAttached: boolean;
  serverReady: boolean;
  webInstanceKey: number;
  reloadWhenReady: boolean;
}

export type ReloadStrategy = 'defer' | 'recreate' | 'refresh';

export interface PageBeginResult {
  next: WebRecoverySnapshot;
  recoveredFromExit: boolean;
}

export interface ReloadPlan {
  next: WebRecoverySnapshot;
  strategy: ReloadStrategy;
}

export function onRendererExitedState(state: WebRecoverySnapshot, reason: number): WebRecoverySnapshot {
  return {
    rendererExited: true,
    rendererExitReason: reason,
    controllerAttached: false,
    serverReady: state.serverReady,
    webInstanceKey: state.webInstanceKey,
    reloadWhenReady: state.reloadWhenReady,
  };
}

export function onPageBeginState(state: WebRecoverySnapshot): PageBeginResult {
  const recoveredFromExit: boolean = state.rendererExited || state.rendererExitReason !== -1;
  return {
    next: {
      rendererExited: false,
      rendererExitReason: -1,
      controllerAttached: state.controllerAttached,
      serverReady: state.serverReady,
      webInstanceKey: state.webInstanceKey,
      reloadWhenReady: state.reloadWhenReady,
    },
    recoveredFromExit: recoveredFromExit,
  };
}

export function planReload(state: WebRecoverySnapshot): ReloadPlan {
  if (!state.serverReady) {
    return {
      next: {
        rendererExited: state.rendererExited,
        rendererExitReason: state.rendererExitReason,
        controllerAttached: state.controllerAttached,
        serverReady: state.serverReady,
        webInstanceKey: state.webInstanceKey,
        reloadWhenReady: true,
      },
      strategy: 'defer',
    };
  }
  if (state.rendererExited) {
    return {
      next: {
        rendererExited: false,
        rendererExitReason: state.rendererExitReason,
        controllerAttached: false,
        serverReady: state.serverReady,
        webInstanceKey: state.webInstanceKey + 1,
        reloadWhenReady: false,
      },
      strategy: 'recreate',
    };
  }
  if (!state.controllerAttached) {
    return {
      next: {
        rendererExited: state.rendererExited,
        rendererExitReason: state.rendererExitReason,
        controllerAttached: state.controllerAttached,
        serverReady: state.serverReady,
        webInstanceKey: state.webInstanceKey,
        reloadWhenReady: true,
      },
      strategy: 'defer',
    };
  }
  return {
    next: {
      rendererExited: false,
      rendererExitReason: state.rendererExitReason,
      controllerAttached: state.controllerAttached,
      serverReady: state.serverReady,
      webInstanceKey: state.webInstanceKey,
      reloadWhenReady: false,
    },
    strategy: 'refresh',
  };
}
