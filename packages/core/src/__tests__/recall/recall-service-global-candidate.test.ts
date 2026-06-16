import { describe, expect, it } from "vitest";
import {
  ProjectMappingState,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";
import { classifyGlobalCandidate } from "../../recall/recall-service.js";
import { createAnchor } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  it("classifyGlobalCandidate only includes accepted and adapted anchors for future global supply", () => {
    const anchorMap = new Map<string, Readonly<ProjectMappingAnchor>>([
      [
        "global-accepted",
        createAnchor({
          object_id: "mapping-accepted",
          global_object_id: "global-accepted",
          mapping_state: ProjectMappingState.ACCEPTED
        })
      ],
      [
        "global-adapted",
        createAnchor({
          object_id: "mapping-adapted",
          global_object_id: "global-adapted",
          mapping_state: ProjectMappingState.ADAPTED
        })
      ],
      [
        "global-suggested",
        createAnchor({
          object_id: "mapping-suggested",
          global_object_id: "global-suggested",
          mapping_state: ProjectMappingState.SUGGESTED
        })
      ],
      [
        "global-probationary",
        createAnchor({
          object_id: "mapping-probationary",
          global_object_id: "global-probationary",
          mapping_state: ProjectMappingState.PROBATIONARY
        })
      ],
      [
        "global-rejected",
        createAnchor({
          object_id: "mapping-rejected",
          global_object_id: "global-rejected",
          mapping_state: ProjectMappingState.REJECTED
        })
      ],
      [
        "global-not-applicable",
        createAnchor({
          object_id: "mapping-not-applicable",
          global_object_id: "global-not-applicable",
          mapping_state: ProjectMappingState.NOT_APPLICABLE
        })
      ]
    ]);

    expect(classifyGlobalCandidate({ global_object_id: "global-missing" }, anchorMap)).toEqual({
      include: false,
      reason: "no_anchor",
      anchor_state: null
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-accepted" }, anchorMap)).toEqual({
      include: true,
      reason: "adopted",
      anchor_state: ProjectMappingState.ACCEPTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-adapted" }, anchorMap)).toEqual({
      include: true,
      reason: "adopted",
      anchor_state: ProjectMappingState.ADAPTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-suggested" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:suggested",
      anchor_state: ProjectMappingState.SUGGESTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-probationary" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:probationary",
      anchor_state: ProjectMappingState.PROBATIONARY
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-rejected" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:rejected",
      anchor_state: ProjectMappingState.REJECTED
    });
    expect(classifyGlobalCandidate({ global_object_id: "global-not-applicable" }, anchorMap)).toEqual({
      include: false,
      reason: "not_adopted:not_applicable",
      anchor_state: ProjectMappingState.NOT_APPLICABLE
    });
  });
});
