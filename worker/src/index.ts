import {
  isBridgeBrowserSessionPath,
  parseBridgeClaimPath,
  parseBridgeWebSocketPath
} from "../../src/shared/bridge-contract";
import { renderSessionPage } from "./session-assets";
import { type Env, VoiceSessionDurableObject } from "./voice-session-do";

// wrangler binds the Durable Object by this exported class name (wrangler.toml class_name).
export { VoiceSessionDurableObject };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("voice-control bridge", { status: 200 });
    }
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // The phone page is a static SPA shell; the session secret rides in the URL fragment, which the
    // browser never sends, so there is nothing secret to read here — serving the shell is enough.
    if (request.method === "GET" && isBridgeBrowserSessionPath(url.pathname)) {
      return renderSessionPage(env);
    }

    // The WebSocket upgrade (GET /ws/<routingId>) and the device-pairing claim (POST /claim/<routingId>)
    // both address a session by its routingId; forward each to that session's Durable Object.
    const routingId =
      (request.method === "GET" ? parseBridgeWebSocketPath(url.pathname) : undefined) ??
      (request.method === "POST" ? parseBridgeClaimPath(url.pathname) : undefined);
    if (routingId) {
      // Rate-limit per IP BEFORE touching a DO, so spraying /ws|/claim/<random> can't burn DO
      // instantiations. Best-effort abuse-bounding only — the device cookie (browser) and the secret
      // (content encryption) are the real gates.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await rateLimitAllows(env.WS_CONNECT, ip))) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Route by the routingId (= sha256(secret), supplied by the client). The DO name is a one-way
      // derivative of the secret, so a guessed path lands on a different, empty DO — never the victim's.
      const id = env.VOICE_SESSIONS.idFromName(routingId);
      return env.VOICE_SESSIONS.get(id).fetch(request);
    }

    // Everything else (the hashed /assets/* bundle + build manifest) is a static SPA asset.
    return env.ASSETS.fetch(request);
  }
};

// Ask the rate-limiter, failing OPEN: it's abuse-bounding, not the capability gate, so a limiter fault
// must never block legitimate traffic. Any error → allow.
async function rateLimitAllows(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
