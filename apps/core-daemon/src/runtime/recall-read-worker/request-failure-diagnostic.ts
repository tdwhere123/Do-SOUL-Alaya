import type { RecallReadWorkerOperation, RecallReadWorkerResponse } from "./protocol.js";

type WorkerError = Extract<RecallReadWorkerResponse, { readonly ok: false }>["error"];
type Warn = (message: string, meta: Record<string, unknown>) => void;
const MAX_DETAILS_BYTES = 32_768;
const MAX_TEXT_LENGTH = 8_192;

/** Private operator evidence, never a public error projection or a cost receipt.
 * Consume the worker serialization verbatim except for explicit diagnostic caps.
 * No retained buffer: each accepted rejection emits at most one bounded record.
 */
export function warnWorkerRequestFailure(warn: Warn | undefined, workerThreadId: number,
  requestId: number, operation: RecallReadWorkerOperation, wire: WorkerError): void {
  if (warn === undefined) return;
  try {
    // The rejection owns its details. A sink may mutate or retain only this copy.
    const copy = structuredClone(wire);
    const truncated: string[] = [];
    const text = (value: string, field: string) => {
      if (value.length <= MAX_TEXT_LENGTH) return value;
      truncated.push(field);
      return value.slice(0, MAX_TEXT_LENGTH);
    };
    const details = boundDetails(copy.details);
    const coreDetails = boundDetails(copy.core?.details);
    const error: WorkerError = {
      name: text(copy.name, "name"), message: text(copy.message, "message"),
      ...(copy.stack === undefined ? {} : { stack: text(copy.stack, "stack") }),
      ...(details.value === undefined ? {} : { details: details.value }),
      ...(copy.core === undefined ? {} : { core: {
        code: copy.core.code, subCode: copy.core.subCode,
        ...(coreDetails.value === undefined ? {} : { details: coreDetails.value })
      } })
    };
    // This explicitly private nested wire record preserves raw error text. The
    // general logger's shallow error-message redaction is not a public boundary;
    // its secret-field redaction still applies. Never attach request/result bodies.
    void Promise.resolve(warn("recall read worker request failed", {
      worker_thread_id: workerThreadId, request_id: requestId, operation,
      failure: { error, details_status: details.status, core_details_status: coreDetails.status,
        truncated_fields: truncated }
    })).catch(() => undefined);
  } catch {
    // Diagnostic construction/sink failure cannot replace a known rejection or
    // escape into lifecycle transport quarantine, rollback or close.
  }
}

function boundDetails(value: WorkerError["details"]): {
  value?: WorkerError["details"];
  status: "absent" | "present" | "omitted_oversize" | "omitted_unserializable";
} {
  if (value === undefined) return { status: "absent" };
  try {
    let unsupported = false;
    const json = JSON.stringify(value, function (key, entry: unknown) {
      const original: unknown = this[key];
      // JSON diagnostics cannot faithfully expose exotic objects, undefined or
      // non-finite numbers. In particular structuredClone shares SAB backing;
      // never hand a sink a reference to the rejection's shared memory.
      if (original !== null && typeof original === "object") {
        const prototype: unknown = Object.getPrototypeOf(original);
        if (!Array.isArray(original) && prototype !== Object.prototype && prototype !== null) unsupported = true;
      } else if (original !== null && !["string", "number", "boolean"].includes(typeof original)) unsupported = true;
      if (typeof original === "number" && !Number.isFinite(original)) unsupported = true;
      return entry;
    });
    if (unsupported) return { status: "omitted_unserializable" };
    if (Buffer.byteLength(json, "utf8") > MAX_DETAILS_BYTES) return { status: "omitted_oversize" };
    return { value: JSON.parse(json) as WorkerError["details"], status: "present" };
  } catch {
    return { status: "omitted_unserializable" };
  }
}
