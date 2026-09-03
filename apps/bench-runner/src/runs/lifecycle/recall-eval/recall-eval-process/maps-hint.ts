import { readFileSync } from "node:fs";
import type { RecallEvalPagerMapsHint } from "./protocol.js";

export function readRecallEvalPagerMapsHint(
  pid: number = process.pid
): RecallEvalPagerMapsHint | null {
  const maps = tryReadProcMaps(pid);
  if (maps === null) return null;
  return Object.freeze({
    pid,
    comm: readProcComm(pid),
    alaya_db_mappings: countMapLines(maps, /alaya\.db(?:-wal|-shm)?(?:\s|$)/u),
    onnxruntime_mappings: countMapLines(maps, /onnxruntime/iu)
  });
}

export function formatRecallEvalPagerMapsHint(
  hint: RecallEvalPagerMapsHint | null | undefined
): string {
  if (hint === undefined || hint === null) return "maps=unsampled";
  return (
    `pid=${hint.pid} comm=${hint.comm ?? "unknown"} ` +
    `alaya.db=${hint.alaya_db_mappings} onnxruntime=${hint.onnxruntime_mappings}`
  );
}

export function formatPagerExit(input: {
  readonly code: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly childPid?: number | null;
  readonly mapsHint?: RecallEvalPagerMapsHint | null;
}): string {
  const pid = input.childPid ?? input.mapsHint?.pid ?? "unknown";
  const maps = input.mapsHint === undefined || input.mapsHint === null
    ? "maps=unsampled"
    : formatRecallEvalPagerMapsHint(input.mapsHint);
  return (
    `recall-eval pager child exited (pid=${pid}, code=${input.code}, ` +
    `signal=${input.exitSignal}, ${maps}).`
  );
}

function countMapLines(maps: string, pattern: RegExp): number {
  return maps.split("\n").filter((line) => pattern.test(line)).length;
}

function tryReadProcMaps(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/maps`, "utf8");
  } catch {
    return null;
  }
}

function readProcComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}
