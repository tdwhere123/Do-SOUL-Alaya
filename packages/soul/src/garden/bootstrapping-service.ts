import {
  BootstrappingPathTemplateSchema,
  BootstrappingRecordSchema,
  PathRelationSchema,
  type BootstrappingPathTemplate,
  type BootstrappingRecord,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { buildBootstrappingPathId, buildBootstrappingRecordId } from "../shared/bootstrapping-ids.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface BootstrappingDependencies {
  readonly templates: readonly Readonly<BootstrappingPathTemplate>[];
  readonly now?: () => string;
}

interface BootstrappingPlan {
  readonly relations: readonly Readonly<PathRelation>[];
  readonly record: Readonly<BootstrappingRecord>;
}

export class BootstrappingService {
  private readonly templates: readonly Readonly<BootstrappingPathTemplate>[];
  private readonly now: () => string;

  public constructor(deps: BootstrappingDependencies) {
    this.templates = deps.templates.map((template) => parseTemplate(template));
    this.now = deps.now ?? defaultBootstrappingNow;
  }

  public async planBootstrap(workspaceId: string): Promise<Readonly<BootstrappingPlan>> {
    const plantedAt = this.now();
    const relations = this.templates.map((template) =>
      parsePathRelation({
        path_id: buildBootstrappingPathId(workspaceId, template.template_id),
        workspace_id: workspaceId,
        anchors: {
          source_anchor: buildAnchor(workspaceId, template.source_anchor_template),
          target_anchor: buildAnchor(workspaceId, template.target_anchor_template)
        },
        constitution: {
          relation_kind: template.relation_kind,
          why_this_relation_exists: template.why_this_relation_exists
        },
        effect_vector: {
          salience: template.default_strength,
          recall_bias: 0,
          verification_bias: template.default_strength,
          unfinishedness_bias: 0,
          default_manifestation_preference: template.default_manifestation_preference
        },
        plasticity_state: {
          strength: template.default_strength,
          direction_bias: "source_to_target",
          stability_class: template.default_stability_class,
          support_events_count: 0,
          contradiction_events_count: 0
        },
        lifecycle: {
          retirement_rule: "consolidation_only"
        },
        legitimacy: {
          evidence_basis: [`bootstrapping:${template.template_id}`],
          governance_class: template.default_governance_class
        },
        created_at: plantedAt,
        updated_at: plantedAt
      })
    );

    const record = parseBootstrappingRecord({
      record_id: buildBootstrappingRecordId(workspaceId),
      workspace_id: workspaceId,
      paths_planted: relations.length,
      template_ids_used: this.templates.map((template) => template.template_id),
      planted_at: plantedAt
    });

    return deepFreeze({
      relations,
      record
    });
  }
}

function parseTemplate(template: BootstrappingPathTemplate): Readonly<BootstrappingPathTemplate> {
  return deepFreeze(BootstrappingPathTemplateSchema.parse(template));
}

function parsePathRelation(relation: PathRelation): Readonly<PathRelation> {
  return deepFreeze(PathRelationSchema.parse(relation));
}

function parseBootstrappingRecord(record: BootstrappingRecord): Readonly<BootstrappingRecord> {
  return deepFreeze(BootstrappingRecordSchema.parse(record));
}

function buildAnchor(
  workspaceId: string,
  anchorTemplate: BootstrappingPathTemplate["source_anchor_template"]
): PathAnchorRef {
  if (anchorTemplate.kind === "object") {
    return {
      kind: "object",
      object_id: workspaceId
    };
  }

  return {
    kind: "object_facet",
    object_id: workspaceId,
    facet_key: anchorTemplate.description
  };
}

function defaultBootstrappingNow(): string {
  return new Date().toISOString();
}
