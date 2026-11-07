import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema/index.js";

export { schema };

/**
 * A Drizzle client over Neon's HTTP driver, for Cloudflare Workers and other
 * runtimes without TCP sockets. Each query is one HTTPS request.
 *
 * Pass the connection string of the role the caller should act as, never the
 * owner role: the gateway uses neuvex_gateway, the provisioner neuvex_provisioner.
 */
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}

export type Db = ReturnType<typeof createDb>;
