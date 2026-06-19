import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { InvalidSession } from "./components/InvalidSession";
import { readSessionCredentials } from "./lib/session";
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
    createRoot(root).render(
      <StrictMode>{credentials ? <App credentials={credentials} /> : <InvalidSession />}</StrictMode>
    );
  }
}
