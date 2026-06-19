import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The SPA is served by the Cloudflare Worker via its ASSETS binding. Emitting a
// manifest lets the Worker map the hashed entry chunk/stylesheet into the /s/<id>
// HTML shell, so the page references built files from 'self' (no inline script).
export default defineConfig({
  // `reactAliasesEnabled` (default true) aliases react / react-dom → preact/compat,
  // so shadcn/ui components (incl. Radix primitives) resolve against Preact.
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn's `@/…` imports → src. (Matches tsconfig `paths`.)
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    // Keep it lean for cellular: a single entry, no source maps in the bundle.
    sourcemap: false,
    rollupOptions: {
      input: "src/main.tsx"
    }
  }
});
