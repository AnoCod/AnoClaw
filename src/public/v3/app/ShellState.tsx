import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { V3ApiClient } from '../api/V3ApiClient.js';
import { V3RealtimeClient } from '../api/V3RealtimeClient.js';
import type {
  Locale,
  Session,
  ShellSnapshot,
  Work,
  WorkDetail,
  Workspace,
  VerificationCriterionResult,
} from '../model.js';
import { findPrimarySession } from './sessionTransparency.js';

const SELECTED_WORK_KEY = 'anoclaw.v3.selectedWorkId';
const api = new V3ApiClient();

interface ShellStateValue {
  snapshot: ShellSnapshot;
  selectedWork: Work | null;
  selectedWorkDetail: WorkDetail | null;
  selectedSession: Session | null;
  loading: boolean;
  detailLoading: boolean;
  error: Error | null;
  busyAction: string | null;
  selectWork: (workId: string) => void;
  reload: () => Promise<void>;
  createCompany: (name: string, description?: string, defaultLocale?: Locale) => Promise<void>;
  updateCompanyLocale: (locale: Locale) => Promise<void>;
  createWorkspace: (name: string, rootPath: string, description?: string) => Promise<Workspace>;
  createWork: (title: string, objective: string, workspaceId?: string) => Promise<void>;
  toggleSelectedWork: () => Promise<void>;
  verifyTask: (
    taskId: string,
    outcome: 'approved' | 'revision_required',
    summary: string,
    criteria: VerificationCriterionResult[],
  ) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
}

const EMPTY_SNAPSHOT: ShellSnapshot = {
  company: null,
  companyRevision: 0,
  workspaces: [],
  teams: [],
  memberships: [],
  agents: [],
  works: [],
  worksRevision: 0,
  companyEvents: [],
};

const ShellStateContext = createContext<ShellStateValue | null>(null);

export function ShellStateProvider({ children }: { children: ComponentChildren }) {
  const [snapshot, setSnapshot] = useState<ShellSnapshot>(EMPTY_SNAPSHOT);
  const selectedWorkIdRef = useRef<string | null>(readSelectedWorkId());
  const selectedWorkRef = useRef<Work | null>(null);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(selectedWorkIdRef.current);
  const [selectedWorkDetail, setSelectedWorkDetail] = useState<WorkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const realtime = useRef<V3RealtimeClient | null>(null);
  const realtimeRefreshTimer = useRef<number | null>(null);

  const selectedWork = useMemo(
    () => snapshot.works.find((work) => work.id === selectedWorkId) ?? null,
    [snapshot.works, selectedWorkId],
  );
  const selectedSession = useMemo(
    () => selectedWork
      ? findPrimarySession(selectedWork, selectedWorkDetail?.sessions ?? []) ?? null
      : null,
    [selectedWork, selectedWorkDetail],
  );
  selectedWorkRef.current = selectedWork;

  const chooseWork = useCallback((works: Work[], requested: string | null) => {
    const chosen = works.find((work) => work.id === requested)
      ?? newest(
        works.filter((work) => !['archived', 'cancelled'].includes(work.status)),
        (work) => work.updatedAt,
      )
      ?? newest(works, (work) => work.updatedAt)
      ?? null;
    setSelectedWorkId(chosen?.id ?? null);
    selectedWorkIdRef.current = chosen?.id ?? null;
    writeSelectedWorkId(chosen?.id ?? null);
  }, []);

  const loadShell = useCallback(async () => {
    setError(null);
    try {
      const next = await api.loadShell();
      setSnapshot(next);
      chooseWork(next.works, selectedWorkIdRef.current);
    } catch (nextError) {
      setError(asError(nextError));
    } finally {
      setLoading(false);
    }
  }, [chooseWork]);

  const loadSelectedWork = useCallback(async (work: Work | null) => {
    const request = ++detailRequest.current;
    if (!work) {
      setSelectedWorkDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const detail = await api.loadWork(work);
      if (request === detailRequest.current) setSelectedWorkDetail(detail);
    } catch (nextError) {
      if (request === detailRequest.current) setError(asError(nextError));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadShell();
  }, []);

  useEffect(() => {
    void loadSelectedWork(selectedWork);
  }, [selectedWork?.id]);

  useEffect(() => {
    const client = new V3RealtimeClient(() => {
      if (realtimeRefreshTimer.current !== null) {
        window.clearTimeout(realtimeRefreshTimer.current);
      }
      realtimeRefreshTimer.current = window.setTimeout(() => {
        realtimeRefreshTimer.current = null;
        const activeWork = selectedWorkRef.current;
        void Promise.all([
          loadShell(),
          activeWork ? loadSelectedWork(activeWork) : Promise.resolve(),
        ]);
      }, 80);
    });
    realtime.current = client;
    client.start({
      companyAfterRevision: snapshot.companyRevision,
      works: selectedWork
        ? [{ workId: selectedWork.id, afterRevision: selectedWorkDetail?.revision ?? 0 }]
        : [],
    });
    return () => {
      client.stop();
      realtime.current = null;
      if (realtimeRefreshTimer.current !== null) {
        window.clearTimeout(realtimeRefreshTimer.current);
        realtimeRefreshTimer.current = null;
      }
    };
  }, [loadSelectedWork, loadShell]);

  useEffect(() => {
    realtime.current?.update({
      companyAfterRevision: snapshot.companyRevision,
      works: selectedWork
        ? [{ workId: selectedWork.id, afterRevision: selectedWorkDetail?.revision ?? 0 }]
        : [],
    });
  }, [
    snapshot.companyRevision,
    selectedWork?.id,
    selectedWorkDetail?.revision,
  ]);

  const value = useMemo<ShellStateValue>(() => ({
    snapshot,
    selectedWork,
    selectedWorkDetail,
    selectedSession,
    loading,
    detailLoading,
    error,
    busyAction,
    selectWork(workId) {
      if (!snapshot.works.some((work) => work.id === workId)) return;
      setSelectedWorkId(workId);
      selectedWorkIdRef.current = workId;
      writeSelectedWorkId(workId);
    },
    async reload() {
      setLoading(true);
      await loadShell();
    },
    async createCompany(name, description, defaultLocale) {
      await runAction('create-company', async () => {
        await api.createCompany(name, description, defaultLocale);
        await loadShell();
      }, setBusyAction, setError);
    },
    async updateCompanyLocale(locale) {
      if (!snapshot.company || snapshot.company.defaultLocale === locale) return;
      await runAction('update-company-locale', async () => {
        await api.updateCompanyLocale(locale, snapshot.companyRevision);
        await loadShell();
      }, setBusyAction, setError);
    },
    async createWorkspace(name, rootPath, description) {
      let workspace: Workspace | null = null;
      await runAction('create-workspace', async () => {
        const result = await api.createWorkspace(
          {
            name,
            rootPath,
            ...(description ? { description } : {}),
          },
          snapshot.companyRevision,
        );
        workspace = result.data;
        await loadShell();
      }, setBusyAction, setError);
      if (!workspace) throw new Error('Workspace creation did not complete');
      return workspace;
    },
    async createWork(title, objective, workspaceId) {
      await runAction('create-work', async () => {
        const result = await api.createWork({
          title,
          objective,
          ...(workspaceId ? { workspaceId } : {}),
        });
        setSelectedWorkId(result.data.id);
        selectedWorkIdRef.current = result.data.id;
        writeSelectedWorkId(result.data.id);
        await loadShell();
      }, setBusyAction, setError);
    },
    async toggleSelectedWork() {
      if (!selectedWork || !selectedWorkDetail) return;
      await runAction('toggle-work', async () => {
        const status = selectedWork.status === 'paused' ? 'active' : 'paused';
        await api.updateWork(selectedWork.id, { status }, selectedWorkDetail.revision);
        await loadShell();
        await loadSelectedWork({ ...selectedWork, status });
      }, setBusyAction, setError);
    },
    async verifyTask(taskId, outcome, summary, criteria) {
      if (!selectedWork || !selectedWorkDetail) return;
      await runAction(`verify-task:${taskId}`, async () => {
        await api.verifyTask(
          taskId,
          { outcome, summary, criteria },
          selectedWorkDetail.revision,
        );
        await loadShell();
        await loadSelectedWork(selectedWork);
      }, setBusyAction, setError);
    },
    async sendMessage(content) {
      if (!selectedWork || !selectedWorkDetail || !selectedSession) return;
      await runAction('send-message', async () => {
        await api.appendUserMessage(
          selectedSession.id,
          content,
          selectedWorkDetail.transcriptRevision,
        );
        await loadSelectedWork(selectedWork);
      }, setBusyAction, setError);
    },
  }), [
    snapshot,
    selectedWork,
    selectedWorkDetail,
    selectedSession,
    loading,
    detailLoading,
    error,
    busyAction,
    loadShell,
    loadSelectedWork,
  ]);

  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
}

export function useShellState(): ShellStateValue {
  const value = useContext(ShellStateContext);
  if (!value) throw new Error('useShellState must be used inside ShellStateProvider');
  return value;
}

async function runAction(
  name: string,
  action: () => Promise<void>,
  setBusy: (value: string | null) => void,
  setError: (value: Error | null) => void,
): Promise<void> {
  setBusy(name);
  setError(null);
  try {
    await action();
  } catch (error) {
    setError(asError(error));
    throw error;
  } finally {
    setBusy(null);
  }
}

function newest<T>(entries: T[], date: (entry: T) => string): T | undefined {
  return [...entries].sort((a, b) => Date.parse(date(b)) - Date.parse(date(a)))[0];
}

function readSelectedWorkId(): string | null {
  try {
    return localStorage.getItem(SELECTED_WORK_KEY);
  } catch {
    return null;
  }
}

function writeSelectedWorkId(workId: string | null): void {
  try {
    if (workId) localStorage.setItem(SELECTED_WORK_KEY, workId);
    else localStorage.removeItem(SELECTED_WORK_KEY);
  } catch {
    // Selection remains valid for this run.
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
