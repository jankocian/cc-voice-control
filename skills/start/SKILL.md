---
description: Start the phone voice remote session for Claude Code.
disable-model-invocation: true
---

Start a voice remote session by calling `voice_remote_start`.

Show the returned URL to the user.

Then run the voice loop:

1. Call `voice_next_message` (it long-polls ~45s, then returns empty).
2. If no message arrives, call it again immediately, unless the user has asked to stop. This loop is how you keep listening for the phone.
3. For `instruction`, treat the text as the user's instruction for this Claude Code session.
4. For `status_request`, summarize current progress and send it with `voice_reply`.
5. For `summary_request`, repeat the last useful summary if available; otherwise summarize the current session and send it with `voice_reply`.
6. For `interrupt`, stop or pause the active work immediately, then acknowledge with `voice_reply`.
7. For `session_ended` (or when `voice_remote_status` reports no active session), the remote was stopped: **exit the loop and stop**. Do not call `voice_next_message` again.

To end voice mode: the user runs `/voice-command:stop`, or simply presses Esc in the terminal to interrupt instantly. After `/voice-command:stop`, your next `voice_next_message` returns `session_ended` — exit cleanly.

When calling `voice_reply` for a message received from `voice_next_message`, pass `requestId: message.id`. The phone records speech, the daemon transcribes it (speech-to-text) and forwards the text as the instruction; your reply is turned into speech (text-to-speech) and played back on the phone, matched to that `requestId`.

Use normal Claude Code tools as needed to perform spoken `instruction` messages. Voice input is the control channel, not a replacement for file inspection, edits, shell commands, tests, or other coding tools.

Keep replies concise and speakable — they are read aloud. Lead with the answer; avoid long code blocks in `voice_reply` text.

While doing long-running work:

- Call `voice_reply` with `backgroundMode: true` when entering long background work so the phone shows the dashboard while you keep going. The reply is still spoken; there is no agent turn that can time out.
- Periodically call `voice_get_steering_notes` and fold the notes into the active task as guidance, not separate tasks.
- Periodically call `voice_check_interrupt`; treat interrupts as high priority. If it returns `requestId`, pass that value to `voice_reply` when acknowledging or reporting how the interruption was handled.
- Periodically call `voice_check_control_message`. For returned `status_request` or `summary_request` messages, answer promptly with `voice_reply` and pass `requestId: message.id`.
- Answer every message you receive — they arrive in order, and the user expects a real reply from you to each one (the daemon never answers on your behalf). Reply with `voice_reply` (requestId: message.id) before moving to the next, and pass `taskState: "idle"` when a task is finished so the dashboard shows you are free.
- A short spoken instruction like "how's it going" is a question to answer concisely, not a long task to start.

Claude Code is the only agent here. Treat all phone input as user instructions routed through the voice layer.
