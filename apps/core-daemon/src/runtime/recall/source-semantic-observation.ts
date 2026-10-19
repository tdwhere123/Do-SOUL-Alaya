import type { AlayaDaemonRuntime, AlayaDaemonRuntimeOptions } from "@do-soul/alaya";
import type { SourceSemanticObservation, SourceSemanticObservationOptions } from "../recall-read-worker/source-semantic-observation.js";
export type { SourceSemanticObservation, SourceSemanticObservationOptions } from "../recall-read-worker/source-semantic-observation.js";

export type SourceSemanticObservedCall<T> = Readonly<{
  outcome: Readonly<{ status: "success"; value: T }> | Readonly<{ status: "failure"; error: unknown }>;
  observations: readonly SourceSemanticObservation[];
  status: "available" | "unavailable" | "not_observed" | "overflow";
}>;
export type SourceSemanticObservationScope = <T>(options: SourceSemanticObservationOptions,
  work: () => Promise<T>) => Promise<SourceSemanticObservedCall<T>>;
const runtimeScopes = new WeakMap<object, SourceSemanticObservationScope>();

/** Private bench composition boundary: construction and registry lookup share one module graph.
 * The package-owned runtime type also avoids separate source/dist nominal class declarations. */
export async function createSourceObservedRuntime(options: Omit<AlayaDaemonRuntimeOptions, "sourceSemanticObservations">):
Promise<Readonly<{ runtime: AlayaDaemonRuntime; observeSourceSemantics: SourceSemanticObservationScope }>> {
  const { createAlayaDaemonRuntime } = await import("../../index.js");
  const runtime = await createAlayaDaemonRuntime({ ...options, sourceSemanticObservations: true });
  return { runtime, observeSourceSemantics: (limits, work) => observeSourceSemanticsForRuntime(runtime, limits, work) };
}

/** Startup-only binding for the recall-measurement bench consumer; no raw client escape. */
export function bindSourceSemanticObservation(runtime: AlayaDaemonRuntime, scope: SourceSemanticObservationScope): void {
  runtimeScopes.set(runtime, scope);
}

/** Private Node friend entry. Use the SAME compiled module identity as createAlayaDaemonRuntime.
 * Explicitly opt in at startup, then wrap only the requested job's ordinary native calls.
 * No labels enter the worker. Work failures retain their original error and correlated observations. */
export async function observeSourceSemanticsForRuntime<T>(runtime: object, options: SourceSemanticObservationOptions,
  work: () => Promise<T>): Promise<SourceSemanticObservedCall<T>> {
  const scope = runtimeScopes.get(runtime);
  if (scope !== undefined) return await scope(options, work);
  try { return { outcome: { status: "success", value: await work() }, observations: [], status: "unavailable" }; }
  catch (error) { return { outcome: { status: "failure", error }, observations: [], status: "unavailable" }; }
}
