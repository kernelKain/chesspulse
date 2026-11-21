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
  onWindowAllClosed(): void;
  onConsentRevoked(): void;
  onBeforeQuit(event: ShutdownEvent): void;
}

export function createShutdownHooks(deps: ShutdownDependencies): ShutdownHooks {
  let quitting = false;
  const beginStop = (): Promise<unknown> => deps.stop().catch(() => undefined);

  return {
    onWindowAllClosed() {
      void beginStop();
    },
    onConsentRevoked() {
      void beginStop();
    },
    onBeforeQuit(event) {
      if (quitting || !deps.hasActive()) return;
      event.preventDefault();
      quitting = true;
      void beginStop().finally(() => deps.quit());
    },
  };
}
