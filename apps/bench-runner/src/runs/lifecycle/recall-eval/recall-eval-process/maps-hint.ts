import { readFileSync } from "node:fs";
import type { RecallEvalPagerMapsHint } from "./protocol.js";

export function readRecallEvalPagerMapsHint(
  pid: number = process.pid
): RecallEvalPagerMapsHint {
  return Object.freeze({
    pid,
    comm: readProcComm(pid),
    alaya_db_mappings: countMapLines(pid, /alaya\.db(?:-wal|-shm)?(?:\s|$)/u),
    onnxruntime_mappings: countMapLines(pid, /onnxruntime/iu)
  });
}

export function formatRecallEvalPagerMapsHint(
  hint: RecallEvalPagerMapsHint
): string {
  return (
    `pid=${hint.pid} comm=${hint.comm ?? "unknown"} ` +
    `alaya.db=${hint.alaya_db_mappings} onnxruntime=${hint.onnxruntime_mappings}`
  );
}

function countMapLines(pid: number, pattern: RegExp): number {
  try {
    return readProcMaps(pid).split("\n").filter((line) => pattern.test(line)).length;
  } catch {
    return 0;
  }
}

function readProcMaps(pid: number): string {
  return readFileSync(`/proc/${pid}/maps`, "utf8");
}

function readProcComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}
