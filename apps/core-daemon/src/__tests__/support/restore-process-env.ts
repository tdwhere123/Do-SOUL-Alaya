export function restoreProcessEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = original;
}
