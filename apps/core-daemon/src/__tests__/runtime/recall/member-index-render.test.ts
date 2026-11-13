import { expect, it } from "vitest";
import { sourceIndexTarget, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { renderMemberIndex } from "../../../runtime/recall-read-worker/member-index.js";

const member = (root: string) => sourceIndexTarget(sourceRecallTarget({ workspace_id: "workspace-render", root_kind: "source_record",
  root_id: root, source_version: "v1", content_digest: `sha256:${"0".repeat(64)}`, evidence_object_id: null }), "source", 16);
const resources = { work: 1, memory_bytes: 1, native_bytes: 0, sql_internal_work: "unknown" as const };
const ready = (text: string) => ({ status: "ready" as const, statements: [], event_time: null, first_message: text, resources });

it("omits an unknown member but ends the list at the first budget refusal", () => {
  const listings = new Map<string, unknown>([
    ["root-a", ready("first")],
    ["root-b", { status: "unknown", reason: "source_template_stale:erased", resources }],
    ["root-c", ready("third")],
    ["root-d", { status: "resource_limited", reason: "member_listing_read_budget:payload", resources }],
    ["root-e", ready("never read")]
  ]);
  const read: string[] = [];
  const lines = renderMemberIndex({ readMemberListing: source => {
    const root = source.target.root_id;
    read.push(root);
    return listings.get(root) as ReturnType<Parameters<typeof renderMemberIndex>[0]["readMemberListing"]>;
  } }, { pool: ["root-a", "root-b", "root-c", "root-d", "root-e"].map(member), overflow: [], conditions: [], vectors: null },
  new Set(), 5);
  expect(lines.map(line => [line.label, line.root_id, line.line])).toEqual([["R06", "root-a", "first"], ["R07", "root-c", "third"]]);
  expect(read).toEqual(["root-a", "root-b", "root-c", "root-d"]);
});
