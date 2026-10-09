import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'luker.keepalive';
const DOMAIN: number = 0xE1EC;
const BACKGROUND_MODE_DATA_TRANSFER: string = 'dataTransfer';
// Required by the system for dataTransfer progress updates.
const DATA_TRANSFER_LIVE_VIEW_TYPE_CODE: number = 8;
const DATA_TRANSFER_TEMPLATE_NAME: string = 'downloadTemplate';
// dataTransfer tasks are cancelled when the progress notification is not
// refreshed (first refresh within 10 minutes). Refreshing every 15 s keeps the
// displayed elapsed time within 15 s of the real value.
const PROGRESS_REFRESH_MS: number = 15_000;

/**
 * Holds a dataTransfer continuous task while a generation is in flight and the
 * app is in the background, so the in-process backend and the ArkWeb renderer
 * keep running instead of being suspended.
 *
 * The page reports generation activity through the LukerHarmony bridge; the
 * ability reports foreground/background transitions. The task is requested
 * only when both "generation active" and "in background" hold, and released as
 * soon as either stops holding.
 */
export class KeepAliveManager {
  private static context: common.UIAbilityContext | undefined = undefined;
  private static generationActive: boolean = false;
  private static inBackground: boolean = false;
  private static taskRunning: boolean = false;
  private static taskPending: boolean = false;
  private static continuousTaskId: number = -1;
  private static notificationId: number = -1;
  private static generationStartedAt: number = 0;
  private static refreshTimer: number = -1;
  // Set when the user removes the notification or the system cancels the task;
  // the task is not requested again until the current generation ends.
  private static cancelledForGeneration: boolean = false;
  private static listenersInstalled: boolean = false;

  static attach(context: common.UIAbilityContext): void {
    KeepAliveManager.context = context;
    KeepAliveManager.installListeners();
  }

  static setGenerationActive(active: boolean): void {
    if (KeepAliveManager.generationActive === active) {
      return;
    }
    KeepAliveManager.generationActive = active;
    if (active) {
      KeepAliveManager.generationStartedAt = Date.now();
    } else {
      KeepAliveManager.cancelledForGeneration = false;
    }
    KeepAliveManager.reconcile();
  }

  static setInBackground(background: boolean): void {
    if (KeepAliveManager.inBackground === background) {
      return;
    }
    KeepAliveManager.inBackground = background;
    KeepAliveManager.reconcile();
  }

  static release(): void {
    KeepAliveManager.generationActive = false;
    KeepAliveManager.reconcile();
  }

  private static shouldHoldTask(): boolean {
    return KeepAliveManager.generationActive
      && KeepAliveManager.inBackground
      && !KeepAliveManager.cancelledForGeneration;
  }

  private static reconcile(): void {
    if (KeepAliveManager.taskPending) {
      return;
    }
    const hold: boolean = KeepAliveManager.shouldHoldTask();
    if (hold && !KeepAliveManager.taskRunning) {
      KeepAliveManager.startTask();
    } else if (!hold && KeepAliveManager.taskRunning) {
      KeepAliveManager.stopTask();
    }
  }

  private static installListeners(): void {
    if (KeepAliveManager.listenersInstalled) {
      return;
    }
    try {
      backgroundTaskManager.on('continuousTaskCancel', KeepAliveManager.onTaskCancelled);
      // With a suspend listener registered, a failed business check first
      // marks the task suspended instead of cancelling it outright.
      backgroundTaskManager.on('continuousTaskSuspend', KeepAliveManager.onTaskSuspended);
      KeepAliveManager.listenersInstalled = true;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'listener install failed: %{public}s', JSON.stringify(e));
    }
  }

  private static onTaskCancelled = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    if (info.id !== KeepAliveManager.continuousTaskId) {
      return;
    }
    hilog.warn(DOMAIN, TAG, 'task cancelled: reason=%{public}d detailed=%{public}d',
      info.reason, info.detailedReason ?? -1);
    KeepAliveManager.clearTaskState();
    KeepAliveManager.cancelledForGeneration = true;
  };

  private static onTaskSuspended = (info: backgroundTaskManager.ContinuousTaskSuspendInfo): void => {
    if (info.continuousTaskId !== KeepAliveManager.continuousTaskId) {
      return;
    }
    hilog.warn(DOMAIN, TAG, 'task suspend state=%{public}s reason=%{public}d',
      String(info.suspendState), info.suspendReason);
  };

  private static async startTask(): Promise<void> {
    const context: common.UIAbilityContext | undefined = KeepAliveManager.context;
    if (context === undefined) {
      return;
    }
    KeepAliveManager.taskPending = true;
    try {
      const agentInfo: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: context.abilityInfo.bundleName,
            abilityName: context.abilityInfo.name
          }
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };
      const agent: WantAgent = await wantAgent.getWantAgent(agentInfo);
      const res: backgroundTaskManager.ContinuousTaskNotification =
        await backgroundTaskManager.startBackgroundRunning(context, [BACKGROUND_MODE_DATA_TRANSFER], agent);
      KeepAliveManager.taskRunning = true;
      KeepAliveManager.notificationId = res.notificationId;
      KeepAliveManager.continuousTaskId = res.continuousTaskId ?? -1;
      hilog.info(DOMAIN, TAG, 'task started: id=%{public}d notification=%{public}d',
        KeepAliveManager.continuousTaskId, KeepAliveManager.notificationId);
      KeepAliveManager.publishProgress();
      KeepAliveManager.refreshTimer = setInterval(() => KeepAliveManager.publishProgress(), PROGRESS_REFRESH_MS);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'startBackgroundRunning failed: %{public}d %{public}s', err.code, err.message);
      KeepAliveManager.cancelledForGeneration = true;
    } finally {
      KeepAliveManager.taskPending = false;
    }
    KeepAliveManager.reconcile();
  }

  private static async stopTask(): Promise<void> {
    const context: common.UIAbilityContext | undefined = KeepAliveManager.context;
    if (context === undefined) {
      return;
    }
    KeepAliveManager.taskPending = true;
    KeepAliveManager.clearTaskState();
    try {
      await backgroundTaskManager.stopBackgroundRunning(context);
      hilog.info(DOMAIN, TAG, 'task stopped');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'stopBackgroundRunning failed: %{public}d %{public}s', err.code, err.message);
    } finally {
      KeepAliveManager.taskPending = false;
    }
    KeepAliveManager.reconcile();
  }

  private static clearTaskState(): void {
    if (KeepAliveManager.refreshTimer !== -1) {
      clearInterval(KeepAliveManager.refreshTimer);
      KeepAliveManager.refreshTimer = -1;
    }
    KeepAliveManager.taskRunning = false;
    KeepAliveManager.continuousTaskId = -1;
    KeepAliveManager.notificationId = -1;
  }

  private static publishProgress(): void {
    const context: common.UIAbilityContext | undefined = KeepAliveManager.context;
    if (context === undefined || !KeepAliveManager.taskRunning) {
      return;
    }
    try {
      const mgr = context.resourceManager;
      const title: string = mgr.getStringByNameSync('keepalive_notification_title');
      const text: string = mgr.getStringByNameSync('keepalive_notification_text',
        formatElapsed(Date.now() - KeepAliveManager.generationStartedAt));
      // A generation has no completion percentage; the elapsed time in the
      // text is the progress being reported.
      const template: notificationManager.NotificationTemplate = {
        name: DATA_TRANSFER_TEMPLATE_NAME,
        data: {
          title: title,
          fileName: text,
          progressValue: 0
        }
      };
      const request: notificationManager.NotificationRequest = {
        id: KeepAliveManager.notificationId,
        notificationSlotType: notificationManager.SlotType.LIVE_VIEW,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_SYSTEM_LIVE_VIEW,
          systemLiveView: {
            typeCode: DATA_TRANSFER_LIVE_VIEW_TYPE_CODE,
            title: title,
            text: text
          }
        },
        template: template
      };
      notificationManager.publish(request).catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'progress publish failed: %{public}d %{public}s', err.code, err.message);
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'progress publish threw: %{public}s', JSON.stringify(e));
    }
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds: number = Math.max(0, Math.floor(ms / 1000));
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * Object exposed to the page as `window.LukerHarmony`.
 */
export class LukerHarmonyBridge {
  setGenerationActive(active: boolean): void {
    KeepAliveManager.setGenerationActive(active === true);
  }
}
