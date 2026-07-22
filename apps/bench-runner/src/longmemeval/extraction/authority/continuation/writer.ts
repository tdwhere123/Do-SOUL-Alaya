import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "../receipt.js";

export function writeContinuationAuthorityReceiptExclusive(
  outputPath: string,
  receipt: ExtractionAuthorityReceipt
): void {
  assertExtractionAuthorityReceipt(receipt, receipt.observation);
  if (receipt.continuation === undefined) {
    throw new Error("exclusive continuation writer requires continuation evidence");
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    try {
      linkSync(temporary, outputPath);
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const existing = readExtractionAuthorityReceipt(outputPath);
      if (existing.receipt_digest !== receipt.receipt_digest) {
        throw new Error("continuation authority output already belongs to another receipt");
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isAlreadyExistsError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}
