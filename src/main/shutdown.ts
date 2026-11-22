// What: routes window close, quit, and consent revocation through one stop function.
// Why: every route must drain the camera and close the header before the process or window exits.
// Removed: a trigger could forget to stop, or quit before the final sample write landed.
export interface ShutdownEvent {
  preventDefault(): void;
}

export interface ShutdownDependencies {
  stop(): Promise<unknown>;
  hasActive(): boolean;
  quit(): void;
}

export interface ShutdownHooks {
  beginStart(): void;
  captureAllowed(): boolean;
  onWindowAllClosed(): void;
  onConsentRevoked(): void;
  onBeforeQuit(event: ShutdownEvent): void;
}

export function createShutdownHooks(deps: ShutdownDependencies): ShutdownHooks {
  let captureDesired = false;
  let quitting = false;
  let exitAllowed = false;
  const beginStop = (): Promise<unknown> => {
    captureDesired = false;
    return deps.stop().catch(() => undefined);
  };

  return {
    beginStart() {
      if (quitting) return;
      captureDesired = true;
      exitAllowed = false;
    },
    captureAllowed() {
      return captureDesired;
    },
    onWindowAllClosed() {
      void beginStop();
    },
    onConsentRevoked() {
      void beginStop();
    },
    onBeforeQuit(event) {
      if (exitAllowed) return;
      if (!deps.hasActive()) {
        exitAllowed = true;
        return;
      }
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void beginStop().finally(() => {
        exitAllowed = true;
        deps.quit();
      });
    },
  };
}
