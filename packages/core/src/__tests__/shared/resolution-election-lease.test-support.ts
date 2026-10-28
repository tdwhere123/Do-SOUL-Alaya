/** A single-connection fake for service tests; cross-connection behavior uses SQLite. */
export function createResolutionElectionLease(identity: object) {
  let current: { owner_token: string; expires_at: string } | null = null;
  return {
    getStorageConnectionIdentity: () => identity,
    tryAcquire: (_key: string, owner: string, now: string, expires: string) => {
      if (current !== null && current.expires_at > now) return null;
      current = { owner_token: owner, expires_at: expires };
      return current;
    },
    findByKey: () => current,
    release: (_key: string, owner: string) => { if (current?.owner_token === owner) current = null; }
  };
}
