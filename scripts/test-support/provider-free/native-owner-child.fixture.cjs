const fs = require("node:fs"), path = require("node:path");
const binding = JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION);
const ready = JSON.parse(fs.readFileSync(path.join(binding.root, binding.member, "ready.json"), "utf8"));
if (ready.pid !== process.pid || ready.thread !== 0) throw new Error("Application entered before guard readiness");
