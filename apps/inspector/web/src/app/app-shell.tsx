import { BrowserRouter } from "react-router-dom";
import CommandPalette from "../components/command-palette";
import SessionExpired from "../components/session-expired";
import { ToastProvider } from "../components/toast";
import { LocaleProvider } from "../i18n/locale";
import { InspectorRoutes } from "./app-routes";
import { useInspectorLaunchState } from "./inspector-launch-state";
import type { InspectorLaunchState } from "./inspector-launch-state";

export function InspectorAppShell(props: { readonly state: InspectorLaunchState }) {
  if (props.state.sessionExpired) return <SessionExpired />;
  if (props.state.authError) return <AuthenticationRequired message={props.state.authError} />;
  if (!props.state.ready) return <InspectorLoading />;
  return (
    <>
      <InspectorRoutes />
      <CommandPalette open={props.state.paletteOpen} onClose={props.state.closePalette} />
    </>
  );
}

export function InspectorProviders() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <ToastProvider>
          <InspectorAppContent />
        </ToastProvider>
      </LocaleProvider>
    </BrowserRouter>
  );
}

function InspectorAppContent() {
  const state = useInspectorLaunchState();
  return <InspectorAppShell state={state} />;
}

function AuthenticationRequired(props: { readonly message: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-beige-100 p-8 text-center">
      <h1 className="text-2xl font-bold text-ink-600 mb-4 font-mono uppercase tracking-widest">
        Authentication Required
      </h1>
      <p className="text-ink-700 max-w-md font-mono text-sm leading-relaxed">
        {props.message}
      </p>
      <div className="mt-8 pt-8 border-t border-beige-300 w-full max-w-xs">
        <code className="text-xs text-ink-500">ERROR_CODE: AUTH_MISSING_TOKEN</code>
      </div>
    </div>
  );
}

function InspectorLoading() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-beige-100">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-2 border-ink-600/20 border-t-ink-600 rounded-full animate-spin" />
        <p className="text-ink-600 font-mono text-xs uppercase tracking-widest">
          Loading Inspector Surface...
        </p>
      </div>
    </div>
  );
}
