import type { GeminiBatchJob } from "./contract.js";
import { geminiUsage, record } from "./native-codec.js";

export function parseOutputInventory(raw: string, job: GeminiBatchJob): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const allowed = new Set(job.lineKeys);
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = record(JSON.parse(line));
    if (typeof entry.key !== "string" || !allowed.has(entry.key)) throw new Error("foreign Batch result key");
    if (result.has(entry.key)) throw new Error("duplicate Batch result key");
    if ((entry.response === undefined) === (entry.error === undefined)) {
      throw new Error("Batch result requires exactly one response or error");
    }
    if (entry.error !== undefined) record(entry.error);
    else record(entry.response);
    result.set(entry.key, entry);
  }
  return result;
}

export function deriveBatchUsage(raw: string, job: GeminiBatchJob): Pick<GeminiBatchJob, "usage" | "usageUnknown"> {
  let entries: Map<string, Record<string, unknown>>;
  try { entries = parseOutputInventory(raw, job); }
  catch { return { usageUnknown: true }; }
  const sum = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let unknown = entries.size !== job.lineKeys.length;
  for (const entry of entries.values()) {
    let usage: ReturnType<typeof geminiUsage>;
    try { usage = entry.response === undefined ? undefined : geminiUsage(record(entry.response)); }
    catch { usage = undefined; }
    if (usage === undefined) { unknown = true; continue; }
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    sum.totalTokens += usage.totalTokens;
    if (!Object.values(sum).every(Number.isSafeInteger)) throw new Error("Batch aggregate usage overflow");
  }
  return { usage: sum, usageUnknown: unknown };
}
