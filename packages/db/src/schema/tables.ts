// drizzle.config.ts points here. Re-export every control-plane table from this file,
// and nothing else: exporting the `control` pgSchema object would make drizzle-kit
// emit CREATE SCHEMA for a schema that already exists.
export {};
