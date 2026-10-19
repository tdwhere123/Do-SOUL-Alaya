import { types } from "node:util";

// Literal observations only: none of these tokens proves a failure stage or root cause.
const OBSERVED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"
]);

/** Private log text, never a native failure classification or persistent accounting field. */
export function formatTransportDiagnostic(failure: unknown): string {
  const seen = new Set<object>();
  const codes = new Set<string>();
  const pending: unknown[] = [failure];
  let causeEdges = 0, aggregateChildren = 0;
  const visit = (value: unknown): value is object => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
    // Proxies (including revoked proxies) must be rejected before any reflection.
    if (types.isProxy(value) || seen.has(value) || seen.size === 8) return false;
    seen.add(value);
    return true;
  };
  while (pending.length > 0 && codes.size < 4) {
    const value = pending.shift();
    if (!visit(value)) continue;
    const code = ownData(value, "code");
    if (typeof code === "string" && OBSERVED_CODES.has(code)) codes.add(code);
    if (causeEdges < 4) {
      const cause = ownData(value, "cause");
      if (cause !== undefined) { causeEdges += 1; pending.push(cause); }
    }
    const errors = ownData(value, "errors");
    if (!visit(errors) || !Array.isArray(errors)) continue;
    // Never read length, iterate the supplied array, or look up inherited indices.
    for (let index = 0; index < 4 && aggregateChildren < 4; index += 1) {
      aggregateChildren += 1;
      pending.push(ownData(errors, String(index)));
    }
  }
  // Four allowlisted ASCII tokens keep the entire diagnostic below 256 bytes.
  return `transport_observation stage=unknown observed_codes=${codes.size === 0 ? "unknown" : [...codes].join(",")}`;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
