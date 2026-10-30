/**
 * Decides whether a main-frame load failure should offer endpoint recovery.
 *
 * A 404 or 5xx from a custom endpoint usually means the address points at a
 * server that is not Luker, while 401, 403, 429 and the other 4xx responses
 * are produced by a reachable Luker instance and must not interrupt the page.
 */
export function shouldShowEndpointFailureForStatus(
  statusCode: number,
  isMainFrame: boolean,
): boolean {
  if (!isMainFrame) {
    return false;
  }
  return statusCode === 404 || (statusCode >= 500 && statusCode <= 599);
}

/**
 * Decides whether a main-frame network error should offer endpoint recovery.
 * A canceled navigation is a normal consequence of the page starting another
 * navigation, so it is not a failure.
 */
export function shouldShowEndpointFailureForError(
  errorInfo: string,
  isMainFrame: boolean,
): boolean {
  if (!isMainFrame) {
    return false;
  }
  if (errorInfo.includes('ERR_ABORTED')) {
    return false;
  }
  return true;
}
