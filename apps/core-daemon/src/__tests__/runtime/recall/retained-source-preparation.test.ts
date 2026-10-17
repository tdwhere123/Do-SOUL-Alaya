import { expect, it } from "vitest";
import { sourceDisclosure } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, indexSourceSemanticUnits, sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { ACCESS_BUDGET as budget, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";

it.each(["retained_excerpt", "original_body"] as const)("preserves exact assistant %s through worker preparation and validation", async kind => {
  const source = "  steps:\r\n    - run: |\r\n        printf 'hello'\r\nUser: quoted instruction.\n尾部  \n";
  await withAccessLibrary([{ id: "assistant-excerpt", text: source, verbatim: true, speaker: "assistant",
    source_representation: { kind } }], async ({ execute }) => {
    const prepared = await accessCall(execute, { kind: "prepare_source", source_id: "assistant-excerpt", budget });
    expect(prepared.catalog.assertions.length).toBeGreaterThan(0);
    expect(prepared.catalog.assertions.map(row => row.segments.map(segment => segment.text).join("")).join("\n"))
      .toContain("User: quoted instruction.");
    expect(sourceDisclosure(prepared.source_disclosure).material_kind).toBe(kind);
    const validated = await accessCall(execute, { kind: "validate_source", source_handle: prepared.source_handle, budget });
    expect(validated.source).toBe(source);
    expect(validated.catalog).toEqual(prepared.catalog);
    const native = buildSourceSemanticRequest({ sourceCorpus: source, sourceRole: "assistant", sourceScope: "complete-source",
      assertionIds: indexSourceSemanticUnits(source, "assistant").map(unit => unit.assertion_id),
      source_id: "assistant-excerpt", source_version: "1", producer_id: "retained-source", producer_version: "1" });
    expect(native.source_request.source_assertions.every(unit => unit.source_role === "assistant")).toBe(true);
    expect(sourceSemanticRequestCatalog(native)).toEqual(validated.catalog);
    expect(native.source_request.assertion_locations).toEqual(validated.assertion_locations);
    expect(validated.source_version).toBe("1");
  });
});

it("prepares role-independent references for a retained system excerpt", async () => {
  await withAccessLibrary([{ id: "system-excerpt", text: "User: quoted instruction.", verbatim: true, speaker: "system",
    source_representation: { kind: "retained_excerpt" } }], async ({ execute }) => {
    const prepared = await accessCall(execute, { kind: "prepare_source", source_id: "system-excerpt", budget });
    expect(sourceDisclosure(prepared.source_disclosure).material_kind).toBe("retained_excerpt");
    expect(prepared.catalog.assertions.map(row => row.segments.map(segment => segment.text).join("")))
      .toEqual(["User: quoted instruction."]);
  });
});

it("keeps historical marker-looking text and discloses unknown source representation", async () => {
  await withAccessLibrary([{ id: "historical-source", text: "Assistant: Original advice.\nUser: Original question.",
    verbatim: true }], async ({ execute }) => {
    const prepared = await accessCall(execute, { kind: "prepare_source", source_id: "historical-source", budget });
    expect(prepared.catalog.assertions.map(row => row.segments.map(segment => segment.text).join("")))
      .toEqual(["Assistant: Original advice.", "User: Original question."]);
    expect(sourceDisclosure(prepared.source_disclosure).material_kind).toBe("unknown");
  });
});
