/** Reusable receipt reconciliation owner. The immutable first-question receipt-admission.mjs
 * is historical reproduction-only; new acquisition invocations use this authority. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const zero = () => ({ sends: 0, source_inputs: 0, utf8_bytes: 0 });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const charge = (total, row) => ({ sends: total.sends + 1,
  source_inputs: total.source_inputs + row.inputs + row.texts, utf8_bytes: total.utf8_bytes + row.utf8_bytes });

/** Ordered evidence, not enforcement: only the launch owner's active inspection establishes that. */
export function reconcileOfflineGuard(parentValue, childValue, policyValue) {
  const { parent, child, policy } = structuredClone({ parent: parentValue, child: childValue, policy: policyValue });
  const { preload, inputs, bytes, pid } = policy;
  assert(integer(inputs) && integer(bytes), "invalid receipt allocation");
  const allocation = { status: "configured", scope: "per_process", source_inputs: inputs, utf8_bytes: bytes };
  assert.equal(parent.kind, "alaya-source-embedding-offline-parent-guard-receipt");
  assert.equal(child.kind, "alaya-source-embedding-offline-child-guard-receipt");
  assert.equal(parent.pid, pid, "wrong guarded application process");
  const common = report => {
    assert.equal(report.preload_specifier, preload);
    assert.equal(report.credential_environment_count, 0);
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.source_allocation, allocation);
    assert.equal(report.input_cap, 2);
    assert.equal(report.input_cap_source, "default");
    assert.equal(report.input_cap_scope, "per_send");
    assert.equal(report.cumulative_input_cap, inputs);
    assert.equal(report.cumulative_input_cap_source, "allocation");
    assert.equal(report.explicit_cumulative_input_cap, null);
    assert.deepEqual(report.allocation_usage.blocked, zero());
    assert.deepEqual(report.allocation_usage.forward_unknown, zero());
    assert.equal(report.last_blocked_send, null);
  };
  common(parent);
  assert.deepEqual(parent.configured_child_exec_argv, ["--import", preload]);
  assert.deepEqual(parent.blocked_sends, []);
  assert.deepEqual(parent.forward_unknown_sends, []);
  assert.equal(parent.cleanup, "confirmed");
  assert(parent.children.length <= 1);
  assert.deepEqual(child.children, parent.children);
  const rows = parent.dispatched_sends;
  assert.deepEqual(parent.attempted_sends, rows);
  const progress = [{ reserved: zero(), dispatched: zero(), warmup: 0 }];
  for (const [index, row] of rows.entries()) {
    assert(["warmup", "bind_source", "embed_source", "close"].includes(row.op));
    assert(integer(row.inputs) && integer(row.texts) && integer(row.utf8_bytes));
    assert.equal(row.input_cap, 2);
    assert.equal(row.input_cap_source, "default");
    assert(row.inputs + row.texts <= 2);
    assert(row.op === "embed_source" || row.inputs + row.texts + row.utf8_bytes === 0);
    assert(row.op !== "close" || index === rows.length - 1);
    const prior = progress.at(-1);
    progress.push({ reserved: row.op === "embed_source" ? charge(prior.reserved, row) : { ...prior.reserved },
      dispatched: charge(prior.dispatched, row), warmup: prior.warmup + Number(row.op === "warmup") });
  }
  const final = progress.at(-1);
  assert.deepEqual(parent.reserved_sends, rows.filter(row => row.op === "embed_source"));
  assert.deepEqual(parent.allocation_usage.reserved, final.reserved);
  assert.deepEqual(parent.allocation_usage.dispatched, final.dispatched);
  assert.equal(parent.cumulative_input_reserved, final.reserved.source_inputs);
  assert(final.reserved.source_inputs <= inputs && final.reserved.utf8_bytes <= bytes);
  assert.deepEqual(parent.warmup, { attempted: final.warmup, dispatched: final.warmup, model_execution_work: "unknown" });
  if (parent.children.length === 0) {
    assert.equal(rows.length, 0);
    assert.equal(child.reports.length, 0);
    assert.equal(parent.observed_application_replies, 0);
    return { allocation, usage: parent.allocation_usage, cleanup: "confirmed", model_execution_work: "unknown" };
  }
  const exited = parent.children[0];
  assert(Number.isSafeInteger(exited.pid) && exited.pid > 0);
  assert.equal(exited.script, fileURLToPath(new URL("../../../dist/embedding-recall/local-onnx-process/child.js", preload)));
  assert.equal(exited.preload, preload);
  assert(exited.handle_owned && exited.exited && exited.exit_confirmed);
  assert(exited.code === 0 && exited.signal === null || exited.code === null && exited.signal === "SIGTERM");
  let forwards = 0, replies = 0;
  assert.equal(child.reports[0]?.phase, "installed");
  for (const [index, report] of child.reports.entries()) {
    common(report);
    assert.equal(report.pid, exited.pid);
    assert.deepEqual(report.exec_argv, ["--import", preload]);
    if (report.phase === "dispatch") { assert(forwards === replies && forwards < rows.length); forwards++; }
    else if (report.phase === "application_response") { assert.equal(forwards, replies + 1); replies++; }
    else assert(index === 0 && report.phase === "installed");
    const expected = progress[forwards];
    assert.deepEqual(report.allocation_usage.reserved, expected.reserved);
    assert.deepEqual(report.allocation_usage.dispatched, expected.dispatched);
    assert.equal(report.cumulative_input_reserved, expected.reserved.source_inputs);
    assert.deepEqual(report.warmup, { attempted: expected.warmup, dispatched: expected.warmup, model_execution_work: "unknown" });
    assert.equal(report.local_responses, replies);
  }
  const terminalClose = rows.at(-1)?.op === "close", preclose = rows.length - Number(terminalClose);
  assert(forwards >= preclose && replies >= preclose, "unobserved model operation/response");
  assert(forwards === rows.length || terminalClose && forwards === preclose);
  assert(replies === forwards || terminalClose && forwards === rows.length && replies === preclose);
  assert.equal(parent.observed_application_replies, replies);
  assert.deepEqual(child.reports.at(-1).allocation_usage.reserved, final.reserved);
  return { allocation, usage: parent.allocation_usage, children: parent.children, application_replies: replies,
    cleanup: "confirmed", model_execution_work: "unknown", physical_total: "unknown",
    shutdown: { process_death: "confirmed", handler_completion: "unknown", unmatched_terminal_close: forwards < rows.length } };
}
