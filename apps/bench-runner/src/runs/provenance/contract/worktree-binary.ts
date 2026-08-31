export function encodeUint32Be(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xFFFFFFFF) {
    throw new Error("worktree identity frame length overflows uint32be");
  }
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(length);
  return encoded;
}

export function encodeLabeledPayload(label: string, payload: Buffer): Buffer {
  const labelBytes = Buffer.from(label, "utf8");
  return Buffer.concat([
    encodeUint32Be(labelBytes.length),
    labelBytes,
    encodeUint32Be(payload.length),
    payload
  ]);
}
