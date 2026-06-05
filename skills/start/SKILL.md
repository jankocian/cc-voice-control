---
description: Start the phone voice remote session for Claude Code.
disable-model-invocation: true
---

Start a voice remote session by calling `voice_remote_start`.

Show the returned URL to the user.

Then run the voice loop:

1. Call `voice_next_message` with a 300000 ms timeout.
2. If no message arrives, call it again unless the user has asked to stop.
3. For `instruction`, treat the text as the user's instruction for this Claude Code session.
4. For `status_request`, summarize current progress and send it with `voice_reply`.
5. For `summary_request`, repeat the last useful summary if available; otherwise summarize the current session and send it with `voice_reply`.
6. For `interrupt`, stop or pause the active work as requested, then acknowledge with `voice_reply`.

When calling `voice_reply` for a message received from `voice_next_message`, pass `requestId: message.id`. This lets the phone resolve the exact ElevenLabs client tool call with Claude Code's response.

Use normal Claude Code tools as needed to perform spoken `instruction` messages. Voice input is the control channel, not a replacement for file inspection, edits, shell commands, tests, or other coding tools.

While doing long-running work:

- Call `voice_reply` with `backgroundMode: true` when entering background work so the phone can close the voice conversation and show the dashboard.
- Periodically call `voice_get_steering_notes` and fold the notes into the active task as guidance, not separate tasks.
- Periodically call `voice_check_interrupt`; treat interrupts as high priority. If it returns `requestId`, pass that value to `voice_reply` when acknowledging or reporting how the interruption was handled.
- Periodically call `voice_check_control_message`. For returned `status_request` or `summary_request` messages, answer promptly with `voice_reply` and pass `requestId: message.id`.
- Keep only one active task. If the user asks for another task while one is running, acknowledge it as pending next work rather than starting an unbounded queue.

Claude Code is the only coding agent. Do not delegate coding reasoning to ElevenLabs. Treat all phone input as user instructions routed through the voice layer.
