import type { Env } from "./voice-session-do";

// Serving the SPA shell (the built static bundle from ../web/dist). One bundle backs two pages: the phone
// session page (/s/<sessionId>; the secret rides in the URL fragment, never sent to the server) and the
// public landing page (/). They differ only by CSP, <title>, description meta, and the installable-PWA head.

type SpaAssets = { script: string; styles: string[] };
type ViteManifestChunk = { file: string; isEntry?: boolean; css?: string[] };

// Resolved once per isolate from the Vite manifest (the bundle is immutable for a given deploy).
let spaAssetsCache: Promise<SpaAssets> | undefined;

// Read the Vite build manifest through the ASSETS binding to map the SPA entry to its hashed JS + CSS.
function loadSpaAssets(env: Env): Promise<SpaAssets> {
  if (!spaAssetsCache) {
    spaAssetsCache = (async () => {
      const res = await env.ASSETS.fetch(new Request("https://assets.local/.vite/manifest.json"));
      if (!res.ok) throw new Error(`manifest unavailable (${res.status})`);
      const manifest = (await res.json()) as Record<string, ViteManifestChunk>;
      const entry = Object.values(manifest).find((chunk) => chunk.isEntry) ?? manifest["src/main.tsx"];
      if (!entry) throw new Error("no entry chunk in manifest");
      return { script: `/${entry.file}`, styles: (entry.css ?? []).map((href) => `/${href}`) };
    })().catch((err) => {
      spaAssetsCache = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return spaAssetsCache;
}

// The phone SPA is served from 'self': mic via MediaRecorder, the only network target is the
// same-origin bridge WebSocket (connect-src 'self'), TTS plays from blob: URLs, and `data:` in
// media-src is the silent-WAV that unlocks iOS autoplay on first tap.
const SESSION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

// The public landing page is the same bundle but needs to embed a demo video, so frame-src allows
// the two trusted players (and their thumbnail hosts). Everything else stays 'self'-only.
const LANDING_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://i.ytimg.com https://i.vimeocdn.com",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

// Installable-PWA head — only on the session page, so a pinned app relaunches the authenticated session
// rather than this marketing page. No start_url in the manifest → it defaults to the launch URL, which on
// iOS keeps the #secret fragment, so a pinned app reopens already-authenticated.
const PWA_HEAD = `
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Voice Control" />`;

type ShellOptions = { csp: string; title?: string; description?: string; head?: string };

// Renders the SPA shell (the built bundle's hashed JS + CSS). The session page and the landing
// page are the same SPA — they differ only by CSP, <title>, and an optional description meta.
async function renderShell(env: Env, opts: ShellOptions): Promise<Response> {
  let assets: SpaAssets;
  try {
    assets = await loadSpaAssets(env);
  } catch {
    return new Response("Application bundle unavailable", { status: 503 });
  }

  const styleLinks = assets.styles.map((href) => `  <link rel="stylesheet" href="${href}" />`).join("\n");
  const descriptionMeta = opts.description ? `\n  <meta name="description" content="${opts.description}" />` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <meta name="theme-color" content="#faf6f1" />
  <title>${opts.title ?? "Voice Control"}</title>${descriptionMeta}${opts.head ?? ""}
${styleLinks}
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${assets.script}"></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": opts.csp
    }
  });
}

export function renderSessionPage(env: Env): Promise<Response> {
  return renderShell(env, { csp: SESSION_CSP, head: PWA_HEAD });
}

export function renderLandingPage(env: Env): Promise<Response> {
  return renderShell(env, {
    csp: LANDING_CSP,
    title: "voice-control — a walkie-talkie for Claude Code in your cmux terminal",
    description:
      "Voice-control your real interactive Claude Code session from your phone. Push to talk, it types into your live cmux pane, and Claude's reply is read back — on your normal subscription, no API billing."
  });
}
