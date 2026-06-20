import { useCallback, useEffect, useState } from "react";

export type SectionKey = "soul" | "strategy" | "environment";

export interface ConfigPageState {
  readonly dirtySections: ReadonlySet<SectionKey>;
  readonly restartPending: boolean;
  readonly dismissRestart: () => void;
  readonly handleRestartRequired: () => void;
  readonly handleSectionDirtyChange: (key: SectionKey, dirty: boolean) => void;
}

export function useConfigPageState(): ConfigPageState {
  const [dirtySections, setDirtySections] = useState<Set<SectionKey>>(new Set());
  const [restartPending, setRestartPending] = useState(false);
  const handleSectionDirtyChange = useCallback((key: SectionKey, dirty: boolean) => {
    setDirtySections((previous) => nextDirtySections(previous, key, dirty));
  }, []);
  const handleRestartRequired = useCallback(() => setRestartPending(true), []);
  const dismissRestart = useCallback(() => setRestartPending(false), []);

  useBeforeUnloadDirty(dirtySections.size > 0);
  return {
    dirtySections,
    restartPending,
    dismissRestart,
    handleRestartRequired,
    handleSectionDirtyChange
  };
}

function useBeforeUnloadDirty(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Unsaved configuration changes will be lost.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

function nextDirtySections(
  previous: ReadonlySet<SectionKey>,
  key: SectionKey,
  dirty: boolean
): Set<SectionKey> {
  const next = new Set(previous);
  if (dirty) next.add(key);
  else next.delete(key);
  return next;
}
