export interface QuitEvent {
  preventDefault(): void;
}

export interface LifecycleWindow {
  hide(): void;
  isDestroyed?(): boolean;
}

export interface AppLifecycleDependencies {
  quit(): void;
  forceExit(exitCode: number): void;
  listWindows(): LifecycleWindow[];
  markQuitting(): void;
  gracefulShutdown(): Promise<void>;
  quitTimeoutMs?: number;
  reportError?(message: string, error?: unknown): void;
}

const DEFAULT_QUIT_TIMEOUT_MS = 10_000;

/**
 * Coordinates Electron's setup-to-main-window transition and graceful exit.
 * Keeping this state outside main.ts makes the window lifecycle deterministic
 * and independently testable.
 */
export class AppLifecycleController {
  private setupTransitionInProgress = false;
  private gracefulQuitStarted = false;
  private gracefulQuitComplete = false;
  private readonly quitTimeoutMs: number;

  constructor(private readonly dependencies: AppLifecycleDependencies) {
    this.quitTimeoutMs = dependencies.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  }

  setSetupTransitionInProgress(inProgress: boolean): void {
    this.setupTransitionInProgress = inProgress;
  }

  requestQuit(): void {
    this.prepareVisibleStateForQuit();
    this.dependencies.quit();
  }

  handleAllWindowsClosed(): void {
    if (!this.setupTransitionInProgress) {
      this.dependencies.quit();
    }
  }

  handleBeforeQuit(event: QuitEvent): void {
    this.prepareVisibleStateForQuit();
    if (this.gracefulQuitComplete) return;

    event.preventDefault();
    if (this.gracefulQuitStarted) return;
    this.gracefulQuitStarted = true;

    let forceExitStarted = false;
    const timeout = setTimeout(() => {
      forceExitStarted = true;
      this.dependencies.reportError?.(
        `Graceful shutdown exceeded ${this.quitTimeoutMs}ms; forcing process exit`,
      );
      this.dependencies.forceExit(0);
    }, this.quitTimeoutMs);

    void this.dependencies.gracefulShutdown()
      .catch((error) => {
        this.dependencies.reportError?.('Graceful shutdown failed', error);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (forceExitStarted) return;
        this.gracefulQuitComplete = true;
        this.dependencies.quit();
      });
  }

  private prepareVisibleStateForQuit(): void {
    this.dependencies.markQuitting();
    for (const window of this.dependencies.listWindows()) {
      try {
        if (!window.isDestroyed?.()) window.hide();
      } catch {
        // The window may have been destroyed between enumeration and hide().
      }
    }
  }
}
