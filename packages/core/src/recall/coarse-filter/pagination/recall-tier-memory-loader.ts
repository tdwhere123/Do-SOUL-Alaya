import {
  StorageTier,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { toErrorMessage } from "../../runtime/recall-service-helpers.js";
import type {
  RecallMemoryListPageOptions,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallTierWindowCursor
} from "../../runtime/recall-service-types.js";
import {
  MAX_OFFSET_RECALL_TIER_PAGES,
  OFFSET_RECALL_TIER_PAGE_SIZE,
  resolveRecallTierWindowPageLimit,
  resolveRecallTierWindowStep,
  STORAGE_RECALL_TIER_PAGE_SIZE,
  validateRecallTierWindowPage,
  type RecallTierWindowPageFailure
} from "./recall-tier-window-pagination.js";

type RecallTierLoadContext = Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "memoryRepo">;
  readonly warn: RecallServiceWarnPort;
}>;

type RecallTierWindowLoader = NonNullable<
  RecallServiceDependencies["memoryRepo"]["findRecallTierWindow"]
>;

export type TierMemoryLoadResult = Readonly<{
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly complete: boolean;
}>;

export async function loadTierMemoriesForRecall(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier
): Promise<TierMemoryLoadResult> {
  const window = await loadRecallTierWindow(context, workspaceId, tier);
  return window ?? loadRecallTierPages(context, workspaceId, tier);
}

async function loadRecallTierWindow(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier
): Promise<TierMemoryLoadResult | null> {
  const loadWindow = context.dependencies.memoryRepo.findRecallTierWindow?.bind(
    context.dependencies.memoryRepo
  );
  if (loadWindow === undefined) return null;
  return loadRecallTierWindowPages(context, workspaceId, tier, loadWindow);
}

async function loadRecallTierWindowPages(
  context: RecallTierLoadContext, workspaceId: string, tier: StorageTier,
  loadWindow: RecallTierWindowLoader
): Promise<TierMemoryLoadResult> {
  const memories: Readonly<MemoryEntry>[] = [];
  let cursor: Readonly<RecallTierWindowCursor> | undefined;
  let pagesLoaded = 0;
  let complete = true;

  for (;;) {
    const requestLimit = resolveRecallTierWindowPageLimit(memories.length);
    if (requestLimit === null) {
      warnMaxRecallMemoryPagesReached(context, workspaceId, tier,
        STORAGE_RECALL_TIER_PAGE_SIZE, pagesLoaded, memories.length);
      complete = false;
      break;
    }
    const window = await loadWindow({
      workspaceId,
      tier,
      limit: requestLimit,
      ...(cursor === undefined ? {} : { cursor })
    });
    pagesLoaded += 1;
    const failure = validateRecallTierWindowPage(window, requestLimit, cursor);
    if (failure !== null) {
      warnInvalidRecallTierWindowPage(
        context, workspaceId, tier, requestLimit, window.memories.length, failure
      );
      complete = false;
      break;
    }
    memories.push(...window.memories);
    const step = resolveRecallTierWindowStep(window, pagesLoaded, memories.length);
    if (step.kind === "continue") {
      cursor = step.cursor;
      continue;
    }
    if (step.kind === "capped") {
      warnMaxRecallMemoryPagesReached(context, workspaceId, tier,
        STORAGE_RECALL_TIER_PAGE_SIZE, pagesLoaded, memories.length);
      complete = false;
    }
    break;
  }

  return Object.freeze({ memories: Object.freeze(memories), complete });
}

async function loadRecallTierPages(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier
): Promise<TierMemoryLoadResult> {
  const memories: Readonly<MemoryEntry>[] = [];
  let offset = 0;
  let pageLimit = OFFSET_RECALL_TIER_PAGE_SIZE;
  let previousPageSignature: string | null = null;
  let pagesLoaded = 0;
  let complete = true;

  for (;;) {
    const { pageMemories, effectiveLimit } = await loadTierMemoryPage(
      context, workspaceId, tier, { limit: pageLimit, offset }
    );
    pageLimit = effectiveLimit;
    pagesLoaded += 1;
    const pageSignature = buildMemoryPageSignature(pageMemories);
    const failure = detectRecallTierPageFailure(context, workspaceId, tier, {
      pageMemories, pageLimit, offset, pageSignature, previousPageSignature
    });
    if (failure !== null) {
      complete = false;
      break;
    }
    memories.push(...pageMemories);
    if (pageMemories.length < pageLimit) break;
    if (pagesLoaded >= MAX_OFFSET_RECALL_TIER_PAGES) {
      warnMaxRecallMemoryPagesReached(
        context, workspaceId, tier, pageLimit, pagesLoaded, memories.length
      );
      complete = false;
      break;
    }
    offset += pageMemories.length;
    previousPageSignature = pageSignature;
  }

  return Object.freeze({ memories: Object.freeze(memories), complete });
}

function detectRecallTierPageFailure(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  page: Readonly<{
    pageMemories: readonly Readonly<MemoryEntry>[];
    pageLimit: number;
    offset: number;
    pageSignature: string | null;
    previousPageSignature: string | null;
  }>
): "oversized" | "duplicate" | null {
  if (page.pageMemories.length > page.pageLimit) {
    warnOversizedRecallMemoryPage(
      context, workspaceId, tier, page.pageLimit, page.pageMemories.length
    );
    return "oversized";
  }
  if (isDuplicateRecallMemoryPage(
    page.offset, page.pageSignature, page.previousPageSignature
  )) {
    warnDuplicateRecallMemoryPage(
      context, workspaceId, tier, page.pageLimit, page.offset
    );
    return "duplicate";
  }
  return null;
}

async function loadTierMemoryPage(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  page: RecallMemoryListPageOptions
): Promise<{
  readonly pageMemories: readonly Readonly<MemoryEntry>[];
  readonly effectiveLimit: number;
}> {
  try {
    return {
      pageMemories: await context.dependencies.memoryRepo.findByWorkspaceId(
        workspaceId, tier, page
      ),
      effectiveLimit: page.limit
    };
  } catch (error) {
    if (page.limit !== OFFSET_RECALL_TIER_PAGE_SIZE ||
      !isRepoPageLimitValidationError(error)) throw error;
    const cappedPage = { limit: STORAGE_RECALL_TIER_PAGE_SIZE, offset: page.offset };
    context.warn(
      "recall memory repo rejected recall page size; retrying with storage page cap",
      {
        workspace_id: workspaceId,
        tier,
        requested_limit: page.limit,
        retry_limit: cappedPage.limit
      }
    );
    return {
      pageMemories: await context.dependencies.memoryRepo.findByWorkspaceId(
        workspaceId, tier, cappedPage
      ),
      effectiveLimit: cappedPage.limit
    };
  }
}

function warnInvalidRecallTierWindowPage(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  returnedCount: number,
  failure: RecallTierWindowPageFailure
): void {
  context.warn("recall memory repo returned an invalid cursor page", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    returned_count: returnedCount,
    failure
  });
}

function warnOversizedRecallMemoryPage(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  returnedCount: number
): void {
  context.warn("recall memory repo returned an oversized page", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    returned_count: returnedCount
  });
}

function warnDuplicateRecallMemoryPage(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  offset: number
): void {
  context.warn("recall memory repo returned a duplicate page", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    offset
  });
}

function warnMaxRecallMemoryPagesReached(
  context: RecallTierLoadContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  pagesLoaded: number,
  returnedCount: number
): void {
  context.warn("recall memory repo page scan reached the maximum page count", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    pages_loaded: pagesLoaded,
    returned_count: returnedCount
  });
}

function buildMemoryPageSignature(
  page: readonly Readonly<MemoryEntry>[]
): string | null {
  if (page.length === 0) return null;
  return [
    page.length,
    page[0]?.object_id ?? "",
    page[page.length - 1]?.object_id ?? ""
  ].join(":");
}

function isDuplicateRecallMemoryPage(
  offset: number,
  pageSignature: string | null,
  previousPageSignature: string | null
): boolean {
  return offset > 0 && pageSignature !== null && pageSignature === previousPageSignature;
}

function isRepoPageLimitValidationError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "VALIDATION_FAILED" && toErrorMessage(error).includes("page limit");
}
