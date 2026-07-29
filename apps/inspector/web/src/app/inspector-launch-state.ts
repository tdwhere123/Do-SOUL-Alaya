import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
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

export function useInspectorLaunchState(): InspectorLaunchState {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = () => setPaletteOpen((prev) => !prev);
  useCommandPaletteHotkey(paletteOpen, togglePalette);

  useEffect(() => {
    let cancelled = false;
    void bootstrapInspectorSession(readLaunchParams(searchParams), {
      cancelled: () => cancelled,
      setAuthError,
      setReady
    });
    setUnauthorizedHandler(() => setSessionExpired(true));
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, [location.search, searchParams]);

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
    readonly setAuthError: (error: string | null) => void;
    readonly setReady: (ready: boolean) => void;
  }
): Promise<void> {
  if (launchParams.launchCode) {
    const token = await redeemLaunchCode(launchParams.launchCode);
    if (callbacks.cancelled()) {
      return;
    }
    if (token === null) {
      callbacks.setAuthError("Launch code expired or invalid. Please run `alaya inspect` again.");
      callbacks.setReady(false);
      return;
    }
    setInspectorToken(token);
    setWorkspaceId(launchWorkspaceId(launchParams.workspaceId));
    clearLaunchQueryParam();
    callbacks.setAuthError(null);
    callbacks.setReady(true);
    return;
  }

  if (getInspectorToken()) {
    callbacks.setAuthError(null);
    callbacks.setReady(true);
    return;
  }

  callbacks.setAuthError("No session found. Please run `alaya inspect` to open this tool.");
  callbacks.setReady(false);
}

async function redeemLaunchCode(code: string): Promise<string | null> {
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

function readLaunchParams(searchParams: URLSearchParams): {
  readonly launchCode: string | null;
  readonly workspaceId: string | null;
} {
  return {
    launchCode: searchParams.get("launch"),
    workspaceId: searchParams.get("workspaceId")
  };
}

function launchWorkspaceId(value: string | null): string | null {
  return value?.trim().length ? value : null;
}

function clearLaunchQueryParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("launch")) {
    return;
  }
  url.searchParams.delete("launch");
  const nextSearch = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${nextSearch.length > 0 ? `?${nextSearch}` : ""}`);
}
