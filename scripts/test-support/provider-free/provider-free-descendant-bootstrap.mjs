/** Neutral registration before a descendant imports application code. */
import { installProviderFreeChildGuard } from "./provider-free-child-guard.mjs";
import { installProviderFreeActor } from "./provider-free-descendants.mjs";

installProviderFreeChildGuard();
installProviderFreeActor(import.meta.url);
