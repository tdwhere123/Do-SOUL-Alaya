import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function defaultCacheDir(
  env = process.env,
  fallbackHome = homedir(),
  fallbackTmp = tmpdir()
) {
  const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
  const home = fallbackHome.trim();
  const cacheHome =
    xdgCacheHome && xdgCacheHome.length > 0
      ? xdgCacheHome
      : home.length > 0
        ? path.join(home, ".cache")
        : path.join(fallbackTmp, "do-soul-alaya-cache");
  return path.join(cacheHome, "do-soul-alaya", "models");
}
