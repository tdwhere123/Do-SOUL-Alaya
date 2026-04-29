import {
  TargetRevalidateResultSchema,
  type StrongRef,
  type TargetRevalidateResult
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import type { StrongRefRepoPort } from "./strong-ref-service.js";

export interface TargetCurrencyCheckPort {
  checkCurrency(
    targetEntityType: string,
    targetEntityId: string,
    sinceTimestamp: string
  ): Promise<{ status: "fresh" | "stale" | "missing"; stale_since?: string }>;
}

export interface TargetRevalidateServiceDependencies {
  readonly strongRefRepo: Pick<StrongRefRepoPort, "findByTargets">;
  readonly currencyCheckPort: TargetCurrencyCheckPort;
  readonly now?: () => string;
}

export class TargetRevalidateService {
  private readonly now: () => string;

  public constructor(private readonly deps: TargetRevalidateServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async revalidate(refs: readonly Readonly<StrongRef>[]): Promise<readonly TargetRevalidateResult[]> {
    return await Promise.all(refs.map(async (ref) => await this.revalidateSingle(ref)));
  }

  public async revalidateSingle(ref: Readonly<StrongRef>): Promise<TargetRevalidateResult> {
    const check = await this.deps.currencyCheckPort.checkCurrency(
      ref.target_entity_type,
      ref.target_entity_id,
      ref.created_at
    );

    return parseTargetRevalidateResult({
      ref_id: ref.ref_id,
      status: check.status,
      revalidated_at: this.now(),
      ...(check.stale_since === undefined ? {} : { stale_since: check.stale_since })
    });
  }

  public async findAndRevalidate(
    workspaceId: string,
    targetEntityType: string,
    targetEntityIds: readonly string[]
  ): Promise<readonly TargetRevalidateResult[]> {
    if (targetEntityIds.length === 0) {
      return [];
    }

    const refs = await this.deps.strongRefRepo.findByTargets(workspaceId, targetEntityType, targetEntityIds);
    return await this.revalidate(refs);
  }
}

function parseTargetRevalidateResult(value: TargetRevalidateResult): TargetRevalidateResult {
  try {
    return deepFreeze(TargetRevalidateResultSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid target-revalidate result payload", { cause: error });
  }
}
