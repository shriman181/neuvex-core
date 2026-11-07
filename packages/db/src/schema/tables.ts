// drizzle.config.ts points here. Re-export every control-plane table from this file,
// and nothing else: exporting the `control` pgSchema object would make drizzle-kit
// emit CREATE SCHEMA for a schema that already exists.
export { vendors, vendorKeys } from "./vendors.js";
export { primitives, contractVersions } from "./primitives.js";
export { molds, moldVersions } from "./molds.js";
export { agentSessions } from "./sessions.js";
export { usageDaily } from "./usage.js";
