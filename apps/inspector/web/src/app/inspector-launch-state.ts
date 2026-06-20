import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  getInspectorToken,
  setInspectorToken,
  setUnauthorizedHandler,
  setWorkspaceId
} from "../api";
import { useCommandPaletteHotkey } from "../components/CommandPalette";

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
    applyLaunchParams(readLaunchParams(searchParams, location.hash), setAuthError, setReady);
    setUnauthorizedHandler(() => setSessionExpired(true));
    return () => setUnauthorizedHandler(null);
  }, [location.hash, searchParams]);

  return {
    authError,
    closePalette: () => setPaletteOpen(false),
    paletteOpen,
    ready,
    sessionExpired,
    togglePalette
  };
}

function applyLaunchParams(
  launchParams: { readonly token: string | null; readonly workspaceId: string | null },
  setAuthError: (error: string | null) => void,
  setReady: (ready: boolean) => void
) {
  if (launchParams.token) {
    setInspectorToken(launchParams.token);
    setWorkspaceId(launchWorkspaceId(launchParams.workspaceId));
    clearTokenFragment();
    setAuthError(null);
    setReady(true);
  } else if (getInspectorToken()) {
    setAuthError(null);
    setReady(true);
  } else {
    setAuthError("No token found in URL. Please run `alaya inspect` to open this tool.");
  }
}

function readLaunchParams(searchParams: URLSearchParams, hash: string): {
  readonly token: string | null;
  readonly workspaceId: string | null;
} {
  const hashParams = new URLSearchParams(hash.replace(/^#/u, ""));
  return {
    token: hashParams.get("token"),
    workspaceId: searchParams.get("workspaceId") ?? hashParams.get("workspaceId")
  };
}

function launchWorkspaceId(value: string | null): string | null {
  return value?.trim().length ? value : null;
}

function clearTokenFragment(): void {
  if (!window.location.hash.includes("token=")) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
