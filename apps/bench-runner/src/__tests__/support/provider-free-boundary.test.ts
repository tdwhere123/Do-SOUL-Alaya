import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installProviderFreeBoundary } from "./provider-free-boundary.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "provider-boundary-fixture-")); directories.push(path); return path; };

it("admits only credential fixtures in directories allocated after the unit boundary, including missing files", async () => {
  const existing = temporary();
  writeFileSync(join(existing, "auth.json"), "operator-shaped synthetic data");
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    const owned = temporary(), env = join(owned, ".env");
    writeFileSync(env, "FIXTURE_KEY=not-a-real-credential");
    expect(readFileSync(env, "utf8")).toContain("not-a-real-credential");
    await expect(readFile(join(owned, ".aws", "credentials"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const asyncOwned = await mkdtemp(join(tmpdir(), "provider-boundary-async-")); directories.push(asyncOwned);
    await writeFile(join(asyncOwned, "auth.json"), "synthetic");
    await expect(readFile(join(asyncOwned, "auth.json"), "utf8")).resolves.toBe("synthetic");
    expect(() => readFileSync(join(existing, "auth.json"), "utf8")).toThrow("credential file");
    expect(isolation.violations).toEqual(["credential file"]);
  } finally { isolation.restore(); }
});

it("refuses credential links escaping a fresh fixture and an existing machine-home-shaped path", () => {
  const outside = temporary();
  writeFileSync(join(outside, "auth.json"), "synthetic operator data");
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    const owned = temporary();
    symlinkSync(join(outside, "auth.json"), join(owned, "auth.json"));
    linkSync(join(outside, "auth.json"), join(owned, "credentials.json"));
    expect(() => readFileSync(join(owned, "auth.json"), "utf8")).toThrow("credential file");
    expect(() => readFileSync(join(owned, "credentials.json"), "utf8")).toThrow("credential file");
    expect(() => readFileSync(join(outside, ".aws", "credentials"), "utf8")).toThrow("credential file");
    expect(isolation.violations).toEqual(["credential file", "credential file", "credential file"]);
  } finally { isolation.restore(); }
});

it("still blocks non-loopback transport and strips ambient credentials before application use", async () => {
  const environment = process.env;
  process.env = { ...environment, PROVIDER_FIXTURE_API_KEY: "synthetic" };
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    expect(process.env.PROVIDER_FIXTURE_API_KEY).toBeUndefined();
    await expect(fetch("https://provider-fixture.invalid/v1")).rejects.toThrow("non-loopback fetch");
    expect(isolation.violations).toEqual(["non-loopback fetch"]);
  } finally { isolation.restore(); process.env = environment; }
});

it("leaves local fixture transport available without following redirects", async () => {
  const original = globalThis.fetch;
  const native = vi.fn<typeof fetch>(async () => new Response("local fixture"));
  globalThis.fetch = native;
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    await expect(fetch("http://127.0.0.1:1234/fixture", { redirect: "follow" })).resolves.toBeInstanceOf(Response);
    expect(native).toHaveBeenCalledWith("http://127.0.0.1:1234/fixture", { redirect: "error" });
    expect(isolation.violations).toEqual([]);
  } finally { isolation.restore(); globalThis.fetch = original; }
});
