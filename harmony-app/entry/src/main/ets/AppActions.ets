export const ACTION_OPEN_ENDPOINT_SETTINGS: string =
  'com.luker.hmos.action.OPEN_ENDPOINT_SETTINGS';
export const ACTION_RELOAD_WEBVIEW: string =
  'com.luker.hmos.action.RELOAD_WEBVIEW';
export const NOTIFICATION_REMOVED_EVENT: string =
  'com.luker.hmos.event.NOTIFICATION_REMOVED';

// The Index page uses these exact strings in @StorageLink decorators. Keep
// both sides in sync when renaming one of them.
export const STORAGE_SERVER_URL: string = 'luker.serverUrl';
export const STORAGE_CUSTOM_ENDPOINT: string = 'luker.customEndpoint';
export const STORAGE_PENDING_ACTION: string = 'luker.pendingAction';
