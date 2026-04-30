import type { CanonicalAliasMap, BootstrappingPathTemplate } from "@do-soul/alaya-protocol";

export const defaultCanonicalAliasMap: CanonicalAliasMap = {
  "governance_subject.domain": [
    {
      alias: "用户偏好",
      canonical: "user_preference",
      language: "zh",
      domain: "governance_subject.domain"
    }
  ],
  "governance_subject.qualifier.framework": [
    {
      alias: "类型脚本",
      canonical: "typescript",
      language: "zh",
      domain: "governance_subject.qualifier.framework"
    }
  ]
};

export const defaultBootstrappingTemplates: readonly BootstrappingPathTemplate[] = [
  {
    template_id: "workspace.bootstrap.conservative-start",
    relation_kind: "supports",
    why_this_relation_exists: ["new workspace starts with conservative learned-path defaults"],
    source_anchor_template: {
      kind: "object",
      description: "workspace"
    },
    target_anchor_template: {
      kind: "object_facet",
      description: "conservative_start"
    },
    default_strength: 0.1,
    default_stability_class: "volatile",
    default_governance_class: "hint_only",
    default_manifestation_preference: "stance_bias"
  }
] as const;
