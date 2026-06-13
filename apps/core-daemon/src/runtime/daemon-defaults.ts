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

// Alaya ships without built-in PathRelation seeds. PathRelation rows are
// ontology structure, so daemon defaults must not invent a workspace-level
// relation merely to make path tables non-empty. Operators or future ontology
// packages can supply explicit templates through this wiring point.
export const defaultBootstrappingTemplates: readonly BootstrappingPathTemplate[] = [] as const;
