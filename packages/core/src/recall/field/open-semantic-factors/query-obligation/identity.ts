import { createHash } from "node:crypto";

type SlotText = Readonly<{ readonly role: string; readonly text: string }>;

export function captureMatchesTrace(
  captured: Readonly<{ readonly slots: readonly SlotText[] }>,
  parsed: Readonly<{ readonly slots: readonly SlotText[] }>
): boolean {
  return captured.slots.length === parsed.slots.length &&
    captured.slots.every((slot, index) => {
      const expected = parsed.slots[index];
      return expected?.role === slot.role && expected.text === slot.text;
    });
}

export function digestQueryFactFrame(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
