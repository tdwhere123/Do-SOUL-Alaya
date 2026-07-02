export function readEnvBoolean(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}
