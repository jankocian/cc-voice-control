# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

- Use [GitHub private vulnerability reporting](https://github.com/jankocian/cc-voice-control/security/advisories/new), or
- email **mail@jankocian.com**.

Please include enough detail to reproduce (affected component — phone client,
Cloudflare worker/relay, or local daemon — and steps). This is a solo-maintained
project; expect an initial acknowledgement within a few days.

## Scope

The trust boundaries and what the relay can and cannot see are documented in
[`docs/security-hardening.md`](docs/security-hardening.md). Findings that
strengthen those properties — leaked-URL access, relay-readable content, device
pairing, daemon authentication — are especially welcome. The "Known limitations"
section there lists tradeoffs that are already understood and out of scope.
