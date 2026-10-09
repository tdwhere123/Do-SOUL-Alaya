// Loaded with node --import before the CLI and worker imports.
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
globalThis.fetch = () => { throw new Error("provider transport forbidden in CLI boundary test"); };
