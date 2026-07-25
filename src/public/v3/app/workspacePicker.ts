interface ElectronWorkspaceApi {
  showOpenDialog?: (options: {
    title: string;
    buttonLabel?: string;
    properties: string[];
  }) => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

export class WorkspacePickerUnavailableError extends Error {
  constructor() {
    super('The native folder picker is unavailable');
    this.name = 'WorkspacePickerUnavailableError';
  }
}

export async function pickWorkspaceFolder(
  title: string,
  buttonLabel: string,
): Promise<string | null> {
  const api = (window as typeof window & { electronAPI?: ElectronWorkspaceApi }).electronAPI;
  if (!api?.showOpenDialog) throw new WorkspacePickerUnavailableError();

  const result = await api.showOpenDialog({
    title,
    buttonLabel,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  const path = result.filePaths[0]?.trim();
  return path || null;
}

export function workspaceNameFromPath(rootPath: string): string {
  const normalized = rootPath.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
}
