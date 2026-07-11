import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../components/toast";
import MemoryBrowserPage from "../../pages/memory-browser";

export function renderMemoryBrowser() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MemoryBrowserPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

export type FetchInput = Parameters<typeof fetch>[0];

export function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const SAMPLE_ROWS = [
  {
    object_id: "mem-abc-1234567890",
    object_kind: "memory_entry",
    content: "remember preference",
    dimension: "preference",
    scope_class: "project",
    domain_tags: ["tag-1"],
    evidence_refs: [],
    created_at: "2026-05-10T00:00:00.000Z",
    contradiction_count: 0,
    source_kind: "user_assert",
    storage_tier: "warm",
    activation_score: 0.4
  }
];
