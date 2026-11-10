/**
 * Workbench state.
 *
 * One context holding the whole store, because the views are genuinely
 * interdependent: the ledger shows which report was used, the tailor view
 * writes records, and the resume view is the source for both. Splitting it by
 * view would mean duplicating the reload logic four times.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { JSX } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@quill/core";
import { getStore, type WorkbenchState } from "./data/store.js";

interface Context {
  state: WorkbenchState;
  loading: boolean;
  error?: string;
  /** Re-read everything from storage. */
  reload: () => Promise<void>;
  /** Apply a partial state patch locally (after a known-good mutation). */
  patch: (patch: Partial<WorkbenchState>) => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Set while a long operation runs, so actions can disable themselves. */
  pending?: string;
  setPending: (pending?: string) => void;
}

const WorkbenchContext = createContext<Context | undefined>(undefined);

const EMPTY: WorkbenchState = {
  profiles: [],
  documents: [],
  memory: [],
  analyses: [],
  reports: [],
  records: [],
  settings: DEFAULT_SETTINGS,
};

export function WorkbenchProvider({ children }: { children: ReactNode }): JSX.Element {
  const store = useMemo(() => getStore(), []);
  const [state, setState] = useState<WorkbenchState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<string | undefined>();

  const reload = useCallback(async () => {
    try {
      setState(await store.load());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取本地数据");
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void reload();
    // Inside the extension the worker broadcasts every mutation, so a fill in
    // another tab lands here without a manual refresh.
    return store.subscribe?.((next) => setState(next));
  }, [reload, store]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...state.settings, ...patch };
      setState((current) => ({ ...current, settings: next }));
      await store.saveSettings(next);
    },
    [state.settings, store],
  );

  const value = useMemo<Context>(
    () => ({
      state,
      loading,
      ...(error ? { error } : {}),
      reload,
      patch: (patch) => setState((current) => ({ ...current, ...patch })),
      updateSettings,
      ...(pending ? { pending } : {}),
      setPending,
    }),
    [state, loading, error, reload, updateSettings, pending],
  );

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): Context {
  const context = useContext(WorkbenchContext);
  if (!context) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return context;
}

/** Apply the appearance preference to the document, following the OS. */
export function useAppearance(): void {
  const { state } = useWorkbench();
  const { appearance } = state.settings;

  useEffect(() => {
    const root = document.documentElement;
    if (appearance === "system") root.removeAttribute("data-appearance");
    else root.dataset.appearance = appearance;
  }, [appearance]);
}

/** A toast queue shared across views. */
export function useToastQueue(): {
  toast?: { text: string; tone: "neutral" | "success" | "error" };
  show: (text: string, tone?: "neutral" | "success" | "error") => void;
} {
  const [toast, setToast] = useState<{ text: string; tone: "neutral" | "success" | "error" }>();
  const show = useCallback((text: string, tone: "neutral" | "success" | "error" = "neutral") => {
    setToast({ text, tone });
    window.setTimeout(() => setToast(undefined), 2800);
  }, []);
  return { ...(toast ? { toast } : {}), show };
}
