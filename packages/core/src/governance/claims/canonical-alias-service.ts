import {
  CanonicalAliasEntrySchema,
  CanonicalAliasMapSchema,
  CanonicalAliasDomain,
  CanonicalizationAliasResolvedPayloadSchema,
  CanonicalizationAppliedPayloadSchema,
  RuntimeGovernanceEventType,
  PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND,
  type PathAnchorDigestKind,
  canonicalGovernanceSubject,
  canonicalizeToken,
  governanceSubjectQualifierAliasDomain,
  type CanonicalAliasEntry,
  type CanonicalAliasMap,
  type EventLogEntry,
  type GovernanceSubject
} from "@do-soul/alaya-protocol";

interface ResolvedAliasValue {
  readonly canonical: string;
  readonly wasAliasResolved: boolean;
  readonly aliasEntry?: CanonicalAliasEntry;
}

export interface CanonicalAliasEventPublisherPort {
  publish(eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<Readonly<EventLogEntry>>;
}

export interface GovernanceSubjectCanonicalizationContext {
  readonly entityType: string;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly causedBy: string | null;
  readonly startingRevision?: number;
}

export interface GovernanceSubjectCanonicalizationPlan {
  readonly governanceSubject: GovernanceSubject;
  readonly eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[];
  readonly nextRevision: number;
}

export interface CanonicalAliasServiceDependencies {
  readonly aliasMap: CanonicalAliasMap;
  readonly eventPublisher?: CanonicalAliasEventPublisherPort;
  readonly now?: () => string;
}

interface CanonicalizationAccumulator {
  readonly eventInputs: Omit<EventLogEntry, "event_id" | "created_at" | "revision">[];
  nextRevision: number;
}

export class CanonicalAliasService {
  // The service owns a private mutable lookup so runtime/bootstrap seams may
  // register additional aliases after construction without exposing caller-owned maps.
  private readonly aliasesByDomain = new Map<string, Map<string, CanonicalAliasEntry>>();
  private readonly eventPublisher?: CanonicalAliasEventPublisherPort;
  private readonly now: () => string;

  public constructor(deps: CanonicalAliasServiceDependencies) {
    const parsedAliasMap = CanonicalAliasMapSchema.parse(deps.aliasMap);
    this.eventPublisher = deps.eventPublisher;
    this.now = deps.now ?? (() => new Date().toISOString());

    for (const entries of Object.values(parsedAliasMap)) {
      for (const entry of entries) {
        this.registerAlias(entry);
      }
    }
  }

  public resolve(input: string, domain: string): string {
    return this.resolveDetailed(input, domain).canonical;
  }

  public async publishGovernanceSubjectCanonicalization(
    domain: string,
    qualifiers: Record<string, string>,
    context: GovernanceSubjectCanonicalizationContext
  ): Promise<GovernanceSubject> {
    const plan = this.planGovernanceSubjectCanonicalization(domain, qualifiers, context);

    if (this.eventPublisher !== undefined) {
      for (const eventInput of plan.eventInputs) {
        await this.eventPublisher.publish(eventInput);
      }
    }

    return plan.governanceSubject;
  }

  public planGovernanceSubjectCanonicalization(
    domain: string,
    qualifiers: Record<string, string>,
    context: GovernanceSubjectCanonicalizationContext
  ): GovernanceSubjectCanonicalizationPlan {
    const accumulator: CanonicalizationAccumulator = {
      eventInputs: [],
      nextRevision: context.startingRevision ?? 0
    };

    this.appendResolvedValueEvents(
      accumulator,
      context,
      domain,
      CanonicalAliasDomain.GOVERNANCE_SUBJECT_DOMAIN,
      this.resolveDetailed(domain, CanonicalAliasDomain.GOVERNANCE_SUBJECT_DOMAIN)
    );
    this.appendQualifierCanonicalizationEvents(accumulator, context, qualifiers);

    return Object.freeze({
      governanceSubject: canonicalGovernanceSubject(domain, qualifiers, {
        aliasResolver: this.resolve.bind(this)
      }),
      eventInputs: Object.freeze(accumulator.eventInputs),
      nextRevision: accumulator.nextRevision
    });
  }

  public registerAlias(entry: CanonicalAliasEntry): void {
    const parsedEntry = CanonicalAliasEntrySchema.parse(entry);
    const normalizedDomain = canonicalizeToken(parsedEntry.domain);
    const normalizedAlias = canonicalizeToken(parsedEntry.alias);

    if (normalizedDomain.length === 0 || normalizedAlias.length === 0) {
      throw new Error("canonical alias entries must normalize to a non-empty domain and alias.");
    }

    const domainLookup = this.aliasesByDomain.get(normalizedDomain) ?? new Map<string, CanonicalAliasEntry>();
    domainLookup.set(normalizedAlias, parsedEntry);
    this.aliasesByDomain.set(normalizedDomain, domainLookup);
  }

  public resolveDigest(digest: string, digestKind: PathAnchorDigestKind): string {
    return this.resolve(digest, PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND[digestKind]);
  }

  private resolveDetailed(input: string, domain: string): ResolvedAliasValue {
    const normalizedInput = canonicalizeToken(input);

    if (normalizedInput.length === 0) {
      return {
        canonical: normalizedInput,
        wasAliasResolved: false
      };
    }

    const aliasEntry = this.aliasesByDomain.get(canonicalizeToken(domain))?.get(normalizedInput);

    if (aliasEntry === undefined) {
      return {
        canonical: normalizedInput,
        wasAliasResolved: false
      };
    }

    return {
      canonical: canonicalizeToken(aliasEntry.canonical),
      wasAliasResolved: true,
      aliasEntry
    };
  }

  private appendQualifierCanonicalizationEvents(
    accumulator: CanonicalizationAccumulator,
    context: GovernanceSubjectCanonicalizationContext,
    qualifiers: Record<string, string>
  ): void {
    for (const [rawKey, rawValue] of Object.entries(qualifiers)) {
      const normalizedKey = canonicalizeToken(rawKey);
      if (normalizedKey.length === 0) {
        continue;
      }
      const aliasDomain = governanceSubjectQualifierAliasDomain(normalizedKey);
      this.appendResolvedValueEvents(
        accumulator,
        context,
        rawValue,
        aliasDomain,
        this.resolveDetailed(rawValue, aliasDomain)
      );
    }
  }

  private appendResolvedValueEvents(
    accumulator: CanonicalizationAccumulator,
    context: GovernanceSubjectCanonicalizationContext,
    rawInput: string,
    aliasDomain: string,
    resolution: ResolvedAliasValue
  ): void {
    if (rawInput.trim().length === 0 || resolution.canonical.length === 0) {
      return;
    }

    accumulator.eventInputs.push({
      event_type: RuntimeGovernanceEventType.CANONICALIZATION_APPLIED,
      entity_type: context.entityType,
      entity_id: context.entityId,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: context.causedBy,
      payload_json: CanonicalizationAppliedPayloadSchema.parse({
        input: rawInput,
        canonical: resolution.canonical,
        domain: aliasDomain,
        was_alias_resolved: resolution.wasAliasResolved,
        applied_at: this.now()
      })
    });
    accumulator.nextRevision += 1;

    if (resolution.aliasEntry !== undefined) {
      accumulator.eventInputs.push({
        event_type: RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED,
        entity_type: context.entityType,
        entity_id: context.entityId,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.causedBy,
        payload_json: CanonicalizationAliasResolvedPayloadSchema.parse({
          alias: rawInput,
          canonical: resolution.canonical,
          domain: aliasDomain,
          language: resolution.aliasEntry.language,
          resolved_at: this.now()
        })
      });
      accumulator.nextRevision += 1;
    }
  }
}
