/** Built-ins-only private IPC lifecycle; decoded views still require application admission. */
export const OBSERVER_BOOTSTRAP_MODE = "observer-runtime-bootstrap-v1";
export const OBSERVER_BOOTSTRAP_BYTES = 18 * 1024;

export const CONTEXT_BOOTSTRAP_MODE = "correspondence-context-runtime-bootstrap-v1";
// Native complete C input is <= 1,000,000 bytes; one extra H is smaller. Add
// the <=16 KiB observer view and ownership coordinates, rounded up to 1 MiB.
export const CONTEXT_BOOTSTRAP_BYTES = 1024 * 1024;
export function contextBootstrapEnvelope(identity, pid, deadline, context, view) {
  const message = { kind: CONTEXT_BOOTSTRAP_MODE, identity, pid, deadline, context, view: view ?? null };
  assertObserverBootstrapEnvelope(message, identity, pid, deadline, CONTEXT_BOOTSTRAP_MODE);
  return message;
}

export function observerBootstrapEnvelope(identity, pid, deadline, view) {
  const message = { kind: OBSERVER_BOOTSTRAP_MODE, identity, pid, deadline, view };
  assertObserverBootstrapEnvelope(message, identity, pid, deadline);
  return message;
}

export function assertObserverBootstrapEnvelope(message, identity, pid, deadline, mode = OBSERVER_BOOTSTRAP_MODE) {
  const context = mode === CONTEXT_BOOTSTRAP_MODE;
  if (message === null || typeof message !== "object" || Array.isArray(message) ||
      Object.keys(message).sort().join(",") !== (context ? "context,deadline,identity,kind,pid,view" : "deadline,identity,kind,pid,view") ||
      message.kind !== mode || message.identity !== identity || message.pid !== pid ||
      message.deadline !== deadline || !Number.isSafeInteger(deadline) || deadline <= Date.now() ||
      Buffer.byteLength(JSON.stringify(message), "utf8") > (context ? CONTEXT_BOOTSTRAP_BYTES : OBSERVER_BOOTSTRAP_BYTES)) {
    throw new Error("invalid acquisition runtime bootstrap");
  }
}

/** Install before acknowledgement. Consumed state remains live until explicit process drain. */
export function acquisitionRuntimeChannel({ identity, deadline, observer, context = false, channel = process }) {
  const caller = new AbortController();
  let consumed = false, resolveView, rejectView;
  const view = observer || context ? new Promise((resolve, reject) => { resolveView = resolve; rejectView = reject; }) : Promise.resolve(undefined);
  // A cancellation can precede the caller awaiting bootstrap.
  void view.catch(() => {});
  const stop = reason => {
    caller.abort(new Error(reason));
    rejectView?.(caller.signal.reason);
  };
  const message = value => {
    if (value?.kind === "cancel_source_acquisition") { stop("acquisition caller cancelled"); return; }
    if (!observer && !context) return;
    try {
      if (consumed || caller.signal.aborted) throw new Error("duplicate or cancelled acquisition runtime bootstrap");
      assertObserverBootstrapEnvelope(value, identity, channel.pid, deadline, context ? CONTEXT_BOOTSTRAP_MODE : OBSERVER_BOOTSTRAP_MODE);
      consumed = true;
      resolveView(context ? { queryRevisionObserverView: value.view ?? undefined, correspondenceGenerationContext: value.context } : value.view);
    } catch { stop("invalid acquisition runtime bootstrap"); }
  };
  const disconnect = () => stop("acquisition runtime channel disconnected");
  const timer = setTimeout(() => stop("acquisition runtime deadline expired"), Math.max(1, deadline - Date.now()));
  channel.on("message", message);
  channel.on("disconnect", disconnect);
  return { signal: caller.signal, view, dispose() {
    clearTimeout(timer); channel.off("message", message); channel.off("disconnect", disconnect);
  } };
}
