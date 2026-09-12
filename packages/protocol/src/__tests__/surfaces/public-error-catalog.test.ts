import { describe, expect, it } from "vitest";
import {
  PUBLIC_ERROR_CODE_MESSAGES,
  isPublicErrorMessage,
  readPublicStructuredErrorEnvelope,
  resolvePublicErrorMessage,
  toPublicToolError
} from "../../surfaces/public-error-catalog.js";

describe("public error catalog", () => {
  it("maps unknown copy and Zod received payloads to code defaults", () => {
    const receivedSecret = "sk-test-leaked-secret";
    expect(resolvePublicErrorMessage("VALIDATION", `Invalid input: received "${receivedSecret}"`)).toBe(
      PUBLIC_ERROR_CODE_MESSAGES.VALIDATION
    );
    expect(resolvePublicErrorMessage("INTERNAL", `boom ${receivedSecret}`)).toBe(
      PUBLIC_ERROR_CODE_MESSAGES.INTERNAL
    );
    expect(toPublicToolError("VALIDATION", `[\n  { "received": "${receivedSecret}" }\n]`).message).not.toContain(
      receivedSecret
    );
  });

  it("keeps closed workflow copy and strips interpolated suffixes", () => {
    expect(resolvePublicErrorMessage("VALIDATION", "Invalid reviewer token.")).toBe("Invalid reviewer token.");
    expect(resolvePublicErrorMessage("NOT_FOUND", "Proposal not found: prop-1")).toBe("Proposal not found.");
    expect(
      resolvePublicErrorMessage(
        "VALIDATION",
        "garden.complete_task does not support result_envelope.extracted_proposals yet; received 2 unsupported proposal(s)."
      )
    ).toBe("garden.complete_task does not support result_envelope.extracted_proposals yet.");
    expect(
      resolvePublicErrorMessage(
        "VALIDATION",
        "Garden task candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope: task-1"
      )
    ).toBe(
      "Garden task candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope."
    );
    expect(isPublicErrorMessage("Proposal not found: prop-1")).toBe(false);
    expect(isPublicErrorMessage("Proposal not found.")).toBe(true);
  });

  it("rejects structured envelopes whose message is not in the catalog", () => {
    const secret = "sk-test-leaked-secret";
    expect(
      readPublicStructuredErrorEnvelope({
        success: false,
        error: { code: "VALIDATION", message: `Invalid input: received "${secret}"` }
      })
    ).toBeNull();
    expect(
      readPublicStructuredErrorEnvelope({
        success: false,
        error: { code: "VALIDATION", message: "Invalid reviewer token." }
      })
    ).toEqual({
      success: false,
      error: { code: "VALIDATION", message: "Invalid reviewer token." }
    });
  });
});
