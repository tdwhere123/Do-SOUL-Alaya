import { createHash } from "node:crypto";
import {
  ConstitutionalFragmentIdSchema,
  type ConstitutionalFragment,
  type ConstitutionalFragmentRegistration
} from "@do-what/protocol";
import type {
  ConstitutionalFragmentService,
  ConstitutionalFragmentStorePort
} from "@do-what/core";

type StaticConstitutionalFragmentDefinition = Readonly<{
  readonly category: ConstitutionalFragmentRegistration["category"];
  readonly content: string;
  readonly authority_source: string;
}>;

type ClaimFormRepoPort = {
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<{
    enforcement_level: string;
    object_id: string;
    proposition_digest: string;
  }>[]>;
};

export type ServerHardConstraint = Readonly<{
  ref: string;
  resolved_ref?: string;
  content: string;
}>;

export function createInMemoryConstitutionalFragmentStore(): ConstitutionalFragmentStorePort {
  const fragmentsById = new Map<string, Readonly<ConstitutionalFragment>>();

  return {
    findById: async (fragmentId) => fragmentsById.get(fragmentId) ?? null,
    register: async (fragment) => {
      const existing = fragmentsById.get(fragment.fragment_id);

      if (existing !== undefined) {
        if (!areConstitutionalFragmentsEqual(existing, fragment)) {
          throw new Error(
            `Conflicting constitutional fragment registration for ${fragment.fragment_id}`
          );
        }

        return existing;
      }

      fragmentsById.set(fragment.fragment_id, fragment);
      return fragment;
    },
    findByWorkspace: async (workspaceId) =>
      Object.freeze(
        [...fragmentsById.values()].filter((fragment) => fragment.workspace_id === workspaceId)
      ),
    findByCategory: async (workspaceId, category) =>
      Object.freeze(
        [...fragmentsById.values()].filter(
          (fragment) =>
            fragment.category === category && fragment.workspace_id === workspaceId
        )
      )
  };
}

export function createWorkspaceConstitutionalFragmentReader(params: {
  readonly service: ConstitutionalFragmentService;
  readonly staticFragments: readonly Readonly<StaticConstitutionalFragmentDefinition>[];
}): {
  listForWorkspace(workspaceId: string): Promise<readonly Readonly<ConstitutionalFragment>[]>;
} {
  return {
    listForWorkspace: async (workspaceId) => {
      for (const fragment of params.staticFragments) {
        await params.service.ensureRegistered({
          workspace_id: workspaceId,
          category: fragment.category,
          content: fragment.content,
          authority_source: fragment.authority_source
        });
      }

      return await params.service.listForWorkspace(workspaceId);
    }
  };
}

export function resolveConstitutionalFragmentId(
  request: Readonly<ConstitutionalFragmentRegistration>
): ConstitutionalFragment["fragment_id"] {
  if (
    request.category === "hard_constraint" &&
    request.authority_source === "system.worker_dispatch"
  ) {
    return parseConstitutionalFragmentId(
      `constitutional://${request.workspace_id}/${request.category}/${normalizeFragmentIdSegment(
        request.authority_source
      )}-${createStaticConstitutionalFragmentVersionToken(request.content)}`
    );
  }

  return parseConstitutionalFragmentId(
    `constitutional://${request.workspace_id}/${request.category}/${normalizeFragmentIdSegment(
      request.authority_source
    )}`
  );
}

export function getStaticWorkerDispatchConstitutionalFragments(): readonly Readonly<StaticConstitutionalFragmentDefinition>[] {
  return Object.freeze([
    Object.freeze({
      category: "hard_constraint",
      content: "Never mutate files outside approved workspace roots.",
      authority_source: "system.worker_dispatch"
    })
  ]);
}

export function createServerHardConstraintLister(input: {
  readonly claimFormRepo: ClaimFormRepoPort;
}): (workspaceId: string) => Promise<readonly ServerHardConstraint[]> {
  return async (workspaceId) =>
    Object.freeze(
      dedupeServerHardConstraintsByRef([
        ...getStaticWorkerDispatchHardConstraintAliases(workspaceId),
        ...(await input.claimFormRepo.findByWorkspaceId(workspaceId))
          .filter((claim) => claim.enforcement_level === "strict")
          .map((claim) =>
            Object.freeze({
              ref: claim.object_id,
              resolved_ref: claim.object_id,
              content: claim.proposition_digest
            })
          )
      ])
    );
}

function areConstitutionalFragmentsEqual(
  left: Readonly<ConstitutionalFragment>,
  right: Readonly<ConstitutionalFragment>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeFragmentIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function createStaticConstitutionalFragmentVersionToken(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function parseConstitutionalFragmentId(
  value: string
): ConstitutionalFragment["fragment_id"] {
  return ConstitutionalFragmentIdSchema.parse(value);
}

function getStaticWorkerDispatchHardConstraintAliases(
  workspaceId: string
): readonly ServerHardConstraint[] {
  return Object.freeze(
    getStaticWorkerDispatchConstitutionalFragments()
      .filter((fragment) => fragment.category === "hard_constraint")
      .map((fragment) =>
        Object.freeze({
          ref: resolveStaticHardConstraintAlias(fragment.authority_source),
          resolved_ref: resolveConstitutionalFragmentId({
            workspace_id: workspaceId,
            category: fragment.category,
            content: fragment.content,
            authority_source: fragment.authority_source
          }),
          content: fragment.content
        })
      )
  );
}

function resolveStaticHardConstraintAlias(authoritySource: string): string {
  if (authoritySource === "system.worker_dispatch") {
    return "constraint://worker-dispatch";
  }

  return `constraint://${normalizeFragmentIdSegment(authoritySource)}`;
}

function dedupeServerHardConstraintsByRef(
  constraints: readonly ServerHardConstraint[]
): readonly ServerHardConstraint[] {
  const constraintsByRef = new Map<string, ServerHardConstraint>();

  for (const constraint of constraints) {
    if (!constraintsByRef.has(constraint.ref)) {
      constraintsByRef.set(constraint.ref, constraint);
    }
  }

  return Object.freeze([...constraintsByRef.values()]);
}
