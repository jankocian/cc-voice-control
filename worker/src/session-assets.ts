import type { Env } from "./voice-session-do";

// Serving the phone SPA shell (built static bundle from ../web/dist). The single capability secret
// lives in the URL path (/s/<secret>) and the client reads it from there — nothing is injected
// server-side, so reaching a valid /s/<secret> route is enough; the WS handshake is the real gate.

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

export async function renderSessionPage(env: Env): Promise<Response> {
  let assets: SpaAssets;
  try {
    assets = await loadSpaAssets(env);
  } catch {
    return new Response("Application bundle unavailable", { status: 503 });
  }

  const styleLinks = assets.styles.map((href) => `  <link rel="stylesheet" href="${href}" />`).join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <meta name="theme-color" content="#faf6f1" />
  <title>voice-control</title>
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
      // The SPA is a built static bundle served from 'self': mic via MediaRecorder, the only network
      // target is the same-origin bridge WebSocket (connect-src 'self'), TTS plays from blob: URLs, and
      // `data:` in media-src is the silent-WAV that unlocks iOS autoplay on first tap.
      "content-security-policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob: data:",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; ")
    }
  });
}
