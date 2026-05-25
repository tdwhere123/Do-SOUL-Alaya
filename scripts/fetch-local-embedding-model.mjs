#!/usr/bin/env node
// Pre-fetch the on-device embedding model weights into a local Transformers.js
// cache so recall's local_onnx provider runs fully offline. Model weights are
// not committed to git; this script is the distribution step.
//
// Usage:
//   node scripts/fetch-local-embedding-model.mjs [--cache-dir <path>] [--model <repo-id>] [--force]
//
// Defaults: cache-dir = $ALAYA_LOCAL_EMBEDDING_CACHE_DIR or
//           ${XDG_CACHE_HOME:-$HOME/.cache}/do-soul-alaya/models;
//           model = Xenova/paraphrase-multilingual-MiniLM-L12-v2.
//
// Mirror: set HF_ENDPOINT (e.g. https://hf-mirror.com) when huggingface.co is
// unreachable; the script downloads each file directly over HTTP, so it does
// not depend on Transformers.js honoring HF_ENDPOINT.

import { mkdirSync, statSync, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
// The q8 feature-extraction pipeline only needs these artifacts.
const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx"
];
const MAX_ATTEMPTS = 5;

function parseArgs(argv) {
  const args = {
    cacheDir:
      process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR?.trim() ||
      defaultCacheDir(),
    modelId: DEFAULT_MODEL_ID,
    force: false
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--cache-dir") {
      args.cacheDir = argv[++i] ?? args.cacheDir;
    } else if (token === "--model") {
      args.modelId = argv[++i] ?? args.modelId;
    } else if (token === "--force") {
      args.force = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

export function defaultCacheDir(
  env = process.env,
  fallbackHome = homedir(),
  fallbackTmp = tmpdir()
) {
  const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
  const home = fallbackHome.trim();
  const cacheHome = xdgCacheHome && xdgCacheHome.length > 0
    ? xdgCacheHome
    : home.length > 0
      ? path.join(home, ".cache")
      : path.join(fallbackTmp, "do-soul-alaya-cache");
  return path.join(cacheHome, "do-soul-alaya/models");
}

function endpointBase() {
  const raw = process.env.HF_ENDPOINT?.trim();
  return (raw && raw.length > 0 ? raw : "https://huggingface.co").replace(/\/+$/, "");
}

function existingSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return -1;
  }
}

async function downloadFile(modelId, relPath, destPath, force) {
  if (!force && existingSize(destPath) > 0) {
    return { skipped: true };
  }
  mkdirSync(path.dirname(destPath), { recursive: true });
  const url = `${endpointBase()}/${modelId}/resolve/main/${relPath}`;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await streamPipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
      const size = existingSize(destPath);
      if (size <= 0) {
        throw new Error("downloaded file is empty");
      }
      return { skipped: false, size };
    } catch (error) {
      lastError = error;
      await rm(destPath, { force: true });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw new Error(
    `failed to download ${relPath} after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fetch-local-embedding-model: ${error.message}\n`);
    process.exit(2);
  }

  const modelRoot = path.join(args.cacheDir, ...args.modelId.split("/"));
  process.stdout.write(
    `fetch-local-embedding-model: model=${args.modelId} endpoint=${endpointBase()} dest=${modelRoot}\n`
  );

  for (const relPath of MODEL_FILES) {
    const destPath = path.join(modelRoot, ...relPath.split("/"));
    try {
      const result = await downloadFile(args.modelId, relPath, destPath, args.force);
      process.stdout.write(
        result.skipped
          ? `  skip  ${relPath} (already present)\n`
          : `  ok    ${relPath} (${result.size} bytes)\n`
      );
    } catch (error) {
      process.stderr.write(`  fail  ${relPath}: ${error.message}\n`);
      process.stderr.write(
        "fetch-local-embedding-model: download failed; set HF_ENDPOINT to a mirror " +
          "(e.g. https://hf-mirror.com) and re-run\n"
      );
      process.exit(1);
    }
  }

  process.stdout.write(
    `fetch-local-embedding-model: done; point ALAYA_LOCAL_EMBEDDING_CACHE_DIR at ${args.cacheDir}\n`
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `fetch-local-embedding-model: ${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exit(1);
  });
}
