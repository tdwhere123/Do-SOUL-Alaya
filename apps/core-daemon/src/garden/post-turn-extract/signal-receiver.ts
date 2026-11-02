import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

export interface PostTurnSignalReceiveResult {
  readonly signal: Readonly<{
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly signal_state?: CandidateMemorySignal["signal_state"];
  }>;
  readonly triage_result?: "accepted" | "dropped" | "deferred";
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

export function signalMaterializationFailed(result: PostTurnSignalReceiveResult): boolean {
  return result.signal.signal_state === "failed" || result.materialization?.success === false;
}

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
