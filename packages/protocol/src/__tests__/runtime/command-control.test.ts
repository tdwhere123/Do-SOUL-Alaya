import { describe, expect, it } from "vitest";
import { RunInterruptResultSchema } from "../../runtime/command-control.js";

describe("command control protocol", () => {
  it("accepts the frozen run interrupt result statuses", () => {
    const statuses = ["cancelled", "already_finished", "no_active", "unsupported", "failed"] as const;

    for (const status of statuses) {
      expect(
        RunInterruptResultSchema.parse({
          run_id: "run-1",
          status,
          message: `${status} message`
        })
      ).toMatchObject({ run_id: "run-1", status });
    }
  });

});
