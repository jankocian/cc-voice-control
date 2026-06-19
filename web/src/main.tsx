import { render } from "preact";
import { App } from "./App";
import { readSessionCredentials } from "./lib/session";
import "./index.css";

const root = document.getElementById("app");

if (root) {
  const credentials = readSessionCredentials();
  if (credentials) {
    render(<App credentials={credentials} />, root);
  } else {
    // No valid /s/<id>?token=… — render a minimal, honest message instead of a
    // broken UI. (The Worker also refuses to serve the shell without a token.)
    render(
      <main>
        <header class="app-header">
          <h1 class="app-title">voice control</h1>
        </header>
        <section class="panel status" data-state="offline">
          <div class="status-main">
            <span class="lamp" aria-hidden="true" />
            <div class="status-text">
              <strong>Invalid session link</strong>
              <span>Open the URL from /voice-control:start</span>
            </div>
          </div>
        </section>
      </main>,
      root
    );
  }
}
