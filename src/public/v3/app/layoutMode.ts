import { useEffect, useState } from 'preact/hooks';

export type LayoutMode = 'simple' | 'professional';

const STORAGE_KEY = 'anoclaw.v3.layoutMode';

export function useLayoutMode(): [LayoutMode, (mode: LayoutMode) => void] {
  const [mode, setModeState] = useState<LayoutMode>(readMode);

  useEffect(() => {
    document.documentElement.dataset.layout = mode;
  }, [mode]);

  return [mode, (next) => {
    setModeState(next);
    document.documentElement.dataset.layout = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The mode still applies for this run.
    }
  }];
}

function readMode(): LayoutMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'simple' ? 'simple' : 'professional';
  } catch {
    return 'professional';
  }
}
