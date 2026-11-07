import { handle } from "./app.js";
import { neonStore } from "./store.js";

export interface Env {
  /** Connection string for the neuvex_gateway role. Set as a Worker secret. */
  DATABASE_URL: string;
}

export default {
  fetch(request, env, ctx) {
    return handle(request, {
      store: neonStore(env.DATABASE_URL),
      waitUntil: (work) => ctx.waitUntil(work),
    });
  },

  // Every 6 hours: audit partitions ahead, checkpoints for finished days, retention.
  // Running this often also keeps Neon from archiving the production branch.
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      neonStore(env.DATABASE_URL)
        .runMaintenance()
        .then((result) => console.log(JSON.stringify({ msg: "audit maintenance", result })))
        .catch((err: unknown) => console.error(JSON.stringify({ msg: "audit maintenance failed", err: String(err) }))),
    );
  },
} satisfies ExportedHandler<Env>;
