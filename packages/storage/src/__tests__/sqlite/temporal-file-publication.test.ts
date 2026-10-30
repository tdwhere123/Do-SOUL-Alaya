import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markTemporalDatabaseEstablished,
  publishNewTemporalFile,
  syncTemporalDirectory,
  temporalEstablishedMarker
} from "../../sqlite/temporal-file-publication.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const platform = process.platform;
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
  for (const directory of directories.splice(0)) removeTempDirectorySync(directory);
});

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-publication-"));
  directories.push(directory);
  return directory;
}

function ioError(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

describe("temporal file publication durability", () => {
  it("flushes files with write access and retains existing marker contents on Windows", () => {
    const directory = fixture();
    const staging = path.join(directory, "staging");
    const destination = path.join(directory, "published");
    fs.writeFileSync(staging, "complete contents");
    Object.defineProperty(process, "platform", { value: "win32" });
    const open = vi.spyOn(fs, "openSync");
    const sync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw ioError("EPERM");
      expect(open.mock.calls.at(-1)?.[1]).not.toBe("r");
      sync(descriptor);
    });
    publishNewTemporalFile(staging, destination);
    expect(fs.readFileSync(destination, "utf8")).toBe("complete contents");
    markTemporalDatabaseEstablished(destination);
    const marker = temporalEstablishedMarker(destination);
    const contents = fs.readFileSync(marker);
    markTemporalDatabaseEstablished(destination);
    expect(fs.readFileSync(marker)).toEqual(contents);
    expect(open).toHaveBeenCalledWith(staging, "r+");
    expect(open).toHaveBeenCalledWith(marker, "r+");
  });

  it.each([["win32", "EIO"], ["linux", "EPERM"]] as const)(
    "propagates directory flush %s / %s and closes the descriptor", (host, code) => {
      const directory = fixture();
      Object.defineProperty(process, "platform", { value: host });
      const failure = ioError(code);
      vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
      const close = vi.spyOn(fs, "closeSync");
      expect(() => syncTemporalDirectory(directory)).toThrow(failure);
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it("never publishes a file after a file flush permission failure on Windows", () => {
    const directory = fixture();
    const staging = path.join(directory, "staging");
    const destination = path.join(directory, "published");
    fs.writeFileSync(staging, "complete contents");
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw ioError("EPERM"); });
    expect(() => publishNewTemporalFile(staging, destination)).toThrow("EPERM");
    expect(fs.existsSync(destination)).toBe(false);
  });
});
