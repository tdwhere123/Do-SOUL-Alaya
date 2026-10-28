import type { Continuation } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";

/** Ports and caller-supplied codecs stay live environment. They are functions or
 * foreign instances that the field calls; copying or freezing them would either
 * clone service behavior or mutate the caller. */
const ENVIRONMENT_FIELDS = ["readers", "encode_page", "observe_page_fit", "observe_navigation"] as const satisfies
  readonly (keyof ConditionalFieldRecallRequest)[];

type RecallRequestEnvironment = Readonly<{
  readonly readers: ObserverReaders;
  readonly observe_page_fit?: ConditionalFieldRecallRequest["observe_page_fit"];
  readonly observe_navigation?: ConditionalFieldRecallRequest["observe_navigation"];
  readonly encode_page?: ConditionalFieldRecallRequest["encode_page"];
}>;

/** An owned, immutable copy of the caller's domain request: identity inputs,
 * budget, authorization, continuation and nested selections. `undefined`
 * (omitted) and `null` (unrestricted) scope authority stay distinct. */
export type CapturedRecallRequest = Readonly<{
  readonly request: ConditionalFieldRecallRequest;
  /** The live environment the owned request executes against: ports and caller codecs,
   * which are functions or foreign instances rather than retained domain data. */
  readonly environment: RecallRequestEnvironment;
}>;

/** Capture the domain request before validation, identity compilation, receipts or
 * any port call. Every retained nested domain value is copied, so neither a later
 * caller mutation nor a port that keeps the value it received can change the
 * authority, receipt or query identity this request already committed to. */
export function captureRecallRequest(sent: ConditionalFieldRecallRequest): CapturedRecallRequest {
  const retained: Record<string, unknown> = {};
  const { prepared_query: prepared, ...domain } = sent;
  for (const [key, value] of Object.entries(domain)) {
    if (value === undefined || isEnvironmentField(key)) continue;
    retained[key] = copyOwnedData(value);
  }
  if (prepared !== undefined) retained.prepared_query = SourceIndexAcquisition.capturePreparedQuery(prepared);
  const continuation = ownedContinuation(sent.continuation);
  if (continuation !== undefined) retained.continuation = continuation;
  return Object.freeze({
    request: Object.freeze(retained) as ConditionalFieldRecallRequest,
    environment: Object.freeze({
      readers: sent.readers,
      ...(sent.observe_page_fit === undefined ? {} : { observe_page_fit: sent.observe_page_fit }),
      ...(sent.observe_navigation === undefined ? {} : { observe_navigation: sent.observe_navigation }),
      ...(sent.encode_page === undefined ? {} : { encode_page: sent.encode_page })
    })
  });
}

/** Compose an owned request over its environment without recovering caller data. */
export function withRecallEnvironment(
  captured: CapturedRecallRequest,
  patch: Partial<Omit<ConditionalFieldRecallRequest, "readers">> = {}
): ConditionalFieldRecallRequest {
  const merged: Record<string, unknown> = { ...captured.request };
  for (const [key, value] of Object.entries(captured.environment)) {
    if (value !== undefined) merged[key] = value;
  }
  const { prepared_query: prepared, ...domain } = patch;
  for (const [key, value] of Object.entries(domain)) {
    if (value === undefined) delete merged[key];
    else merged[key] = isEnvironmentField(key) ? value : copyOwnedData(value);
  }
  if (prepared !== undefined) merged.prepared_query = SourceIndexAcquisition.capturePreparedQuery(prepared);
  else if (Object.hasOwn(patch, "prepared_query")) delete merged.prepared_query;
  return Object.freeze(merged) as ConditionalFieldRecallRequest;
}

/** A nomination frame is handed to acquisition code that owns its own filtering.
 * It receives an isolated copy, never the retained authorization array. */
export function nominationScopes(
  scopes: readonly string[] | null | undefined
): readonly string[] | null {
  if (scopes === null || scopes === undefined) return null;
  return [...scopes];
}

function isEnvironmentField(key: string): boolean {
  return (ENVIRONMENT_FIELDS as readonly string[]).includes(key);
}

function ownedContinuation(continuation: Continuation | null | undefined): Continuation | null | undefined {
  if (continuation === undefined || continuation === null) return continuation;
  return copyOwnedData(continuation) as Continuation;
}

/** The caller declares domain data, not capabilities. Record containers include
 * ordinary class instances: their prototype cannot exempt policy or budget fields
 * from capture. Live ports/codecs belong only to the explicit environment above. */
export function captureRecallData<T>(value: T): T {
  return copyOwnedData(value) as T;
}

function copyOwnedData(value: unknown): unknown {
  if (typeof value === "function") throw new TypeError("Recall domain data cannot contain functions");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((child) => copyOwnedData(child)));
  // Record domain fields cannot carry internal-slot objects as implicit services.
  // Prepared source vectors are captured separately by their source-index owner.
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    throw new TypeError("Recall domain data must use record or array containers");
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: copyOwnedData(child), enumerable: true });
  }
  return Object.freeze(copy);
}
