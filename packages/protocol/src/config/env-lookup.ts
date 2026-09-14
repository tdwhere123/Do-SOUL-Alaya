/** Injection surface for environment reads; edge modules may bind process.env once. */
export type EnvLookup = Readonly<Record<string, string | undefined>>;
