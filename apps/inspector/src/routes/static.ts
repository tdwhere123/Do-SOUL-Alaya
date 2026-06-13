import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";

export function registerInspectorStaticRoutes(app: Hono, options: { readonly staticRoot: string }): void {
  app.get("/assets/*", async (context) => {
    const requestedPath = context.req.path.replace(/^\/assets\//u, "");
    const filePath = resolveStaticPath(options.staticRoot, path.join("assets", requestedPath));
    if (filePath === null) {
      return context.json({ error: "not_found" }, 404);
    }
    const content = await readStaticFile(filePath);
    if (content === null) {
      return context.json({ error: "not_found" }, 404);
    }
    return new Response(content, {
      status: 200,
      headers: { "content-type": contentTypeFor(filePath) }
    });
  });

  app.get("*", async (context) => {
    if (context.req.path.startsWith("/api/")) {
      return context.json({ error: "not_found" }, 404);
    }
    if (context.req.path.includes("..")) {
      return context.json({ error: "not_found" }, 404);
    }
    const indexPath = resolveStaticPath(options.staticRoot, "index.html");
    const content = indexPath === null ? null : await readStaticFile(indexPath);
    if (content === null) {
      return context.json({ error: "frontend_bundle_missing" }, 503);
    }
    return new Response(content, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  });
}

function resolveStaticPath(root: string, requestPath: string): string | null {
  if (requestPath.includes("..")) {
    return null;
  }
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, requestPath);
  return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`) ? resolved : null;
}

async function readStaticFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}
