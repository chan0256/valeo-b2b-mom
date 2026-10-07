// Cloudflare Worker entry: /api/* goes to the API, everything else is the static page in /public.
import { onRequest } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.slice("/api/".length).split("/").filter(Boolean);
      return onRequest({ request, env, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
};
