import { it } from "vitest";
import { writeSync } from "node:fs";
import { openRuntimeDatabase } from "../../../runtime/startup/runtime-database.js";
import { createFaults, createHandoffRuntime, notifier, WORKSPACE } from "../embedding-backfill-follow-up-fixture.js";

it("terminates immediately after the first committed embedding checkpoint", async () => {
  const filename = process.env.ALAYA_GARDEN_CRASH_DATABASE;
  if (filename === undefined) throw new Error("The crash fixture requires an isolated database.");
  const opened = await openRuntimeDatabase(filename, notifier, () => undefined);
  const faults = createFaults();
  const terminate = () => {
    // Stop the writer at the commit boundary before the parent kills the whole
    // runner. A self-signal can arrive after another write on macOS, while
    // process.exit inside a Vitest worker only exits that thread on Windows.
    writeSync(1, `ALAYA_GARDEN_CRASH_POINT_REACHED:${process.env.ALAYA_GARDEN_CRASH_POINT}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  switch (process.env.ALAYA_GARDEN_CRASH_POINT) {
    case "task_dispatch": faults.afterTaskDispatchAudit = terminate; break;
    case "before_embedding": faults.beforeEmbeddingResult = terminate; break;
    case "embedding": faults.afterEmbeddingWrite = terminate; break;
    case "assertion": faults.afterAssertionAdmission = terminate; break;
    case "followup_audit": faults.afterFollowUpAudit = terminate; break;
    case "task_audit": faults.afterTaskCompletionAudit = terminate; break;
    case "retry_claim": faults.afterRetryClaimAudit = terminate; break;
    default: throw new Error("The crash fixture requires a named commit point.");
  }
  await createHandoffRuntime(opened.database, faults).runtime.runEmbeddingBackfillPass(WORKSPACE);
  throw new Error("The crash fixture did not terminate at the committed write.");
});
