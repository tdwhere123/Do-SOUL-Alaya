import {
  assembleRecallEvalSelectionBoundaryArtifacts,
  disposeRecallEvalSelectionBoundaryArtifact,
  disposeRecallEvalSelectionBoundaryRoot,
  RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
  type RecallEvalSelectionBoundaryArtifact
} from "../recall-eval-selection-replay.js";

export class RecallEvalSelectionArtifactCollector {
  readonly #artifacts: RecallEvalSelectionBoundaryArtifact[] = [];
  readonly #questionIds: string[] = [];
  readonly #openRoots = new Set<string>();
  #captureEnabled = false;
  #assembled: RecallEvalSelectionBoundaryArtifact | null | undefined;

  recordQuestion(payload: unknown): void {
    this.#questionIds.push(recallQuestionId(payload));
  }

  recordArtifact(value: unknown): void {
    if (value === null || value === undefined) return;
    const artifact = parseSelectionBoundaryArtifact(value);
    this.#artifacts.push(artifact);
    this.#openRoots.delete(artifact.rootPath);
  }

  recordOpenRoot(value: unknown): void {
    if (value === null || value === undefined) return;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("recall-eval pager child returned an invalid selection spool root");
    }
    this.#captureEnabled = true;
    this.#openRoots.add(value);
  }

  async finalize(): Promise<RecallEvalSelectionBoundaryArtifact | null> {
    if (this.#assembled !== undefined) return this.#assembled;
    let assembled: RecallEvalSelectionBoundaryArtifact | null = null;
    let primaryError: unknown;
    try {
      assembled = await assembleRecallEvalSelectionBoundaryArtifacts({
        artifacts: this.#artifacts,
        expectedQuestionIds: this.#captureEnabled ? this.#questionIds : []
      });
    } catch (error) {
      primaryError = error;
    }
    const cleanupError = await this.#disposeChildren();
    if (primaryError !== undefined || cleanupError !== undefined) {
      await disposeRecallEvalSelectionBoundaryArtifact(assembled);
      throw primaryError ?? cleanupError;
    }
    this.#assembled = assembled;
    return assembled;
  }

  async #disposeChildren(): Promise<unknown> {
    const results = await Promise.allSettled(
      [
        ...this.#artifacts.map((artifact) =>
          disposeRecallEvalSelectionBoundaryArtifact(artifact)
        ),
        ...[...this.#openRoots].map((rootPath) =>
          disposeRecallEvalSelectionBoundaryRoot(rootPath)
        )
      ]
    );
    this.#artifacts.length = 0;
    this.#openRoots.clear();
    return results.find((result) => result.status === "rejected")?.reason;
  }
}

function recallQuestionId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("recall-eval pager recall payload has no question id");
  }
  const direct = (payload as { readonly questionId?: unknown }).questionId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const question = (payload as { readonly question?: unknown }).question;
  if (typeof question === "object" && question !== null) {
    const nested = (question as { readonly questionId?: unknown }).questionId;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  throw new Error("recall-eval pager recall payload has no question id");
}

function parseSelectionBoundaryArtifact(
  value: unknown
): RecallEvalSelectionBoundaryArtifact {
  if (typeof value !== "object" || value === null) return invalidArtifact();
  const artifact = value as Partial<RecallEvalSelectionBoundaryArtifact>;
  const binding = artifact.binding as Partial<
    RecallEvalSelectionBoundaryArtifact["binding"]
  > | undefined;
  if (typeof artifact.rootPath !== "string" || artifact.rootPath.length === 0 ||
      typeof artifact.sourcePath !== "string" || artifact.sourcePath.length === 0 ||
      binding?.filename !== RECALL_EVAL_SELECTION_BOUNDARY_FILENAME ||
      typeof binding.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binding.sha256) ||
      !Number.isSafeInteger(binding.bytes) || (binding.bytes ?? 0) < 1 ||
      !Number.isSafeInteger(binding.record_count) || (binding.record_count ?? 0) < 1) {
    return invalidArtifact();
  }
  return artifact as RecallEvalSelectionBoundaryArtifact;
}

function invalidArtifact(): never {
  throw new Error("recall-eval pager child returned an invalid selection artifact");
}
