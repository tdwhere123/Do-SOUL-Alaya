/** Native and OpenAI-compatible configuration routes share one authenticated origin. */
export function normalizeGeminiEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !["/", "/v1beta", "/v1beta/", "/v1beta/openai", "/v1beta/openai/"].includes(endpoint.pathname) ||
      !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback))) {
    throw new Error("Gemini endpoint must be an HTTPS origin, native v1beta or OpenAI-compatible route");
  }
  return new URL(endpoint.origin);
}
