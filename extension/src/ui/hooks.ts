/**
 * React hooks shared by the extension's pages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionState } from "../shared/protocol.js";
import { applyAppearance, getState, onStateChanged } from "./shared.js";

/**
 * The extension's state, kept in sync with the worker.
 *
 * Loading is tracked explicitly because every page needs to distinguish "no
 * profile yet" from "not loaded yet", and conflating them produces a flash of
 * the empty state on every open.
 */
export function useExtensionState(): {
  state?: ExtensionState;
  loading: boolean;
  error?: string;
  reload: () => Promise<void>;
  update: (state: ExtensionState) => void;
} {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    try {
      const next = await getState();
      setState(next);
      applyAppearance(next.settings.appearance);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取数据");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return onStateChanged((next) => {
      setState(next);
      applyAppearance(next.settings.appearance);
    });
  }, [reload]);

  return { ...(state ? { state } : {}), loading, ...(error ? { error } : {}), reload, update: setState };
}

/**
 * Follow the OS colour scheme so a `system` preference updates live.
 */
export function useSystemAppearance(): "light" | "dark" {
  const query = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(query.matches);

  useEffect(() => {
    const listener = (event: MediaQueryListEvent): void => setDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [query]);

  return dark ? "dark" : "light";
}

/**
 * A toast queue. Returns the current toast and a `show` function; each toast
 * auto-dismisses, and a new one replaces the last so the region never stacks.
 */
export function useToast(): {
  toast?: { text: string; tone: "neutral" | "success" | "error" };
  show: (text: string, tone?: "neutral" | "success" | "error") => void;
} {
  const [toast, setToast] = useState<{ text: string; tone: "neutral" | "success" | "error" } | undefined>();
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((text: string, tone: "neutral" | "success" | "error" = "neutral") => {
    window.clearTimeout(timer.current);
    setToast({ text, tone });
    timer.current = window.setTimeout(() => setToast(undefined), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { ...(toast ? { toast } : {}), show };
}

/**
 * Debounce a rapidly-changing value (a search box) so the expensive work
 * downstream runs once the person pauses.
 */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Persist a value to chrome.storage under a key, read on mount. Used for
 * UI-only preferences (active tab, sort order) that do not belong in Settings.
 */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    void chrome.storage.local.get(key).then((result) => {
      const stored = result[key];
      if (stored !== undefined) setValue(stored as T);
    });
  }, [key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      void chrome.storage.local.set({ [key]: next });
    },
    [key],
  );

  return [value, update];
}
