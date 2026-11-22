// What: authorizes the frame allowed to call the app's invoke channels.
// Why: a navigated file: page would otherwise inherit the preload bridge and reach destructive handlers.
// Removed: a different local page could delete a session or export a report.
import type { IpcMainInvokeEvent } from 'electron';

let allowed: { appFileUrl: string; devOrigin?: string } | null = null;

export function configureIpcSender(config: { appFileUrl: string; devOrigin?: string }): void {
  allowed = config;
}

export function isAuthorizedSender(event: IpcMainInvokeEvent): boolean {
  if (!allowed) return true;
  const url = event.senderFrame?.url;
  if (!url) return false;
  if (url === allowed.appFileUrl) return true;
  if (allowed.devOrigin) {
    try {
      if (new URL(url).origin === new URL(allowed.devOrigin).origin) return true;
    } catch {
      return false;
    }
  }
  return false;
}
