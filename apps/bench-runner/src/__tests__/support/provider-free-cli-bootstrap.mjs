/** Install the shared isolation owner before Node imports the bench CLI. */
import { installProviderFreeChildGuard } from "./provider-free-child-guard.mjs";
import { installProviderFreeActor } from "./provider-free-descendants.mjs";

installProviderFreeChildGuard();
installProviderFreeActor(import.meta.url);
process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:E0_TEST_GARDEN_KEY";
process.env.E0_TEST_GARDEN_KEY = "test-key";
