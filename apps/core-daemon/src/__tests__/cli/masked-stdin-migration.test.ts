import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecretLine } from "../../cli/install/masked-stdin.js";

function createMaskedTtyStdin(): PassThrough & {
  isRaw: boolean;
  setRawMode: (mode: boolean) => PassThrough & { isRaw: boolean; setRawMode: (mode: boolean) => unknown };
} {
  const stdin = new PassThrough() as PassThrough & {
    isRaw: boolean;
    setRawMode: (mode: boolean) => PassThrough & { isRaw: boolean; setRawMode: (mode: boolean) => unknown };
  };
  stdin.isRaw = false;
  stdin.setRawMode = (mode: boolean) => {
    stdin.isRaw = mode;
    return stdin;
  };
  return stdin;
}

describe("readSecretLine BL-062 migration", () => {
  it("accepts legacy boolean isTTY call sites", async () => {
    const stdin = createMaskedTtyStdin();
    const read = readSecretLine(stdin, new PassThrough(), true);
    stdin.write("legacy-secret\n");
    await expect(read).resolves.toBe("legacy-secret");
  });

  it("accepts options-object isTTY call sites with identical behavior", async () => {
    const stdin = createMaskedTtyStdin();
    const read = readSecretLine(stdin, new PassThrough(), { isTTY: true });
    stdin.write("options-secret\n");
    await expect(read).resolves.toBe("options-secret");
  });

  it("routes non-TTY legacy and options call sites through the same readline path", async () => {
    const stdin = new PassThrough();
    const legacyRead = readSecretLine(stdin, new PassThrough(), false);
    stdin.write("plain-secret\n");
    await expect(legacyRead).resolves.toBe("plain-secret");

    const optionsStdin = new PassThrough();
    const optionsRead = readSecretLine(optionsStdin, new PassThrough(), { isTTY: false });
    optionsStdin.write("plain-secret\n");
    await expect(optionsRead).resolves.toBe("plain-secret");
  });
});
