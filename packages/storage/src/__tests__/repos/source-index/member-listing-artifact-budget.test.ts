import { afterEach, expect, it, vi } from "vitest";
import { QUERY_BUDGET, fixture, type Fixture } from "./source-index-query-fixture.js";
import { publishMessages, publishStatement } from "./source-template-fixture.js";

// Real budget sweeps hit earlier reservations first; the target-read refusal window is too narrow to aim at reliably.
const forced = vi.hoisted(() => ({ limited: false }));
vi.mock("../../../repos/source-index/statement-artifact.js", async original => {
  const actual = await original<typeof import("../../../repos/source-index/statement-artifact.js")>();
  return { ...actual, readStatementIndexTarget: (...args: Parameters<typeof actual.readStatementIndexTarget>) =>
    forced.limited ? { status: "resource_limited" as const, resources: { work: 1, native_bytes: 0 } }
      : actual.readStatementIndexTarget(...args) };
});

const environments: Fixture[] = [];
afterEach(() => {
  forced.limited = false;
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
});

it("ends a member listing when the statement target read is refused by budget", () => {
  const environment = fixture(); environments.push(environment);
  const input = publishMessages(environment);
  publishStatement(environment, input, "artifact-target-refused");
  expect(environment.index.readMemberListing(input.source, null, QUERY_BUDGET)).toMatchObject({ status: "ready" });
  forced.limited = true;
  expect(environment.index.readMemberListing(input.source, null, QUERY_BUDGET))
    .toMatchObject({ status: "resource_limited", reason: "source_template_artifact_resource_limited" });
  expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET))
    .toMatchObject({ status: "unknown", reason: "source_template_artifact_resource_limited" });
});
