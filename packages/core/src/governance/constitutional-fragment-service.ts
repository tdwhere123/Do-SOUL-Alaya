import { createHash } from "node:crypto";
import {
  ConstitutionalFragmentCategorySchema,
  ConstitutionalFragmentIdSchema,
  ConstitutionalFragmentRegistrationSchema,
  ConstitutionalFragmentRegisteredPayloadSchema,
  ConstitutionalFragmentSchema,
  RuntimeGovernanceEventType,
  listConstitutionalFragmentIdentityParts,
  type ConstitutionalFragment,
  type ConstitutionalFragmentCategory,
  type ConstitutionalFragmentRegisteredPayload,
  type ConstitutionalFragmentRegistration,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisher } from "../runtime/event-publisher.js";
import { SYSTEM_ACTOR } from "../shared/actors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { readNow } from "../shared/time.js";

export interface ConstitutionalFragmentStorePort {
  findById(
    fragmentId: ConstitutionalFragment["fragment_id"]
  ): Promise<Readonly<ConstitutionalFragment> | null>;
  register(fragment: ConstitutionalFragment): Promise<Readonly<ConstitutionalFragment>>;
  /**
   * Sync sibling for use inside `EventPublisher.appendManyWithMutation`.
   * The hydrate path that runs the registration mutation in the same
   * transaction as the EventLog append needs a synchronous insert.
   */
  registerSync(fragment: ConstitutionalFragment): Readonly<ConstitutionalFragment>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ConstitutionalFragment>[]>;
  findByCategory(
    workspaceId: string,
    category: ConstitutionalFragmentCategory
  ): Promise<readonly Readonly<ConstitutionalFragment>[]>;
}

export interface ConstitutionalFragmentEventLogReaderPort {
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ConstitutionalFragmentServiceDependencies {
  readonly fragmentStore: ConstitutionalFragmentStorePort;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  readonly eventLogReader?: ConstitutionalFragmentEventLogReaderPort;
  readonly now?: () => string;
  readonly generateFragmentId?: (
    request: Readonly<ConstitutionalFragmentRegistration>
  ) => ConstitutionalFragment["fragment_id"];
}

export class ConstitutionalFragmentService {
  private readonly inFlightRegistrations = new Map<
    string,
    Promise<Readonly<ConstitutionalFragment>>
  >();

  public constructor(private readonly deps: ConstitutionalFragmentServiceDependencies) {}

  public async ensureRegistered(
    request: ConstitutionalFragmentRegistration
  ): Promise<Readonly<ConstitutionalFragment>> {
    const parsedRequest = parseRegistration(request);
    const fragmentId = this.resolveFragmentId(parsedRequest);
    const existing = await this.deps.fragmentStore.findById(fragmentId);

    if (existing !== null) {
      return parseFragment(existing);
    }

    const inFlight = this.inFlightRegistrations.get(fragmentId);
    if (inFlight !== undefined) {
      return await inFlight;
    }

    const pending = this.ensureRegisteredOnce(parsedRequest, fragmentId);
    this.inFlightRegistrations.set(fragmentId, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightRegistrations.get(fragmentId) === pending) {
        this.inFlightRegistrations.delete(fragmentId);
      }
    }
  }

  private async ensureRegisteredOnce(
    parsedRequest: Readonly<ConstitutionalFragmentRegistration>,
    fragmentId: ConstitutionalFragment["fragment_id"]
  ): Promise<Readonly<ConstitutionalFragment>> {
    const existing = await this.deps.fragmentStore.findById(fragmentId);
    if (existing !== null) {
      return parseFragment(existing);
    }

    const hydrated = await this.loadFromDurableRegistration(parsedRequest, fragmentId);
    if (hydrated !== null) {
      return await this.hydrate(hydrated);
    }

    return await this.register(parsedRequest);
  }

  public async register(
    request: ConstitutionalFragmentRegistration
  ): Promise<Readonly<ConstitutionalFragment>> {
    const parsedRequest = parseRegistration(request);
    const fragment = createFragment(
      parsedRequest,
      this.resolveFragmentId(parsedRequest),
      readNow(this.deps.now)
    );
    return await this.deps.eventPublisher.appendManyWithMutation(
      [createConstitutionalFragmentRegisteredEvent(fragment)],
      () => this.hydrateSync(fragment)
    );
  }

  public async listForWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<ConstitutionalFragment>[]> {
    return Object.freeze(
      (await this.deps.fragmentStore.findByWorkspace(workspaceId)).map((fragment) =>
        parseFragment(fragment)
      )
    );
  }

  public async listByCategory(
    workspaceId: string,
    category: ConstitutionalFragmentCategory
  ): Promise<readonly Readonly<ConstitutionalFragment>[]> {
    const parsedCategory = parseCategory(category);

    return Object.freeze(
      (await this.deps.fragmentStore.findByCategory(workspaceId, parsedCategory)).map((fragment) =>
        parseFragment(fragment)
      )
    );
  }

  private resolveFragmentId(
    request: Readonly<ConstitutionalFragmentRegistration>
  ): ConstitutionalFragment["fragment_id"] {
    return parseFragmentId(this.deps.generateFragmentId?.(request) ?? createDefaultFragmentId(request));
  }

  private async hydrate(
    fragment: ConstitutionalFragment
  ): Promise<Readonly<ConstitutionalFragment>> {
    return parseFragment(await this.deps.fragmentStore.register(parseFragment(fragment)));
  }

  private hydrateSync(
    fragment: ConstitutionalFragment
  ): Readonly<ConstitutionalFragment> {
    return parseFragment(this.deps.fragmentStore.registerSync(parseFragment(fragment)));
  }

  private async loadFromDurableRegistration(
    request: Readonly<ConstitutionalFragmentRegistration>,
    fragmentId: ConstitutionalFragment["fragment_id"]
  ): Promise<Readonly<ConstitutionalFragment> | null> {
    if (this.deps.eventLogReader === undefined) {
      return null;
    }

    const events = await this.deps.eventLogReader.queryByEntity("constitutional_fragment", fragmentId);
    const registrationEvent = [...events]
      .reverse()
      .find((event) => event.event_type === RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED);

    if (registrationEvent === undefined) {
      return null;
    }

    const payload = parseRegisteredPayloadFromEvent(registrationEvent);
    if (
      payload.fragment_id !== fragmentId ||
      payload.workspace_id !== request.workspace_id ||
      payload.category !== request.category ||
      payload.authority_source !== request.authority_source
    ) {
      throw new CoreError(
        "CONFLICT",
        "Constitutional fragment registration history conflicts with requested identity"
      );
    }

    if (payload.content_sha256 !== hashConstitutionalFragmentContent(request.content)) {
      throw new CoreError(
        "CONFLICT",
        "Constitutional fragment registration history conflicts with requested content"
      );
    }

    return createFragment(request, fragmentId, payload.registered_at);
  }
}

function parseRegistration(
  value: ConstitutionalFragmentRegistration
): Readonly<ConstitutionalFragmentRegistration> {
  try {
    return deepFreeze(ConstitutionalFragmentRegistrationSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid constitutional fragment registration", {
      cause: error
    });
  }
}

function parseFragment(value: ConstitutionalFragment): Readonly<ConstitutionalFragment> {
  try {
    return deepFreeze(ConstitutionalFragmentSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid constitutional fragment payload", {
      cause: error
    });
  }
}

function parseCategory(category: ConstitutionalFragmentCategory): ConstitutionalFragmentCategory {
  try {
    return ConstitutionalFragmentCategorySchema.parse(category);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid constitutional fragment category", {
      cause: error
    });
  }
}

function parseFragmentId(value: string): ConstitutionalFragment["fragment_id"] {
  try {
    return ConstitutionalFragmentIdSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid constitutional fragment id", {
      cause: error
    });
  }
}

function createFragment(
  request: Readonly<ConstitutionalFragmentRegistration>,
  fragmentId: ConstitutionalFragment["fragment_id"],
  registeredAt: string
): Readonly<ConstitutionalFragment> {
  return parseFragment({
    fragment_id: fragmentId,
    workspace_id: request.workspace_id,
    category: request.category,
    content: request.content,
    authority_source: request.authority_source,
    immutable: true,
    registered_at: registeredAt
  });
}

function createConstitutionalFragmentRegisteredEvent(
  fragment: Readonly<ConstitutionalFragment>
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return Object.freeze({
    event_type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
    entity_type: "constitutional_fragment",
    entity_id: fragment.fragment_id,
    workspace_id: fragment.workspace_id,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: parseRegisteredPayload(fragment)
  });
}

function parseRegisteredPayload(
  fragment: Readonly<ConstitutionalFragment>
): Readonly<ConstitutionalFragmentRegisteredPayload> {
  return deepFreeze(
    ConstitutionalFragmentRegisteredPayloadSchema.parse({
      fragment_id: fragment.fragment_id,
      workspace_id: fragment.workspace_id,
      category: fragment.category,
      authority_source: fragment.authority_source,
      registered_at: fragment.registered_at,
      content_sha256: hashConstitutionalFragmentContent(fragment.content)
    })
  );
}

function parseRegisteredPayloadFromEvent(
  event: Readonly<EventLogEntry>
): Readonly<ConstitutionalFragmentRegisteredPayload> {
  try {
    return deepFreeze(ConstitutionalFragmentRegisteredPayloadSchema.parse(event.payload_json));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid constitutional fragment registration event payload", {
      cause: error
    });
  }
}

function hashConstitutionalFragmentContent(content: string): string {
  return sha256Hex(content);
}

function createDefaultFragmentId(
  request: Readonly<ConstitutionalFragmentRegistration>
): ConstitutionalFragment["fragment_id"] {
  return parseFragmentId(
    `constitutional://${request.workspace_id}/${request.category}/${normalizeFragmentIdSegment(
      request.authority_source
    )}-${hashConstitutionalFragmentIdentity(request).slice(0, 12)}`
  );
}

function hashConstitutionalFragmentIdentity(
  request: Readonly<ConstitutionalFragmentRegistration>
): string {
  return sha256Hex(JSON.stringify(listConstitutionalFragmentIdentityParts(request)));
}

function normalizeFragmentIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
