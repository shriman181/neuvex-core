import { handle, type Env } from "./app.js";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
