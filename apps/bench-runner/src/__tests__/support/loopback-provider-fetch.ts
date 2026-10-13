/** Keep the production request intact while routing a pinned provider fixture over a real local socket. */
export function fetchLoopbackProvider(
  nativeFetch: typeof fetch,
  target: URL,
  init?: RequestInit
): Promise<Response> {
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("provider fixture requires an HTTP loopback target");
  }
  // The production dispatcher is bound to the original provider origin. Its owner closes it.
  const { dispatcher: _dispatcher, ...loopbackInit } =
    (init ?? {}) as RequestInit & { readonly dispatcher?: unknown };
  return nativeFetch(target, loopbackInit);
}
