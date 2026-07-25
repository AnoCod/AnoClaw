import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppLifecycleController,
  type AppLifecycleDependencies,
} from '../AppLifecycleController.js';

function createDependencies(
  overrides: Partial<AppLifecycleDependencies> = {},
): AppLifecycleDependencies {
  return {
    quit: vi.fn(),
    forceExit: vi.fn(),
    listWindows: vi.fn(() => []),
    hideFloatingBall: vi.fn(),
    markQuitting: vi.fn(),
    gracefulShutdown: vi.fn(async () => undefined),
    reportError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AppLifecycleController', () => {
  it('keeps the app alive while the setup window transitions to the main window', () => {
    const dependencies = createDependencies();
    const lifecycle = new AppLifecycleController(dependencies);

    lifecycle.setSetupTransitionInProgress(true);
    lifecycle.handleAllWindowsClosed();
    expect(dependencies.quit).not.toHaveBeenCalled();

    lifecycle.setSetupTransitionInProgress(false);
    lifecycle.handleAllWindowsClosed();
    expect(dependencies.quit).toHaveBeenCalledOnce();
  });

  it('hides every visible surface immediately when quit is requested', () => {
    const visibleWindow = { hide: vi.fn(), isDestroyed: vi.fn(() => false) };
    const destroyedWindow = { hide: vi.fn(), isDestroyed: vi.fn(() => true) };
    const dependencies = createDependencies({
      listWindows: vi.fn(() => [visibleWindow, destroyedWindow]),
    });
    const lifecycle = new AppLifecycleController(dependencies);

    lifecycle.requestQuit();

    expect(dependencies.markQuitting).toHaveBeenCalledOnce();
    expect(dependencies.hideFloatingBall).toHaveBeenCalledOnce();
    expect(visibleWindow.hide).toHaveBeenCalledOnce();
    expect(destroyedWindow.hide).not.toHaveBeenCalled();
    expect(dependencies.quit).toHaveBeenCalledOnce();
  });

  it('finishes graceful shutdown before allowing Electron to quit', async () => {
    const dependencies = createDependencies();
    const lifecycle = new AppLifecycleController(dependencies);
    const event = { preventDefault: vi.fn() };

    lifecycle.handleBeforeQuit(event);
    await vi.waitFor(() => expect(dependencies.quit).toHaveBeenCalledOnce());

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dependencies.gracefulShutdown).toHaveBeenCalledOnce();
    expect(dependencies.forceExit).not.toHaveBeenCalled();
  });

  it('forces process exit if graceful shutdown hangs', async () => {
    vi.useFakeTimers();
    const dependencies = createDependencies({
      gracefulShutdown: vi.fn(() => new Promise<void>(() => undefined)),
      quitTimeoutMs: 50,
    });
    const lifecycle = new AppLifecycleController(dependencies);

    lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);

    expect(dependencies.forceExit).toHaveBeenCalledWith(0);
    expect(dependencies.reportError).toHaveBeenCalledWith(
      'Graceful shutdown exceeded 50ms; forcing process exit',
    );
  });
});
