import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import http from '@ohos.net.http';
import { getBackendStatus } from 'libnode_ctl.so';
import { BackendManager } from '../BackendManager';
import { launchInProcessEarly } from '../BackendLauncher';
import { promptAction } from '@kit.ArkUI';
import { listPending, acknowledge, StoredReport } from '../crash/CrashReportStore';
import { buildCrashSummary, isArkWebCrashReason } from '../crash/CrashSummary';
import { exportTo } from '../crash/DiagnosticsExporter';
import { writeArkWebExit } from '../crash/CrashCapture';
import { LastExit } from '../crash/LastExit';
import { KeepAliveManager, LukerHarmonyBridge } from '../KeepAliveManager';
import { ExternalLinkSettings, LinkRoute, originOf, routeNewWindow, routeTopLevelNavigation } from '../ExternalLinkPolicy';
import { FileSelectionPlan, MediaKind, planFileSelection } from '../FileSelectionPlanner';
import { BusinessError } from '@kit.BasicServicesKit';
import { AppConfig } from '../AppConfig';
import { DEFAULT_LOCAL_BASE_URL, isLocalBaseUrl, normalizeCustomBaseUrl } from '../EndpointUrl';
import {
  shouldShowEndpointFailureForError,
  shouldShowEndpointFailureForStatus,
} from '../EndpointFailure';
import { RuntimeNotification } from '../RuntimeNotification';
import {
  ACTION_OPEN_ENDPOINT_SETTINGS,
  ACTION_RELOAD_WEBVIEW,
} from '../AppActions';

const TAG: string = 'luker.Index';
const DOMAIN: number = 0xE1EC;
const BOOT_TIMEOUT_MS: number = 120_000;
const CONFIRM_EXIT_WINDOW_MS: number = 2000;

interface ProbeResult {
  ok: boolean;
  error: string;
}

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  private bridge: LukerHarmonyBridge = new LukerHarmonyBridge();
  @State serverReady: boolean = false;
  @State statusMessage: string = '';
  @StorageLink('luker.serverUrl') serverUrl: string = DEFAULT_LOCAL_BASE_URL;
  @StorageLink('luker.customEndpoint') customEndpoint: boolean = false;
  @StorageLink('luker.pendingAction') @Watch('onPendingAction') pendingAction: string = '';
  private exporting: boolean = false;
  private crashDialogDone: boolean = false;
  private saveTargets: Map<string, string> = new Map<string, string>();
  private fsHandler: FullScreenExitHandler | null = null;
  private lastExitPressAt: number = 0;
  private popupDialogController: CustomDialogController | null = null;
  private popupDialogToken: number = 0;
  private endpointDialogController: CustomDialogController | null = null;
  private endpointDialogToken: number = 0;
  private reloadWhenReady: boolean = false;
  private controllerAttached: boolean = false;
  private pageShown: boolean = false;
  private pendingEndpointDialog: boolean = false;
  private endpointFailureShown: boolean = false;
  private pendingEndpointFailureUrl: string = '';
  private startToken: number = 0;

  aboutToAppear(): void {
    this.bridge.onOpenEndpointSettings = () => this.requestEndpointDialog();
    this.bridge.onReloadWebView = () => this.reloadWeb();
    if (AppConfig.warning().length > 0) {
      promptAction.showToast({ message: this.res($r('app.string.endpoint_config_failed').id) });
    }
    const launchAction: string = this.pendingAction;
    this.statusMessage = this.res($r('app.string.starting_engine').id, '0s');
    let dialogShown: boolean = false;
    try {
      dialogShown = this.checkPendingCrash();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'checkPendingCrash failed: %{public}s', JSON.stringify(e));
    }
    if (!dialogShown) {
      this.onPendingAction();
      if (this.customEndpoint && launchAction.length === 0) {
        this.requestEndpointDialog();
      }
      this.start();
    }
  }

  onPageShow(): void {
    this.pageShown = true;
    this.openPendingEndpointDialog();
  }

  onPageHide(): void {
    this.pageShown = false;
  }

  private res(id: number, arg?: string): string {
    const mgr = getContext(this).resourceManager;
    return arg === undefined ? mgr.getStringSync(id) : mgr.getStringSync(id, arg);
  }

  private crashFilesDir(): string {
    return (getContext(this) as common.UIAbilityContext).filesDir;
  }

  private async doExport(): Promise<void> {
    if (this.exporting) {
      return;
    }
    this.exporting = true;
    try {
      await exportTo(getContext(this) as common.UIAbilityContext);
    } catch (e) {
      promptAction.showToast({
        message: this.res($r('app.string.export_failed').id, String(e))
      });
    } finally {
      this.exporting = false;
    }
  }

  /**
   * Shows the crash dialog when the previous run ended abnormally or an
   * unacknowledged report exists. Returns true when the dialog is shown; the
   * backend start then waits for the dialog, so an export captures the crashed
   * run's node logs before a new launch rotates them.
   */
  private checkPendingCrash(): boolean {
    const pending: StoredReport[] = listPending(this.crashFilesDir());
    if (pending.length === 0 && !LastExit.deferBackend) {
      return false;
    }
    let summary: string = '';
    for (let i = 0; i < pending.length; i++) {
      summary += buildCrashSummary(pending[i].body) + '\n\n';
    }
    if (summary.trim().length === 0) {
      summary = this.res($r('app.string.no_crash_report').id);
    }
    promptAction.showDialog({
      title: this.res($r('app.string.crash_dialog_title').id),
      message: this.res($r('app.string.crash_dialog_intro').id) + '\n\n' + summary,
      buttons: [
        { text: this.res($r('app.string.crash_dialog_close').id), color: '#8b93a7' },
        { text: this.res($r('app.string.export_diagnostics').id), color: '#4aa3ff' }
      ]
    }).then(async (result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        await this.doExport();
      }
      this.finishCrashDialog();
    }).catch(() => {
      this.finishCrashDialog();
    });
    return true;
  }

  private finishCrashDialog(): void {
    if (this.crashDialogDone) {
      return;
    }
    this.crashDialogDone = true;
    // Acknowledge with the current time: a hiAppEvent report for the same
    // crash that arrives later carries an earlier time and stays acknowledged.
    acknowledge(this.crashFilesDir(), Date.now());
    LastExit.deferBackend = false;
    const launchAction: string = this.pendingAction;
    this.start();
    this.onPendingAction();
    if (this.customEndpoint && launchAction.length === 0) {
      this.requestEndpointDialog();
    }
  }

  async start(): Promise<void> {
    const token: number = ++this.startToken;
    const serverUrl: string = this.serverUrl;
    const customEndpoint: boolean = this.customEndpoint;
    const readyLimit: number = customEndpoint ? 400 : 500;
    let lastProbeError: string = '';
    this.statusMessage = this.res($r('app.string.starting_engine').id, '0s');
    const context = getContext(this) as common.UIAbilityContext;
    if (!customEndpoint && !BackendManager.launchAttempted) {
      launchInProcessEarly(context);
    }
    const startedAt: number = Date.now();
    while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
      if (token !== this.startToken) {
        return;
      }
      const result: ProbeResult = await this.probe(serverUrl, readyLimit);
      if (token !== this.startToken) {
        return;
      }
      if (result.ok) {
        this.serverReady = true;
        RuntimeNotification.setServerReady(true);
        return;
      }
      lastProbeError = result.error;
      const secs: number = Math.round((Date.now() - startedAt) / 1000);
      if (customEndpoint) {
        let message: string = this.res($r('app.string.starting_engine').id, `${secs}s`);
        if (lastProbeError.length > 0) {
          message += '\n' + this.res($r('app.string.endpoint_probe_failed').id, lastProbeError);
        }
        this.statusMessage = message;
      } else {
        const status: string = getBackendStatusSafe();
        this.statusMessage =
          this.res($r('app.string.starting_engine').id, `${secs}s`) + '\n' +
          this.res($r('app.string.backend_status').id, status);
        if (status.startsWith('failed:')) {
          this.statusMessage = this.res($r('app.string.engine_failed').id, status);
          return;
        }
      }
      await this.sleep(200);
    }
    if (token !== this.startToken) {
      return;
    }
    if (customEndpoint) {
      let message: string = this.res($r('app.string.endpoint_timeout').id);
      if (lastProbeError.length > 0) {
        message += '\n' + this.res($r('app.string.endpoint_probe_failed').id, lastProbeError);
      }
      this.statusMessage = message;
    } else {
      this.statusMessage = this.res($r('app.string.engine_timeout').id);
    }
  }

  async probe(url: string, readyLimit: number): Promise<ProbeResult> {
    const client = http.createHttp();
    try {
      const resp = await client.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000,
        usingCache: false
      });
      if (resp.responseCode >= 200 && resp.responseCode < readyLimit) {
        return { ok: true, error: '' };
      }
      return { ok: false, error: `HTTP ${resp.responseCode}` };
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      return { ok: false, error: err.message ? `${err.code}: ${err.message}` : String(e) };
    } finally {
      client.destroy();
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
  }

  private onPendingAction(): void {
    const action: string = this.pendingAction;
    if (action.length === 0) {
      return;
    }
    this.pendingAction = '';
    if (action === ACTION_OPEN_ENDPOINT_SETTINGS) {
      this.requestEndpointDialog();
    } else if (action === ACTION_RELOAD_WEBVIEW) {
      this.reloadWeb();
    }
  }

  private requestEndpointDialog(): void {
    this.pendingEndpointDialog = true;
    this.openPendingEndpointDialog();
  }

  private openPendingEndpointDialog(): void {
    if (!this.pendingEndpointDialog || !this.pageShown) {
      return;
    }
    this.pendingEndpointDialog = false;
    this.openEndpointDialog();
  }

  private reloadWeb(): void {
    if (!this.serverReady || !this.controllerAttached) {
      this.reloadWhenReady = true;
      return;
    }
    try {
      this.controller.refresh();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'refresh failed: %{public}s', JSON.stringify(e));
      try {
        this.controller.loadUrl(this.serverUrl);
      } catch (reloadError) {
        hilog.error(DOMAIN, TAG, 'reload after refresh failure failed: %{public}s',
          JSON.stringify(reloadError));
      }
    }
  }

  private closeEndpointDialog(): void {
    const controller: CustomDialogController | null = this.endpointDialogController;
    this.endpointDialogController = null;
    controller?.close();
  }

  private openEndpointDialog(): void {
    if (this.endpointDialogController !== null) {
      return;
    }
    this.closePopupDialog();
    const token: number = ++this.endpointDialogToken;
    const dialogController: CustomDialogController = new CustomDialogController({
      builder: EndpointDialog({
        initialUrl: AppConfig.customBaseUrl() ?? '',
        currentUrl: this.serverUrl,
        usesCustom: this.customEndpoint,
        onSave: (url: string) => this.applyEndpoint(url),
        onReset: () => this.applyEndpoint(null),
        onClose: () => this.closeEndpointDialog(),
        onClosed: () => {
          if (this.endpointDialogToken !== token) {
            return;
          }
          this.endpointDialogController = null;
          const pendingUrl: string = this.pendingEndpointFailureUrl;
          this.pendingEndpointFailureUrl = '';
          if (pendingUrl.length > 0) {
            this.maybeShowEndpointFailure(pendingUrl);
          }
        },
      }),
      autoCancel: true,
      customStyle: true,
    });
    try {
      dialogController.open();
      this.endpointDialogController = dialogController;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'endpoint dialog open failed: %{public}s', JSON.stringify(e));
      promptAction.showToast({ message: this.res($r('app.string.endpoint_dialog_failed').id) });
    }
  }

  /**
   * Offers endpoint recovery after a main-frame load failure. The dialog is
   * shown once per navigation; a failure that arrives while the endpoint
   * dialog is open is held until that dialog closes.
   */
  private maybeShowEndpointFailure(url: string): void {
    if (!this.customEndpoint || this.endpointFailureShown) {
      return;
    }
    if (this.endpointDialogController !== null) {
      this.pendingEndpointFailureUrl = url;
      return;
    }
    const dialog = promptAction.showDialog({
      title: this.res($r('app.string.endpoint_failure_title').id),
      message: this.res($r('app.string.endpoint_failure_message').id, url),
      buttons: [
        { text: this.res($r('app.string.endpoint_failure_cancel').id), color: '#8b93a7' },
        { text: this.res($r('app.string.endpoint_failure_retry').id), color: '#4aa3ff' },
        { text: this.res($r('app.string.endpoint_failure_switch').id), color: '#4aa3ff' },
      ]
    });
    this.endpointFailureShown = true;
    dialog.then((result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        this.reloadWeb();
      } else if (result.index === 2) {
        this.endpointFailureShown = false;
        this.openEndpointDialog();
      }
    }).catch((e: BusinessError) => {
      this.endpointFailureShown = false;
      hilog.error(DOMAIN, TAG, 'endpoint failure dialog failed: %{public}d %{public}s', e.code, e.message);
    });
  }

  private applyEndpoint(customBaseUrl: string | null): boolean {
    try {
      if (customBaseUrl === null) {
        AppConfig.resetCustomBaseUrl();
      } else {
        AppConfig.saveCustomBaseUrl(customBaseUrl);
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'endpoint save failed: %{public}s', JSON.stringify(e));
      promptAction.showToast({ message: this.res($r('app.string.endpoint_save_failed').id) });
      return false;
    }
    const nextUrl: string = customBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
    const nextCustom: boolean = customBaseUrl !== null;
    promptAction.showToast({
      message: this.res(customBaseUrl === null
        ? $r('app.string.endpoint_reset_done').id
        : $r('app.string.endpoint_saved').id)
    });
    if (nextUrl === this.serverUrl && nextCustom === this.customEndpoint) {
      return true;
    }
    this.endpointFailureShown = false;
    this.pendingEndpointFailureUrl = '';
    this.closePopupDialog();
    KeepAliveManager.release();
    RuntimeNotification.setServerReady(false);
    RuntimeNotification.setKeepAliveActive(false);
    this.serverUrl = nextUrl;
    this.customEndpoint = nextCustom;
    this.controller = new webview.WebviewController();
    this.serverReady = false;
    this.controllerAttached = false;
    this.start();
    return true;
  }

  onBackPress(): boolean {
    if (this.fsHandler !== null) {
      this.lastExitPressAt = 0;
      this.fsHandler.exitFullScreen();
      return true;
    }
    try {
      if (this.controller.accessStep(-1)) {
        this.lastExitPressAt = 0;
        this.controller.backward();
        return true;
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'accessStep failed: %{public}s', JSON.stringify(e));
    }
    this.dispatchBackToWeb();
    return true;
  }

  private dispatchBackToWeb(): void {
    const script = "(function(){try{return (typeof window.__lukerHandleBack === 'function') ? String(window.__lukerHandleBack()) : 'noop';}catch(e){return 'noop';}})();";
    this.controller.runJavaScript(script, (err: BusinessError, result: string) => {
      if (err) {
        hilog.error(DOMAIN, TAG, 'runJavaScript failed: %{public}s', JSON.stringify(err));
      }
      const value = String(result || '').trim().replace(/^"|"$/g, '').toLowerCase();
      if (value === 'consumed') {
        this.lastExitPressAt = 0;
        return;
      }
      this.confirmExit();
    });
  }

  private confirmExit(): void {
    const now: number = Date.now();
    if (this.lastExitPressAt !== 0 && now - this.lastExitPressAt <= CONFIRM_EXIT_WINDOW_MS) {
      const context = getContext(this) as common.UIAbilityContext;
      context.terminateSelf();
      return;
    }
    this.lastExitPressAt = now;
    promptAction.showToast({ message: this.res($r('app.string.press_back_again_to_exit').id) });
  }

  /**
   * Routes page-initiated downloads (the frontend saves backups and exports by
   * clicking an `<a download>` on a blob/data URL) through the ArkWeb download
   * delegate. Without it the download is silently dropped and no save dialog
   * appears. The delegate must be set once the controller is attached to the
   * Web component.
   */
  private setupDownloads(): void {
    const delegate = new webview.WebDownloadDelegate();
    const context = getContext(this) as common.UIAbilityContext;
    delegate.onBeforeDownload((item: webview.WebDownloadItem) => {
      const fileName: string = item.getSuggestedFileName() || 'luker-download';
      // The download stays PENDING until start() is called, so it is safe to
      // await the picker first.
      this.pickSavePath(fileName).then((targetUri: string) => {
        if (targetUri.length === 0) {
          item.cancel();
          return;
        }
        this.saveTargets.set(item.getGuid(), targetUri);
        // Download into the app cache, then copy to the user-picked location:
        // ArkWeb always may write its own sandbox, while the picked URI is
        // written through the fd opened with the picker's grant.
        item.start(`${context.cacheDir}/${fileName}`);
      }).catch((e: object) => {
        hilog.error(DOMAIN, TAG, 'download save path failed: %{public}s', JSON.stringify(e));
        item.cancel();
      });
    });
    delegate.onDownloadFinish((item: webview.WebDownloadItem) => {
      const targetUri: string = this.saveTargets.get(item.getGuid()) ?? '';
      this.saveTargets.delete(item.getGuid());
      if (targetUri.length === 0) {
        return;
      }
      this.copyToUserPath(item.getFullPath(), targetUri);
    });
    delegate.onDownloadFailed((item: webview.WebDownloadItem) => {
      this.saveTargets.delete(item.getGuid());
      hilog.error(DOMAIN, TAG, 'download failed: %{public}d', item.getLastErrorCode());
      promptAction.showToast({ message: this.res($r('app.string.download_failed').id) });
    });
    try {
      this.controller.setDownloadDelegate(delegate);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'setDownloadDelegate failed: %{public}s', JSON.stringify(e));
    }
  }

  private async pickSavePath(fileName: string): Promise<string> {
    const context = getContext(this) as common.UIAbilityContext;
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = [fileName];
    const result: Array<string> = await new picker.DocumentViewPicker(context).save(options);
    if (result.length === 0 || !result[0]) {
      return '';
    }
    return result[0];
  }

  private async copyToUserPath(sourcePath: string, targetUri: string): Promise<void> {
    try {
      const src = fileIo.openSync(sourcePath, fileIo.OpenMode.READ_ONLY);
      const dst = fileIo.openSync(targetUri, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE);
      await fileIo.copyFile(src.fd, dst.fd);
      fileIo.closeSync(src);
      fileIo.closeSync(dst);
      try {
        fileIo.unlinkSync(sourcePath);
      } catch {
        // best effort
      }
      promptAction.showToast({ message: this.res($r('app.string.download_saved').id) });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'download copy failed: %{public}s', JSON.stringify(e));
      promptAction.showToast({ message: this.res($r('app.string.download_failed').id) });
    }
  }

  /**
   * Answers a page file-upload request. ArkWeb keeps the file input pending
   * until the result is handed back, so every path, including a cancelled or
   * failed picker, has to call handleFileList.
   */
  private async resolveFileSelection(event: OnShowFileSelectorEvent): Promise<void> {
    let selected: Array<string> = [];
    try {
      const multiple: boolean =
        event.fileSelector.getMode() === FileSelectorMode.FileOpenMultipleMode;
      const plan: FileSelectionPlan = planFileSelection(
        event.fileSelector.getAcceptType(),
        event.fileSelector.getMimeTypes(),
        multiple,
      );
      selected = plan.useMediaPicker
        ? await this.pickMedia(plan)
        : await this.pickDocument(plan);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'file selection failed: %{public}s', JSON.stringify(e));
    }
    event.result.handleFileList(selected);
  }

  private async pickMedia(plan: FileSelectionPlan): Promise<Array<string>> {
    const options = new photoAccessHelper.PhotoSelectOptions();
    options.MIMEType = mediaMimeType(plan.mediaKind);
    if (plan.maxSelectNumber > 0) {
      options.maxSelectNumber = plan.maxSelectNumber;
    }
    const mediaPicker = new photoAccessHelper.PhotoViewPicker();
    const result: photoAccessHelper.PhotoSelectResult = await mediaPicker.select(options);
    return result.photoUris;
  }

  private async pickDocument(plan: FileSelectionPlan): Promise<Array<string>> {
    const options = new picker.DocumentSelectOptions();
    if (plan.fileSuffixFilters.length > 0) {
      options.fileSuffixFilters = plan.fileSuffixFilters;
    }
    if (plan.maxSelectNumber > 0) {
      options.maxSelectNumber = plan.maxSelectNumber;
    }
    const context = getContext(this) as common.UIAbilityContext;
    const documentPicker = new picker.DocumentViewPicker(context);
    return await documentPicker.select(options);
  }

  /**
   * Answers a page-initiated new-window request. A request with window features
   * belongs to a page that keeps the opened window and talks to it through
   * `window.opener`, so it becomes an in-app dialog. The remaining requests
   * follow the external-link policy.
   */
  private handleNewWindow(event: OnWindowNewExtEvent): void {
    if (event.isUserTrigger !== true) {
      event.handler.setWebController(null);
      return;
    }
    const target: string = event.targetUrl ?? '';
    const openExternally: boolean = ExternalLinkSettings.isOpenExternally();
    // The window-new event exposes no HTTP method, so a form post that opens a new window is not visible here.
    const route: LinkRoute = routeNewWindow(
      target,
      event.isAlert === true,
      originOf(this.serverUrl),
      openExternally,
    );
    hilog.info(DOMAIN, TAG, 'new window: alert=%{public}s policy=%{public}d external=%{public}s route=%{public}d',
      String(event.isAlert), event.navigationPolicy, String(openExternally), route);
    if (route === LinkRoute.SystemBrowser) {
      event.handler.setWebController(null);
      this.bridge.openExternalUrl(target);
      return;
    }
    const popupController: webview.WebviewController = new webview.WebviewController();
    let dialogController: CustomDialogController | null = null;
    try {
      this.closePopupDialog();
      const token: number = ++this.popupDialogToken;
      dialogController = new CustomDialogController({
        builder: PopupWebViewDialog({
          popupController: popupController,
          src: '',
          onClosed: () => {
            if (this.popupDialogToken === token) {
              this.popupDialogController = null;
            }
          },
        }),
        autoCancel: false,
        customStyle: true,
      });
      dialogController.open();
      event.handler.setWebController(popupController);
      this.popupDialogController = dialogController;
    } catch (error) {
      if (dialogController !== null) {
        try {
          dialogController.close();
        } catch (closeError) {
          hilog.error(DOMAIN, TAG, 'new window dialog cleanup failed: %{public}s', JSON.stringify(closeError));
        }
      }
      this.popupDialogController = null;
      event.handler.setWebController(null);
      hilog.error(DOMAIN, TAG, 'new window dialog failed: %{public}s', JSON.stringify(error));
    }
  }

  private closePopupDialog(): void {
    const openDialog: CustomDialogController | null = this.popupDialogController;
    this.popupDialogController = null;
    openDialog?.close();
  }

  build() {
    Stack() {
      if (this.serverReady) {
        Web({ src: this.serverUrl, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .multiWindowAccess(true)
          .allowWindowOpenMethod(true)
          .javaScriptProxy({
            object: this.bridge,
            name: 'LukerHarmony',
            methodList: [
              'setGenerationActive',
              'setImmersiveModeEnabled',
              'setOpenExternalLinksInBrowser',
              'openExternalUrl',
              'openEndpointSettings',
              'reloadWebView',
            ],
            controller: this.controller
          })
          .onLoadIntercept((event) => {
            const request = event.data;
            if (!request.isMainFrame() || request.isRedirect()) {
              return false;
            }
            const target: string = request.getRequestUrl();
            if (routeTopLevelNavigation(
              target, this.controller.getUrl(), originOf(this.serverUrl),
              ExternalLinkSettings.isOpenExternally(),
            ) === LinkRoute.SystemBrowser) {
              this.bridge.openExternalUrl(target);
              return true;
            }
            return false;
          })
          .onWindowNewExt((event) => {
            this.handleNewWindow(event);
          })
          .onControllerAttached(() => {
            this.controllerAttached = true;
            this.setupDownloads();
            if (this.reloadWhenReady) {
              this.reloadWhenReady = false;
              this.reloadWeb();
            }
          })
          // A reload or renderer exit drops the page's generation state and
          // leaves any popup on top of a page that no longer opened it, so the
          // native flags must not outlive it.
          .onPageBegin(() => {
            this.closePopupDialog();
            KeepAliveManager.setGenerationActive(false);
            this.endpointFailureShown = false;
            this.pendingEndpointFailureUrl = '';
          })
          .onErrorReceive((event) => {
            if (!event || !event.request.isMainFrame()) {
              return;
            }
            if (shouldShowEndpointFailureForError(
              event.error.getErrorInfo(),
              true,
            )) {
              this.maybeShowEndpointFailure(event.request.getRequestUrl());
            }
          })
          .onHttpErrorReceive((event) => {
            if (!event || !event.request.isMainFrame()) {
              return;
            }
            if (shouldShowEndpointFailureForStatus(event.response.getResponseCode(), true)) {
              this.maybeShowEndpointFailure(event.request.getRequestUrl());
            }
          })
          .onRenderExited((event) => {
            this.closePopupDialog();
            KeepAliveManager.setGenerationActive(false);
            if (event && isArkWebCrashReason(event.renderExitReason)) {
              writeArkWebExit(this.crashFilesDir(), event.renderExitReason);
            }
          })
          .onFullScreenEnter((event) => {
            this.fsHandler = event.handler;
          })
          .onFullScreenExit(() => {
            this.fsHandler = null;
          })
          .onShowFileSelector((event) => {
            if (event) {
              this.resolveFileSelection(event);
            }
            return true;
          })
      } else {
        Column({ space: 16 }) {
          Text('Luker').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#cfd6e4')
          LoadingProgress().width(36).height(36).color('#4aa3ff')
          Text(this.statusMessage)
            .fontSize(12)
            .fontColor('#8b93a7')
            .textAlign(TextAlign.Center)
            .padding({ left: 24, right: 24 })
          Text(this.serverUrl)
            .fontSize(11)
            .fontColor('#5c6370')
            .textAlign(TextAlign.Center)
            .padding({ left: 24, right: 24 })
          Button($r('app.string.endpoint_settings'))
            .fontSize(13)
            .fontColor('#4aa3ff')
            .backgroundColor(Color.Transparent)
            .onClick(() => this.openEndpointDialog())
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#15171a')
      }
    }
    .width('100%')
    .height('100%')
  }
}

/**
 * Hosts a page's new window in an app dialog. The page keeps its `window.opener`
 * relation and closes the window from script; the URL bar shows the current
 * address so the page inside stays identifiable. Navigation inside the dialog
 * is not routed.
 */
@CustomDialog
struct PopupWebViewDialog {
  controller?: CustomDialogController;
  popupController: webview.WebviewController = new webview.WebviewController();
  src: string = '';
  onClosed?: () => void;
  @State currentUrl: string = '';

  aboutToAppear(): void {
    this.currentUrl = this.src;
  }

  aboutToDisappear(): void {
    this.onClosed?.();
  }

  build() {
    Column() {
      Row() {
        Text(this.currentUrl)
          .fontSize(12)
          .fontColor('#8b93a7')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Button('×')
          .fontSize(18)
          .fontColor('#cfd6e4')
          .backgroundColor(Color.Transparent)
          .onClick(() => this.closeDialog())
      }
      .width('100%')
      .height(44)
      .padding({ left: 16, right: 8 })
      .backgroundColor('#232830')

      Web({ src: this.src, controller: this.popupController })
        .width('100%')
        .layoutWeight(1)
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .multiWindowAccess(false)
        .onPageBegin((event) => {
          this.currentUrl = event.url;
        })
        .onWindowExit(() => {
          this.closeDialog();
        })
    }
    .width('85%')
    .height('75%')
    .backgroundColor('#15171a')
    .borderRadius(16)
    .clip(true)
  }

  private closeDialog(): void {
    this.controller?.close();
  }
}

function mediaMimeType(kind: MediaKind): photoAccessHelper.PhotoViewMIMETypes {
  switch (kind) {
    case MediaKind.Image:
      return photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    case MediaKind.Video:
      return photoAccessHelper.PhotoViewMIMETypes.VIDEO_TYPE;
    default:
      return photoAccessHelper.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE;
  }
}

/**
 * Endpoint selector. The custom field is empty by default; Reset to default is
 * a separate action so an empty field cannot silently change the endpoint.
 */
@CustomDialog
struct EndpointDialog {
  controller?: CustomDialogController;
  initialUrl: string = '';
  currentUrl: string = '';
  usesCustom: boolean = false;
  onSave?: (url: string) => boolean;
  onReset?: () => boolean;
  onClose?: () => void;
  onClosed?: () => void;
  @State input: string = '';
  @State error: string = '';

  aboutToAppear(): void {
    this.input = this.initialUrl;
  }

  aboutToDisappear(): void {
    this.onClosed?.();
  }

  private save(): void {
    if (this.input.trim().length === 0) {
      this.error = this.res($r('app.string.endpoint_required').id);
      return;
    }
    const normalized: string | null = normalizeCustomBaseUrl(this.input);
    if (normalized === null) {
      this.error = this.res($r('app.string.endpoint_invalid_url').id);
      return;
    }
    if (isLocalBaseUrl(normalized)) {
      if (this.onReset?.() === false) {
        return;
      }
      this.onClose?.();
      return;
    }
    if (this.onSave?.(normalized) === false) {
      return;
    }
    this.onClose?.();
  }

  private res(id: number, arg?: string): string {
    const mgr = getContext(this).resourceManager;
    return arg === undefined ? mgr.getStringSync(id) : mgr.getStringSync(id, arg);
  }

  build() {
    Column({ space: 12 }) {
      Text($r('app.string.endpoint_dialog_title'))
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor('#cfd6e4')
        .width('100%')
      Text(this.usesCustom
        ? this.res($r('app.string.endpoint_dialog_current_custom').id, this.currentUrl)
        : this.res($r('app.string.endpoint_dialog_current_local').id))
        .fontSize(12)
        .fontColor('#8b93a7')
        .width('100%')
      Text($r('app.string.endpoint_dialog_message'))
        .fontSize(12)
        .fontColor('#8b93a7')
        .width('100%')
      TextInput({ text: this.input, placeholder: $r('app.string.endpoint_dialog_hint') })
        .width('100%')
        .fontColor('#cfd6e4')
        .placeholderColor('#5c6370')
        .backgroundColor('#232830')
        .onChange((value: string) => {
          this.input = value;
          this.error = '';
        })
      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12)
          .fontColor('#ff6b6b')
          .width('100%')
      }
      Row({ space: 8 }) {
        Button($r('app.string.endpoint_dialog_cancel'))
          .fontSize(13)
          .fontColor('#8b93a7')
          .backgroundColor(Color.Transparent)
          .onClick(() => this.onClose?.())
        Button($r('app.string.endpoint_dialog_reset'))
          .fontSize(13)
          .fontColor('#cfd6e4')
          .backgroundColor('#2d333d')
          .onClick(() => {
            if (this.onReset?.() === false) {
              return;
            }
            this.onClose?.();
          })
        Button($r('app.string.endpoint_dialog_save'))
          .fontSize(13)
          .fontColor('#ffffff')
          .backgroundColor('#4aa3ff')
          .onClick(() => this.save())
      }
      .width('100%')
      .justifyContent(FlexAlign.End)
    }
    .width('90%')
    .padding(20)
    .backgroundColor('#1c1f24')
    .borderRadius(16)
  }
}

function getBackendStatusSafe(): string {
  try {
    return getBackendStatus();
  } catch {
    return 'unavailable';
  }
}
