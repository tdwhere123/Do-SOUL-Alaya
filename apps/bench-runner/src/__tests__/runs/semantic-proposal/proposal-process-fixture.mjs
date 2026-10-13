import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const cacheRoot = process.env.PROPOSAL_CACHE_ROOT;
const mode = process.env.PROPOSAL_PROCESS_MODE;
if (cacheRoot === undefined || mode === undefined) {
  throw new Error("semantic proposal process fixture environment is incomplete");
}

// Requires a fresh pnpm build, as CI performs; load the real CLI runtime without a second compiler.
const runtimeRoot = new URL("../../../../dist/runs/", import.meta.url);

if (mode === "revision-drift") {
  const fill = await import(new URL("semantic-proposal/fill.js", runtimeRoot));
  const worksets = await import(new URL("semantic-proposal/workset.js", runtimeRoot));
  const authorities = await import(new URL("semantic-proposal/authority.js", runtimeRoot));
  const attempts = await import(new URL("semantic-proposal/attempt.js", runtimeRoot));
  const ledgers = await import(new URL("extraction/authority/attempt-ledger.js", runtimeRoot));
  const workset = worksets.parseSemanticProposalWorkset(JSON.parse(readFileSync(process.env.PROPOSAL_WORKSET_PATH, "utf8")));
  process.chdir(process.env.PROPOSAL_GIT_ROOT);
  const pin = root => authorities.pinSemanticProposalAuthority({ preflight: fill.prepareSemanticProposal(workset, root, 128, 1),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  const authority = pin(cacheRoot);
  attempts.openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind }).reserveAttemptOrdinal(authority.keys[0]);
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const before = readFileSync(ledgerPath, "utf8");
  const request = worksets.materializeSemanticProposalLines(workset, 128)[0].requestDigest;
  writeFileSync("host-only.ts", "export const admissionRevision = 2;\n");
  const scopeUnchanged = authorities.inspectSemanticProposalExecutionScope(cacheRoot).implementation_revision ===
    authority.execution_scope.implementation_revision;
  authorities.assertSemanticProposalExecutionScope(authority.execution_scope, cacheRoot);
  const repinned = pin(cacheRoot);
  const resumed = await fill.executeSemanticProposalFill({ workset, cacheRoot, authority: repinned,
    config: { model: workset.model, requestProfile: workset.request_profile, providerUrl: workset.provider_url,
      apiKey: "loopback-only" } });
  process.stdout.write(`${JSON.stringify({
    request_unchanged: request === worksets.materializeSemanticProposalLines(workset, 128)[0].requestDigest,
    revision_changed: authority.execution_scope.implementation_revision !== repinned.execution_scope.implementation_revision,
    scope_unchanged: scopeUnchanged, unknown_preserved: readFileSync(ledgerPath, "utf8") === before,
    lineage_unchanged: authority.attempt_lineage_digest === repinned.attempt_lineage_digest,
    ledger_count: ledgers.listExtractionAttemptLedgerRecords(cacheRoot).length, resumed
  })}\n`);
  process.exit(0);
}
if (mode === "fill" || mode === "recover") {
  const fill = await import(new URL("semantic-proposal/fill.js", runtimeRoot));
  const worksets = await import(new URL("semantic-proposal/workset.js", runtimeRoot));
  const authorities = await import(new URL("semantic-proposal/authority.js", runtimeRoot));
  const workset = worksets.parseSemanticProposalWorkset(JSON.parse(readFileSync(join(cacheRoot, "workset.json"), "utf8")));
  try {
    const authority = authorities.readSemanticProposalAuthority(process.env.PROPOSAL_AUTHORITY_PATH);
    const result = await fill.executeSemanticProposalFill({ workset, cacheRoot,
      authority, config: { model: workset.model, requestProfile: workset.request_profile,
        providerUrl: workset.provider_url, apiKey: mode === "recover" ? null : "loopback-only" } });
    const output = mode === "recover" ? { summary: result,
      statuses: fill.readSemanticProposalResults(workset, cacheRoot, authority.limits.max_output_tokens).map(row => row.status) } : result;
    process.stdout.write(`${mode === "recover" ? "PROPOSAL_RECOVERY_RESULT:" : ""}${JSON.stringify(output)}\n`);
    process.exit(0);
  } catch (cause) {
    process.stderr.write(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  }
}
const guard = await import(new URL("extraction/fill/manifest/fill-root-guard.js", runtimeRoot));
if (mode === "hold") {
  const lease = guard.acquireExtractionCacheWriteLease(cacheRoot);
  process.stdout.write("HELD\n");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, Number(process.env.PROPOSAL_HOLD_MS ?? 4000));
    process.on("SIGTERM", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  lease.release();
  process.exit(0);
}
try {
  const lease = guard.acquireExtractionCacheWriteLease(cacheRoot);
  lease.release();
  process.stdout.write("ACQUIRED\n");
  process.exit(0);
} catch (cause) {
  process.stderr.write(cause instanceof Error ? cause.message : String(cause));
  process.exit(2);
}
