import { performance } from "node:perf_hooks";
import { vi } from "vitest";
import * as native from "../../../runs/snapshot/source-records/native.js";
import * as publication from "../../../runs/snapshot/source-records/publish.js";
import * as authority from "../../../runs/extraction/authority/inspection.js";
import * as allowance from "../../../runs/semantic-chain/recovery-allowance.js";
import * as files from "../../../runs/snapshot/bound-file.js";

/** Inclusive parent-process times; nested categories must not be summed. */
export function traceNativeRecoveryCosts() {
  const totals: Record<string, { calls: number; ms: number }> = {};
  const measure = <T>(name: string, call: () => T): T => {
    const started = performance.now();
    try { return call(); }
    finally {
      const row = totals[name] ??= { calls: 0, ms: 0 };
      row.calls++; row.ms += performance.now() - started;
    }
  };
  const read = native.readVerifiedNativeSourceSnapshot, report = publication.readNativeSourcePublicationReport;
  const revision = authority.readCurrentExtractionAuthorityRevision, reserve = allowance.reserveRecoveryRead;
  const hash = files.hashRegularFileNoFollow;
  const spies = [
    vi.spyOn(native, "readVerifiedNativeSourceSnapshot").mockImplementation((...args) => measure("native_snapshot", () => read(...args))),
    vi.spyOn(publication, "readNativeSourcePublicationReport").mockImplementation((...args) => measure("publication_report", () => report(...args))),
    vi.spyOn(authority, "readCurrentExtractionAuthorityRevision").mockImplementation((...args) => measure("git_revision", () => revision(...args))),
    vi.spyOn(allowance, "reserveRecoveryRead").mockImplementation((...args) => measure("read_reservation", () => reserve(...args))),
    vi.spyOn(files, "hashRegularFileNoFollow").mockImplementation((...args) => measure("file_hash", () => hash(...args)))
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
    process.stderr.write(`[recovery-costs] ${JSON.stringify({ scope: "parent_process_inclusive", totals })}\n`);
  };
}
