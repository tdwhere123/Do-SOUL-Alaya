import { useEffect, useState } from "react";
import {
  useLocation,
  useNavigate,
  useSearchParams,
  type NavigateFunction,
  type SetURLSearchParams
} from "react-router-dom";
import {
  getInspectorToken,
  setInspectorToken,
  setUnauthorizedHandler,
  setWorkspaceId
} from "../api";
import { useCommandPaletteHotkey } from "../components/command-palette";

export interface InspectorLaunchState {
  readonly authError: string | null;
  readonly paletteOpen: boolean;
  readonly ready: boolean;
  readonly sessionExpired: boolean;
  readonly closePalette: () => void;
  readonly togglePalette: () => void;
}

/** One redeem per code per page load — StrictMode remounts must share the same Promise. */
const redeemInFlight = new Map<string, Promise<string | null>>();

export function useInspectorLaunchState(): InspectorLaunchState {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = () => setPaletteOpen((prev) => !prev);
  useCommandPaletteHotkey(paletteOpen, togglePalette);

  useEffect(() => {
    let cancelled = false;
    void bootstrapInspectorSession(readLaunchParams(searchParams, location.hash), {
      cancelled: () => cancelled,
      clearLaunch: () => clearLaunchParams(setSearchParams, navigate, location.hash),
      setAuthError,
      setReady
    });
    setUnauthorizedHandler(() => setSessionExpired(true));
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, [location.hash, location.search, navigate, searchParams, setSearchParams]);

  return {
    authError,
    closePalette: () => setPaletteOpen(false),
    paletteOpen,
    ready,
    sessionExpired,
    togglePalette
  };
}

async function bootstrapInspectorSession(
  launchParams: { readonly launchCode: string | null; readonly workspaceId: string | null },
  callbacks: {
    readonly cancelled: () => boolean;
    readonly clearLaunch: () => void;
    readonly setAuthError: (error: string | null) => void;
    readonly setReady: (ready: boolean) => void;
  }
): Promise<void> {
  if (launchParams.launchCode) {
    const token = await redeemLaunchCode(launchParams.launchCode);
    if (token !== null) {
      // Persist before cancelled check — a successful redeem must not be discarded on remount.
      setInspectorToken(token);
      setWorkspaceId(launchWorkspaceId(launchParams.workspaceId));
      callbacks.clearLaunch();
      if (callbacks.cancelled()) {
        return;
      }
      callbacks.setAuthError(null);
      callbacks.setReady(true);
      return;
    }

    // Single-use code already consumed by a prior mount that persisted the token.
    if (getInspectorToken()) {
      if (launchParams.workspaceId !== null) {
        setWorkspaceId(launchWorkspaceId(launchParams.workspaceId));
      }
      callbacks.clearLaunch();
      if (callbacks.cancelled()) {
        return;
      }
      callbacks.setAuthError(null);
      callbacks.setReady(true);
      return;
    }

    if (callbacks.cancelled()) {
      return;
    }
    callbacks.setAuthError("Launch code expired or invalid. Please run `alaya inspect` again.");
    callbacks.setReady(false);
    return;
  }

  if (getInspectorToken()) {
    if (callbacks.cancelled()) {
      return;
    }
    callbacks.setAuthError(null);
    callbacks.setReady(true);
    return;
  }

  if (callbacks.cancelled()) {
    return;
  }
  callbacks.setAuthError("No session found. Please run `alaya inspect` to open this tool.");
  callbacks.setReady(false);
}

async function redeemLaunchCode(code: string): Promise<string | null> {
  const existing = redeemInFlight.get(code);
  if (existing !== undefined) {
    return existing;
  }

  const pending = performRedeem(code).finally(() => {
    redeemInFlight.delete(code);
  });
  redeemInFlight.set(code, pending);
  return pending;
}

async function performRedeem(code: string): Promise<string | null> {
  const response = await fetch("/api/launch-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { readonly token?: unknown };
  return typeof body.token === "string" && body.token.trim().length > 0 ? body.token : null;
}

function readLaunchParams(searchParams: URLSearchParams, hash: string): {
  readonly launchCode: string | null;
  readonly workspaceId: string | null;
} {
  const fragment = readFragmentParams(hash);
  return {
    launchCode: firstNonEmpty(searchParams.get("launch"), fragment.get("launch")),
    workspaceId: firstNonEmpty(searchParams.get("workspaceId"), fragment.get("workspaceId"))
  };
}

function readFragmentParams(hash: string): URLSearchParams {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(trimmed);
}

function firstNonEmpty(...values: Array<string | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function launchWorkspaceId(value: string | null): string | null {
  return value?.trim().length ? value : null;
}

function clearLaunchParams(
  setSearchParams: SetURLSearchParams,
  navigate: NavigateFunction,
  hash: string
): void {
  clearLaunchQueryParam(setSearchParams);
  const fragment = readFragmentParams(hash);
  if (!fragment.has("launch")) {
    return;
  }
  fragment.delete("launch");
  const next = fragment.toString();
  navigate({ hash: next.length === 0 ? "" : `#${next}` }, { replace: true });
}

function clearLaunchQueryParam(setSearchParams: SetURLSearchParams): void {
  setSearchParams(
    (prev) => {
      if (!prev.has("launch")) {
        return prev;
      }
      const next = new URLSearchParams(prev);
      next.delete("launch");
      return next;
    },
    { replace: true }
  );
}
