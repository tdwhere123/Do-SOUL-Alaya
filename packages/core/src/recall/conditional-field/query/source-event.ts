import type { GuardVerdict } from "@do-soul/alaya-protocol";

// These are complete event-record constructions, not keyword evidence. A single
// unquoted identifier after "of" names the deployment; arbitrary prose tails,
// embedded clauses, and quotations are outside this interpretation's domain.
const DEPLOYMENT = String.raw`(?:the )?deployment(?: of [\p{L}\p{N}_-]+)?`;
const FAILED = new RegExp(String.raw`^(?:(?:failed|unsuccessful) deployment(?: of [\p{L}\p{N}_-]+)?|${DEPLOYMENT} (?:failed|has failed|was unsuccessful))$`, "u");
const NOT_FAILED = new RegExp(String.raw`^(?:successful deployment(?: of [\p{L}\p{N}_-]+)?|${DEPLOYMENT} (?:succeeded|did not fail|has not failed|was successful))$`, "u");

/** Partial bodies and constructions outside the bounded event grammar are unknown. */
export function failedDeploymentVerdict(content: string | undefined,
  complete = true): GuardVerdict {
  if (content === undefined || !complete) return "unresolved";
  const record = content.normalize("NFC").toLowerCase().trim()
    .replace(/[.]$/u, "").replace(/^yesterday(?:'s)? /u, "")
    .replace(/ yesterday$/u, "");
  if (FAILED.test(record)) return "true";
  return NOT_FAILED.test(record) ? "false" : "unresolved";
}
