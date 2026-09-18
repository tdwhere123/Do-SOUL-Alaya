import { AlayaError } from "@do-soul/alaya-protocol";
import { readRetainedBatchRun } from "./store.js";
import { parseOutputInventory } from "./output-inventory.js";
import { batchLineResult } from "./line-result.js";

/** Read-only witness also permits the durable-cache / uncommitted-outcome recovery window. */
export function readRetainedBatchLine(root: string, planIdentity: string, key: string) {
  if (!/^[a-f0-9]{64}$/u.test(planIdentity)) {
    throw new AlayaError("VALIDATION", "invalid retained Batch plan reference");
  }
  const retained = readRetainedBatchRun(root, planIdentity);
  const jobs = retained.state.jobs.filter((job) => job.lineKeys.includes(key));
  if (jobs.length !== 1) throw new AlayaError("CONFLICT", "retained Batch line must have exactly one job");
  const job = jobs[0]!;
  const outcome = job.outcomes[key];
  if (outcome !== undefined && outcome.status !== "admitted") {
    throw new AlayaError("CONFLICT", "retained Batch line was not admitted");
  }
  const raw = retained.outputs.get(job.id);
  if (raw === undefined) throw new AlayaError("CONFLICT", "retained Batch output is missing");
  const response = parseOutputInventory(raw, job).get(key);
  if (response?.response === undefined) {
    throw new AlayaError("CONFLICT", "retained Batch successful response is missing");
  }
  return { plan: retained.plan, endpoint: retained.state.endpoint,
    result: batchLineResult(retained.plan, job, key, response.response) };
}
