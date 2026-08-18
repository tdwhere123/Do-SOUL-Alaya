import type {
  EraseBarrierPort,
  FieldContractSha256,
  FieldProjectionGeneration,
  ProjectionEraseBarrier,
  ProjectionGenerationPointer,
  ProjectionGenerationPort,
  ProjectionGenerationStatus,
  ProjectionPin,
  ProjectionPinRelease
} from "@do-soul/alaya-protocol";
import { verifyFieldProjectionGeneration } from "@do-soul/alaya-protocol";

import {
  sameProjectionGenerationIdentity,
  withProjectionGenerationStatus
} from "./generation-identity.js";
import { sameProjectionEraseBarrier } from "./generation-erase.js";
import {
  eraseProjectionArtifacts,
  type ProjectionGenerationArtifacts
} from "./generation-artifacts.js";

export type ProjectionCrashPoint = "before_pointer_swap" | "after_pointer_swap";

export interface ProjectionGenerationLifecycleStore {
  snapshot(input: FieldProjectionGeneration): FieldProjectionGeneration;
  verify(input: FieldProjectionGeneration): FieldProjectionGeneration;
  activatePointer(pointer: ProjectionGenerationPointer): ProjectionGenerationPointer;
  putArtifacts(
    workspaceId: string,
    artifacts: ProjectionGenerationArtifacts
  ): ProjectionGenerationArtifacts;
  readArtifacts(
    workspaceId: string,
    generationId: string
  ): ProjectionGenerationArtifacts | null;
}

export class ProjectionPointerCrash extends Error {
  public constructor(public readonly point: ProjectionCrashPoint) {
    super(`projection pointer crash at ${point}`);
    this.name = "ProjectionPointerCrash";
  }
}

export class InMemoryProjectionGenerationStore {
  private readonly generations = new Map<string, FieldProjectionGeneration>();
  private readonly pointers = new Map<string, ProjectionGenerationPointer>();
  private readonly pins = new Map<string, ProjectionPin>();
  private readonly barriers = new Map<string, ProjectionEraseBarrier>();
  private readonly artifacts = new Map<string, ProjectionGenerationArtifacts>();
  private readonly eraseCounts = new Map<string, number>();
  private crashAt: ProjectionCrashPoint | null = null;

  public constructor(private readonly sha256: FieldContractSha256) {}

  public armCrash(point: ProjectionCrashPoint): void {
    this.crashAt = point;
  }

  public snapshot(input: FieldProjectionGeneration): FieldProjectionGeneration {
    if (input.status === "active") {
      throw new Error("generation activation requires a pointer swap");
    }
    const verified = verifyFieldProjectionGeneration(input, this.sha256);
    const existing = this.readPinned(verified.workspace_id, verified.generation_id);
    if (existing !== null) {
      if (!sameProjectionGenerationIdentity(existing, verified)) {
        throw new Error("projection generation identity mismatch");
      }
      return existing;
    }
    this.generations.set(generationKey(verified.workspace_id, verified.generation_id), verified);
    return verified;
  }

  public verify(input: FieldProjectionGeneration): FieldProjectionGeneration {
    return this.persistStatus(input.workspace_id, input.generation_id, "verified");
  }

  public persistStatus(
    workspaceId: string,
    generationId: string,
    status: ProjectionGenerationStatus
  ): FieldProjectionGeneration {
    if (status === "active") {
      throw new Error("generation activation requires a pointer swap");
    }
    if (this.pointers.get(workspaceId)?.active_generation_id === generationId) {
      throw new Error("pointed generation requires pointer swap");
    }
    const existing = this.requireGeneration(workspaceId, generationId);
    const next = withProjectionGenerationStatus(existing, status, this.sha256);
    this.generations.set(generationKey(workspaceId, generationId), next);
    return next;
  }

  public activatePointer(pointer: ProjectionGenerationPointer): ProjectionGenerationPointer {
    this.consumeCrash("before_pointer_swap");
    const target = this.requireGeneration(pointer.workspace_id, pointer.active_generation_id);
    if (target.status !== "verified" && target.status !== "active") {
      throw new Error("generation activation requires a verified generation");
    }
    this.commitPointer(pointer);
    this.consumeCrash("after_pointer_swap");
    return this.pointers.get(pointer.workspace_id) ?? pointer;
  }

  public pin(pin: ProjectionPin): ProjectionPin {
    this.requireGeneration(pin.workspace_id, pin.generation_id);
    const key = pinKey(pin.workspace_id, pin.generation_id, pin.reader_id);
    const existing = this.pins.get(key);
    if (existing !== undefined) return existing;
    this.pins.set(key, Object.freeze({ ...pin }));
    return this.pins.get(key)!;
  }

  public release(input: ProjectionPinRelease): ProjectionPin {
    const key = pinKey(input.workspace_id, input.generation_id, input.reader_id);
    const existing = this.pins.get(key);
    if (existing === undefined) throw new Error("projection pin is missing");
    if (existing.released_at !== null) return existing;
    const released = Object.freeze({ ...existing, released_at: input.released_at });
    this.pins.set(key, released);
    return released;
  }

  public renew(pin: ProjectionPin, renewedAt: string, expiresAt: string): ProjectionPin {
    const key = pinKey(pin.workspace_id, pin.generation_id, pin.reader_id);
    const existing = this.pins.get(key);
    if (existing === undefined || existing.released_at !== null) {
      throw new Error("projection pin is missing or released");
    }
    if (projectionTimeMs(existing.expires_at) <= projectionTimeMs(renewedAt)) {
      throw new Error("projection pin is expired");
    }
    if (projectionTimeMs(expiresAt) <= projectionTimeMs(existing.expires_at)) return existing;
    const renewed = Object.freeze({ ...existing, expires_at: expiresAt });
    this.pins.set(key, renewed);
    return renewed;
  }

  public readPin(workspaceId: string, generationId: string, readerId: string): ProjectionPin | null {
    return this.pins.get(pinKey(workspaceId, generationId, readerId)) ?? null;
  }

  public requireActivePin(pin: ProjectionPin, asOf: string): ProjectionPin {
    const existing = this.pins.get(pinKey(pin.workspace_id, pin.generation_id, pin.reader_id));
    // Store expiry moves on renew; the caller handle snapshot does not.
    if (existing === undefined || existing.pinned_at !== pin.pinned_at) {
      throw new Error("projection reader pin is missing or mismatched");
    }
    if (existing.released_at !== null) throw new Error("projection reader pin is released");
    if (projectionTimeMs(existing.pinned_at) > projectionTimeMs(asOf) ||
        projectionTimeMs(existing.expires_at) <= projectionTimeMs(asOf)) {
      throw new Error("projection reader pin is not live");
    }
    return existing;
  }

  public collectRetired(workspaceId: string, asOf: string): readonly string[] {
    const collected: string[] = [];
    for (const [key, generation] of this.generations) {
      if (generation.workspace_id !== workspaceId || generation.status !== "retired") continue;
      if (this.hasActivePin(workspaceId, generation.generation_id, asOf)) continue;
      this.generations.delete(key);
      this.artifacts.delete(key);
      for (const pinKeyValue of this.pins.keys()) {
        if (pinKeyValue.startsWith(`${key}\0`)) this.pins.delete(pinKeyValue);
      }
      collected.push(generation.generation_id);
    }
    return Object.freeze(collected.sort());
  }

  public erase(barrier: ProjectionEraseBarrier): ProjectionEraseBarrier {
    const key = `${barrier.workspace_id}\0${barrier.barrier_id}`;
    const existing = this.barriers.get(key);
    if (existing !== undefined) {
      if (!sameProjectionEraseBarrier(existing, barrier)) {
        throw new Error("erase barrier identity collision");
      }
      return existing;
    }
    this.barriers.set(key, barrier);
    this.applyErase(barrier);
    this.eraseCounts.set(
      barrier.workspace_id,
      (this.eraseCounts.get(barrier.workspace_id) ?? 0) + 1
    );
    return barrier;
  }

  public readActive(workspaceId: string): FieldProjectionGeneration | null {
    const pointer = this.pointers.get(workspaceId);
    return pointer === undefined
      ? null
      : this.readPinned(workspaceId, pointer.active_generation_id);
  }

  public readPinned(
    workspaceId: string,
    generationId: string
  ): FieldProjectionGeneration | null {
    return this.generations.get(generationKey(workspaceId, generationId)) ?? null;
  }

  public readByGenerationIds(
    workspaceId: string,
    generationIds: readonly string[]
  ): readonly FieldProjectionGeneration[] {
    const unique = [...new Set(generationIds)];
    if (unique.length !== 1) throw new Error("mixed generation read is forbidden");
    const row = this.readPinned(workspaceId, unique[0]!);
    return Object.freeze(row === null ? [] : [row]);
  }

  public putArtifacts(
    workspaceId: string,
    artifacts: ProjectionGenerationArtifacts
  ): ProjectionGenerationArtifacts {
    this.requireGeneration(workspaceId, artifacts.generation_id);
    const key = generationKey(workspaceId, artifacts.generation_id);
    if (this.artifacts.has(key)) {
      throw new Error("projection generation artifacts are immutable");
    }
    this.artifacts.set(key, artifacts);
    return artifacts;
  }

  public readArtifacts(
    workspaceId: string,
    generationId: string
  ): ProjectionGenerationArtifacts | null {
    return this.artifacts.get(generationKey(workspaceId, generationId)) ?? null;
  }

  public eraseFrontier(workspaceId: string): string {
    return `erase-${this.eraseCounts.get(workspaceId) ?? 0}`;
  }

  public asGenerationPort(): ProjectionGenerationPort {
    return {
      snapshot: (input) => this.snapshot(input),
      verify: (input) => this.verify(input),
      activatePointer: (input) => this.activatePointer(input),
      pin: (input) => this.pin(input),
      release: (input) => this.release(input)
    };
  }

  public asErasePort(): EraseBarrierPort {
    return { erase: (input) => this.erase(input) };
  }

  private commitPointer(pointer: ProjectionGenerationPointer): void {
    const previous = this.pointers.get(pointer.workspace_id);
    if (previous !== undefined && previous.active_generation_id !== pointer.active_generation_id) {
      this.forceStatus(pointer.workspace_id, previous.active_generation_id, "retired");
    }
    this.forceStatus(pointer.workspace_id, pointer.active_generation_id, "active");
    this.pointers.set(pointer.workspace_id, Object.freeze({ ...pointer }));
  }

  private forceStatus(
    workspaceId: string,
    generationId: string,
    status: ProjectionGenerationStatus
  ): void {
    const existing = this.requireGeneration(workspaceId, generationId);
    this.generations.set(
      generationKey(workspaceId, generationId),
      withProjectionGenerationStatus(existing, status, this.sha256)
    );
  }

  private applyErase(barrier: ProjectionEraseBarrier): void {
    for (const [key, artifacts] of this.artifacts) {
      if (!key.startsWith(`${barrier.workspace_id}\0`)) continue;
      if (barrier.generation_id !== null && artifacts.generation_id !== barrier.generation_id) {
        continue;
      }
      this.artifacts.set(key, eraseProjectionArtifacts(
        artifacts,
        barrier.subject_id,
        barrier.subject_kind
      ));
    }
  }

  private hasActivePin(workspaceId: string, generationId: string, asOf: string): boolean {
    const prefix = `${generationKey(workspaceId, generationId)}\0`;
    for (const [key, pin] of this.pins) {
      if (key.startsWith(prefix) && pin.released_at === null &&
          projectionTimeMs(pin.expires_at) > projectionTimeMs(asOf)) return true;
    }
    return false;
  }

  private consumeCrash(point: ProjectionCrashPoint): void {
    if (this.crashAt !== point) return;
    this.crashAt = null;
    throw new ProjectionPointerCrash(point);
  }

  private requireGeneration(
    workspaceId: string,
    generationId: string
  ): FieldProjectionGeneration {
    const existing = this.readPinned(workspaceId, generationId);
    if (existing === null) throw new Error("projection generation is missing");
    return existing;
  }
}

function projectionTimeMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("projection pin time must be valid");
  return milliseconds;
}

function generationKey(workspaceId: string, generationId: string): string {
  return `${workspaceId}\0${generationId}`;
}

function pinKey(workspaceId: string, generationId: string, readerId: string): string {
  return `${generationKey(workspaceId, generationId)}\0${readerId}`;
}
