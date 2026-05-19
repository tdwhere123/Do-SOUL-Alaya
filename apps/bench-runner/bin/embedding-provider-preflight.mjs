#!/usr/bin/env node
import { preflightEmbeddingProvider } from "../dist/harness/embedding-provider-preflight.js";

const result = await preflightEmbeddingProvider();
console.error(result.message);
process.exit(result.ok ? 0 : 2);
