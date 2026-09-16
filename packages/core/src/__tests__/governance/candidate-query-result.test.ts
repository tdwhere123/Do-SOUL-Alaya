import { describe, expect, it } from "vitest";
import { readCandidateQuery } from "../../governance/reconciliation/candidate-query-result.js";

describe("readCandidateQuery", () => {
  it("preserves a successful empty list as ok, not unavailable", async () => {
    await expect(readCandidateQuery(async () => [])).resolves.toEqual({
      availability: "ok",
      items: []
    });
  });

  it("maps a thrown read to unavailable instead of an empty list", async () => {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    await expect(
      readCandidateQuery(async () => {
        throw error;
      })
    ).resolves.toEqual({
      availability: "unavailable",
      error
    });
  });
});
