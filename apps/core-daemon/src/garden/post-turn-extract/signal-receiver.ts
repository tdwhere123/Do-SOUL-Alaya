import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

export interface PostTurnSignalReceiveResult {
  readonly signal: Readonly<{
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly signal_state?: CandidateMemorySignal["signal_state"];
  }>;
  readonly triage_result?: "accepted" | "dropped" | "deferred" | "unknown";
  readonly materialization?: Readonly<{
    readonly created_objects: readonly Readonly<{
      readonly object_kind: string;
      readonly object_id: string;
    }>[];
    readonly success?: boolean;
    readonly target_kind?: string;
    readonly defer_class?: "source_grounding" | "write_path";
    readonly deferral?: "prewrite_unavailable" | "lease_busy";
  }> | null;
}

/** A snapshot is measured only after every candidate receipt is observed. */
export type SignalOutcomeCounts = Readonly<{
  failed_candidate_signals_count: number;
  unknown_candidate_signals_count: number;
  inflight_candidate_signals_count: number;
}>;

export function createSignalOutcomeCounter() {
  const failed = new Set<string>(), unknown = new Set<string>(), inflight = new Set<string>();
  return {
    observe(result: PostTurnSignalReceiveResult): void {
      const id = result.signal.signal_id;
      failed.delete(id); unknown.delete(id); inflight.delete(id);
      if (result.signal.signal_state === "materialization_unknown") unknown.add(id);
      else if (result.signal.signal_state === "compiled" && result.materialization === null) inflight.add(id);
      else if (result.signal.signal_state === "failed" || result.materialization?.success === false) failed.add(id);
    },
    snapshot(): SignalOutcomeCounts {
      return { failed_candidate_signals_count: failed.size, unknown_candidate_signals_count: unknown.size,
        inflight_candidate_signals_count: inflight.size };
    }
  };
}

export type SignalOutcomeCounter = ReturnType<typeof createSignalOutcomeCounter>;

export interface PostTurnSignalReceiver {
  receiveSignal(signal: CandidateMemorySignal): Promise<PostTurnSignalReceiveResult>;
}

export function isWritePathMaterializationDeferral(result: PostTurnSignalReceiveResult): boolean {
  return result.triage_result === "deferred"
    && result.materialization?.target_kind === "deferred"
    && result.materialization.defer_class === "write_path";
}

export function createPostTurnSignalReceiver(
  receiver: Pick<PostTurnSignalReceiver, "receiveSignal">
): PostTurnSignalReceiver {
  return { receiveSignal: (signal) => receiver.receiveSignal(signal) };
}
