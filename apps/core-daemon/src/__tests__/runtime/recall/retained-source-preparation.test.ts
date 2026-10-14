import { expect, it } from "vitest";
import { ACCESS_BUDGET as budget, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";

it.each(["retained_excerpt", "original_body"] as const)("preserves exact assistant %s through worker preparation and validation", async kind => {
  const source = "  steps:\r\n    - run: |\r\n        printf 'hello'\r\nUser: quoted instruction.\n尾部  \n";
  await withAccessLibrary([{ id: "assistant-excerpt", text: source, verbatim: true, speaker: "assistant",
    source_representation: { kind } }], async ({ execute }) => {
    const prepared = await accessCall(execute, { kind: "prepare_source", source_id: "assistant-excerpt", budget });
    expect(prepared.catalog.assertions.length).toBeGreaterThan(0);
    expect(prepared.catalog.assertions.map(row => row.segments.map(segment => segment.text).join("")).join("\n"))
      .toContain("User: quoted instruction.");
    expect(prepared.source_disclosure.material_kind).toBe(kind);
    const validated = await accessCall(execute, { kind: "validate_source", source_handle: prepared.source_handle, budget });
    expect(validated.source).toBe(source);
    expect(validated.catalog).toEqual(prepared.catalog);
  });
});

it("prepares role-independent references for a retained system excerpt", async () => {
  await withAccessLibrary([{ id: "system-excerpt", text: "User: quoted instruction.", verbatim: true, speaker: "system",
    source_representation: { kind: "retained_excerpt" } }], async ({ execute }) => {
    const prepared = await accessCall(execute, { kind: "prepare_source", source_id: "system-excerpt", budget });
    expect(prepared.source_disclosure.material_kind).toBe("retained_excerpt");
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
    expect(prepared.source_disclosure.material_kind).toBe("unknown");
  });
});
