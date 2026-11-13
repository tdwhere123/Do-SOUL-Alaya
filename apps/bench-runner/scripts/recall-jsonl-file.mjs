import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";

/** Decode one record at a time; provenance hashes the original bytes, including line endings.
 * Parsed rows remain available to the existing fixed-census consumers. A single record is
 * still subject to Node's string limit; the file as a whole is not.
 */
export function readRecallJsonlFile(path, { skipWhitespace = false } = {}) {
  const fd = openSync(path, "r"), hash = createHash("sha256"), rows = [];
  let bytes = 0, parts = [];
  const parse = () => {
    const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
    parts = [];
    if (skipWhitespace ? line.trim() : line) rows.push(JSON.parse(line));
  };
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk); bytes += count;
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        parts.push(chunk.subarray(start, end));
        parse();
        start = end + 1;
      }
      if (start < count) parts.push(chunk.subarray(start));
    }
    if (parts.length) parse();
    return { rows, bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}
