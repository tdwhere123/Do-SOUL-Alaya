export const RECALL_EVAL_PAGER_CHILD_PROCESS_TITLE = "alaya-recall-eval-pager";

export type RecallEvalPagerIpcOp = "open" | "recall" | "close";

export interface RecallEvalPagerMapsHint {
  readonly pid: number;
  readonly comm: string | null;
  readonly alaya_db_mappings: number;
  readonly onnxruntime_mappings: number;
}

export interface RecallEvalPagerIpcRequest {
  readonly id: number;
  readonly op: RecallEvalPagerIpcOp;
  readonly timeoutMs?: number;
  readonly open?: unknown;
  readonly recall?: unknown;
}

export interface RecallEvalPagerIpcProgress {
  readonly id: number;
  readonly progress: true;
  readonly sequence: number;
  readonly stage: string;
  readonly completed: number;
  readonly total: number;
}

export type RecallEvalPagerIpcResponse =
  | RecallEvalPagerIpcSuccess
  | RecallEvalPagerIpcFailure;

export interface RecallEvalPagerIpcSuccess {
  readonly id: number;
  readonly ok: true;
  readonly pid?: number;
  readonly mapsHint?: RecallEvalPagerMapsHint | null;
  readonly pack?: unknown;
  readonly selectionArtifact?: unknown;
  readonly selectionSpoolRootPath?: unknown;
  readonly evidenceProjectionRebuild?: unknown;
  readonly embeddingCacheOverlay?: unknown;
}

export interface RecallEvalPagerIpcFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: Readonly<{
    readonly name: string;
    readonly message: string;
  }>;
}

export function isRecallEvalPagerIpcRequest(
  value: unknown
): value is RecallEvalPagerIpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RecallEvalPagerIpcRequest>;
  return (
    typeof record.id === "number" &&
    Number.isInteger(record.id) &&
    isRecallEvalPagerIpcOp(record.op)
  );
}

export function isRecallEvalPagerIpcResponse(
  value: unknown
): value is RecallEvalPagerIpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly id?: unknown; readonly ok?: unknown };
  return typeof record.id === "number" && typeof record.ok === "boolean";
}

export function isRecallEvalPagerIpcProgress(
  value: unknown
): value is RecallEvalPagerIpcProgress {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RecallEvalPagerIpcProgress>;
  return record.progress === true &&
    isNonNegativeInteger(record.id) &&
    isPositiveInteger(record.sequence) &&
    typeof record.stage === "string" &&
    record.stage.length > 0 &&
    isPositiveInteger(record.completed) &&
    isPositiveInteger(record.total) &&
    record.completed <= record.total;
}

export function serializeRecallEvalPagerIpcError(
  error: unknown
): RecallEvalPagerIpcFailure["error"] {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function isRecallEvalPagerIpcOp(value: unknown): value is RecallEvalPagerIpcOp {
  return value === "open" || value === "recall" || value === "close";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
