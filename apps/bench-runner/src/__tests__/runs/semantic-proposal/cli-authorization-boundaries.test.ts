import { expect, it, vi } from "vitest";
const ports = vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  return { prepare: vi.fn(() => ({})), fill: vi.fn(async () => ({})), pin: vi.fn(() => ({ price: {}, limits: {} })), write: vi.fn() };
});
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: (path: string, ...args: unknown[]) => path === "synthetic" ? "{}"
    : Reflect.apply(fs.readFileSync, fs, [path, ...args]) };
});
vi.mock("../../../runs/semantic-proposal/workset.js", () => ({
  parseSemanticProposalWorkset: () => ({ kind: "query", model: "gemini-3-flash-preview",
    request_profile: "gemini-3.1-low-v1", provider_url: "http://127.0.0.1:1" }),
  SEMANTIC_PROPOSAL_OUTPUT_TOKEN_DEFAULT: 4096
}));
vi.mock("../../../runs/semantic-proposal/authority.js", () => ({
  DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY: 2,
  parseSemanticProposalPreflight: () => ({ execution_scope: { execution_root_path: "/synthetic" } }),
  pinSemanticProposalAuthority: ports.pin, readSemanticProposalAuthority: () => ({}), writeJsonExclusive: ports.write
}));
vi.mock("../../../runs/semantic-proposal/fill.js", () => ({ executeSemanticProposalFill: ports.fill, prepareSemanticProposal: ports.prepare }));
vi.mock("../../../runs/extraction/authority/target-root-binding.js", () => ({ canonicalExtractionTargetRoot: () => "/synthetic" }));
import { createGardenHttpExtractor } from "../../../runs/compile-seed/compile-seed-http.js";
const { runSemanticProposalFillCommand } = await import("../../../cli/semantic-proposal-fill/command.js");
const base = ["--kind=query", "--workset=synthetic", "--cache-root=synthetic"];

it("preserves Step request admission through the actual Garden extractor without a transport attempt", async () => {
  const fetchGuard = vi.mocked(globalThis.fetch);
  fetchGuard.mockClear();
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "1");
  const extractor = createGardenHttpExtractor({ providerUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic",
    model: "step-3.5-flash-2603", requestProfile: "step-3.5-2603-low-json-schema-v1" });
  await expect(extractor.extract({ systemPrompt: "system", userPrompt: "user", maxOutputTokens: 128 }))
    .rejects.toMatchObject({ cause: { code: "VALIDATION" } });
  expect(fetchGuard).not.toHaveBeenCalled();
});

it("surfaces the configured secret-reference failure before any fill or alternate credential dispatch", async () => {
  process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:MISSING_SYNTHETIC";
  process.env.OFFICIAL_API_GARDEN_API_KEY = "synthetic-alternate-account";
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.fill.mockClear();
  try {
    expect(await runSemanticProposalFillCommand([...base, "--action=fill", "--authority=synthetic"])).toBe(2);
    expect(ports.fill).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).toContain("env_missing");
    expect(stderr.mock.calls.flat().join("")).not.toContain("synthetic-alternate-account");
    delete process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF;
    expect(await runSemanticProposalFillCommand([...base, "--action=fill", "--authority=synthetic"])).toBe(0);
    expect(ports.fill).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ apiKey: "synthetic-alternate-account" }) }));
  } finally { stderr.mockRestore(); delete process.env.OFFICIAL_API_GARDEN_API_KEY; }
});

it.each([
  ["--max-output-tokens=128", "--max-attempts-per-key=1"],
  ["--max-output-tokens", "128", "--max-attempts-per-key", "1"]
])("preserves optional finite caps in either flag form", async (...flags) => {
  ports.prepare.mockClear();
  expect(await runSemanticProposalFillCommand([...base, "--action=prepare", "--preflight-out=synthetic", ...flags])).toBe(0);
  expect(ports.prepare).toHaveBeenCalledWith(expect.anything(), "synthetic", 128, 1);
});

it("passes an inline spend ceiling to the authority owner and rejects repeated caps", async () => {
  ports.pin.mockClear();
  expect(await runSemanticProposalFillCommand([...base, "--action=authorize", "--preflight=synthetic", "--receipt-out=synthetic",
    "--input-price-usd-per-million=1", "--output-price-usd-per-million=2", "--spend-ceiling-usd=0.01"])).toBe(0);
  expect(ports.pin).toHaveBeenCalledWith(expect.objectContaining({ spendCeilingUsd: 0.01 }));
  ports.prepare.mockClear();
  expect(await runSemanticProposalFillCommand([...base, "--action=prepare", "--max-output-tokens=128", "--max-output-tokens", "256"])).toBe(2);
  expect(ports.prepare).not.toHaveBeenCalled();
});
