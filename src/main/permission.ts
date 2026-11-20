// What: decides whether a page may open the camera.
// Why: consent and the page origin are checked in the main process, so the page cannot skip them.
// Removed: a remote document, the dev server, a subframe, or a microphone request could receive media.
export interface MediaPermissionInput {
  permission: string;
  requestingUrl: string | undefined;
  consentGranted: boolean;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
  mediaType?: string;
}

export function grantsMediaPermission(input: MediaPermissionInput): boolean {
  if (input.permission !== 'media') return false;
  if (!input.consentGranted || !input.isMainFrame) return false;
  if (!isVideoOnly(input.mediaTypes, input.mediaType)) return false;
  return isFilePage(input.requestingUrl);
}

function isVideoOnly(mediaTypes: readonly string[] | undefined, mediaType: string | undefined): boolean {
  if (mediaTypes) return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'video');
  return mediaType === 'video';
}

function isFilePage(requestingUrl: string | undefined): boolean {
  if (!requestingUrl) return false;
  try {
    return new URL(requestingUrl).protocol === 'file:';
  } catch {
    return false;
  }
}
