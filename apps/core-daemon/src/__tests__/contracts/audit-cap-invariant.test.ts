import { describe, expect, it } from "vitest";

import { AUDIT_DROPPED_CONTENT_MAX_CHARS } from "@do-soul/alaya-core";
import { DISTILLED_FACT_MAX_CHARS } from "@do-soul/alaya-soul";

// The reconciliation audit row stores the dropped fact verbatim so an
// LLM-NOOP drop stays reconstructable from the event log. The dropped
// fact originates from buildDistilledFact, which caps content at
// DISTILLED_FACT_MAX_CHARS. The audit cap must stay at or above that
// length or encodeAuditContent silently truncates and the dropped fact
// becomes unrecoverable. The two caps live in different packages with
// nothing structural binding them; this is the only enforcement.
describe("audit cap invariant", () => {
  it("the audit cap is at least the distilled-fact cap", () => {
    expect(AUDIT_DROPPED_CONTENT_MAX_CHARS).toBeGreaterThanOrEqual(
      DISTILLED_FACT_MAX_CHARS
    );
  });
});
