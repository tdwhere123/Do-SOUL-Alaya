import type { ProviderFreeIsolation } from "./provider-free-isolation.mjs";

export const providerFreeDescendantPreload: string;
export function installProviderFreeActor(preload: string): ProviderFreeIsolation;
export function installProviderFreeDescendants(signal: ProviderFreeIsolation, preload: string): () => void;
