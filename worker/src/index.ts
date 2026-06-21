import { parseBridgeBrowserSessionPath, parseBridgeWebSocketPath } from "../../src/shared/bridge-contract";
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

    const browserSecret = parseBridgeBrowserSessionPath(url.pathname);
    if (request.method === "GET" && browserSecret) {
      return renderSessionPage(env);
    }

    const webSocketSecret = parseBridgeWebSocketPath(url.pathname);
    if (request.method === "GET" && webSocketSecret) {
      // Rate-limit WS-connect attempts per IP BEFORE spinning up a DO, so spraying /ws/<random> can't
      // burn DO instantiations. Best-effort abuse-bounding only (the secret hash is the real gate).
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await rateLimitAllows(env.WS_CONNECT, ip))) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Route by the secret's HASH, never the raw secret: the DO name is a one-way derivative, so
      // reaching a session's DO already proves knowledge of its secret. That routing IS the capability
      // gate — a guessed path lands on a different, empty DO, never the victim's session.
      const id = env.VOICE_SESSIONS.idFromName(await sha256(webSocketSecret));
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
