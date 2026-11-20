// What: decides whether a page may open the camera.
// Why: consent and the page origin are checked in the main process, so the page cannot skip them.
// Removed: a remote document, another local file, the dev server, a subframe, or a microphone request could receive media.
export interface MediaPermissionInput {
  permission: string;
  requestingUrl: string | undefined;
  /** The built page this window is allowed to show. Any other file URL stays denied. */
  appFileUrl: string | undefined;
  consentGranted: boolean;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
  mediaType?: string;
}

export function grantsMediaPermission(input: MediaPermissionInput): boolean {
  if (input.permission !== 'media') return false;
  if (!input.consentGranted || !input.isMainFrame) return false;
  if (!isVideoOnly(input.mediaTypes, input.mediaType)) return false;
  return isAppDocument(input.requestingUrl, input.appFileUrl);
}

function isVideoOnly(mediaTypes: readonly string[] | undefined, mediaType: string | undefined): boolean {
  if (mediaTypes) return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'video');
  return mediaType === 'video';
}

function isAppDocument(requestingUrl: string | undefined, appFileUrl: string | undefined): boolean {
  if (!requestingUrl || !appFileUrl) return false;
  try {
    const page = new URL(requestingUrl);
    const app = new URL(appFileUrl);
    return page.protocol === 'file:' && app.protocol === 'file:' && page.pathname === app.pathname;
  } catch {
    return false;
  }
}
