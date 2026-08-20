const UNTRACKED_TAG = Buffer.from("alaya.bench.worktree-untracked.v2\0", "utf8");
const STATE_TAG = Buffer.from("alaya.bench.worktree-state.v3\0", "utf8");

export function decodeUntrackedWorktreeFrame(frame: Buffer): {
  readonly records: readonly {
    readonly path: string;
    readonly mode: number;
    readonly digestHex: string;
  }[];
  readonly starts: readonly number[];
} {
  if (frame.length === 0) return { records: [], starts: [] };
  if (!frame.subarray(0, UNTRACKED_TAG.length).equals(UNTRACKED_TAG)) {
    throw new Error("untracked frame tag mismatch");
  }
  const records: { path: string; mode: number; digestHex: string }[] = [];
  const starts: number[] = [];
  let offset = UNTRACKED_TAG.length;
  while (offset < frame.length) {
    starts.push(offset);
    const pathLength = readUint32Be(frame, offset);
    offset += 4;
    const path = frame.subarray(offset, offset + pathLength).toString("utf8");
    offset += pathLength;
    const mode = readUint32Be(frame, offset);
    offset += 4;
    const digestHex = frame.subarray(offset, offset + 32).toString("hex");
    offset += 32;
    records.push({ path, mode, digestHex });
  }
  if (offset !== frame.length) throw new Error("untracked frame trailing bytes");
  return { records, starts };
}

export function decodeWorktreeStateFrame(frame: Buffer): {
  readonly records: readonly { readonly label: string; readonly payload: Buffer }[];
  readonly starts: readonly number[];
} {
  if (!frame.subarray(0, STATE_TAG.length).equals(STATE_TAG)) {
    throw new Error("worktree state frame tag mismatch");
  }
  const records: { label: string; payload: Buffer }[] = [];
  const starts: number[] = [];
  let offset = STATE_TAG.length;
  while (offset < frame.length) {
    starts.push(offset);
    const labelLength = readUint32Be(frame, offset);
    offset += 4;
    const label = frame.subarray(offset, offset + labelLength).toString("utf8");
    offset += labelLength;
    const payloadLength = readUint32Be(frame, offset);
    offset += 4;
    const payload = frame.subarray(offset, offset + payloadLength);
    offset += payloadLength;
    records.push({ label, payload });
  }
  if (offset !== frame.length) throw new Error("worktree state frame trailing bytes");
  return { records, starts };
}

function readUint32Be(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) throw new Error("frame truncated at uint32be");
  return buffer.readUInt32BE(offset);
}
