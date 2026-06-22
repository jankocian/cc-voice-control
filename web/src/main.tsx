import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { InvalidSession } from "./components/InvalidSession";
import { deriveKey } from "./lib/e2e";
import { deriveRoutingId, readSessionCredentials } from "./lib/session";
import "./index.css";

const root = document.getElementById("app");

if (root) {
  // `?style-guide` (or pathname /style-guide) renders the living style guide — the
  // single bundled SPA owns the route since the Worker only serves /s/<id> shells.
  const isStyleGuide =
    window.location.pathname.endsWith("/style-guide") || new URLSearchParams(window.location.search).has("style-guide");

  // `?demo=<state>` is a presentation-only harness for the visual-verification
  // loop (no bridge/mic). Dev-only path; ignored by the production daemon flow.
  const demoState = new URLSearchParams(window.location.search).get("demo");

  if (isStyleGuide) {
    void import("./StyleGuide").then(({ StyleGuide }) => {
      createRoot(root).render(
        <StrictMode>
          <StyleGuide />
        </StrictMode>
      );
    });
  } else if (demoState) {
    void import("./DemoApp").then(({ DemoApp }) => {
      createRoot(root).render(
        <StrictMode>
          <DemoApp state={demoState} />
        </StrictMode>
      );
    });
  } else {
    const credentials = readSessionCredentials();
    if (!credentials) {
      createRoot(root).render(
        <StrictMode>
          <InvalidSession />
        </StrictMode>
      );
    } else {
      // Derive the routing id + the end-to-end key from the fragment secret (both ~instant) before
      // mounting, so the app has everything it needs to claim a device cookie, open the socket, and
      // seal/open content. The worker never sees the secret or the key. If derivation fails (e.g.
      // crypto.subtle is unavailable on an insecure-context deploy), fall back to InvalidSession rather
      // than a blank page.
      void Promise.all([deriveRoutingId(credentials.secret), deriveKey(credentials.secret)])
        .then(([routingId, key]) => {
          createRoot(root).render(
            <StrictMode>
              <App session={{ routingId, key }} />
            </StrictMode>
          );
        })
        .catch(() => {
          createRoot(root).render(
            <StrictMode>
              <InvalidSession />
            </StrictMode>
          );
        });
    }
  }
}
