import { it } from "vitest";
import { openRuntimeDatabase } from "../../../runtime/startup/runtime-database.js";
import { createFaults, createHandoffRuntime, notifier, WORKSPACE } from "../embedding-backfill-follow-up-fixture.js";

it("terminates immediately after the first committed embedding checkpoint", async () => {
  const filename = process.env.ALAYA_GARDEN_CRASH_DATABASE;
  if (filename === undefined) throw new Error("The crash fixture requires an isolated database.");
  const opened = await openRuntimeDatabase(filename, notifier, () => undefined);
  const faults = createFaults();
  const terminate = () => {
    if (process.platform === "win32") process.exit(86);
    process.kill(process.pid, "SIGKILL");
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
