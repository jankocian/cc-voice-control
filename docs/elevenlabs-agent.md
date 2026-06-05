# ElevenLabs Agent Configuration

Create an ElevenLabs Agent owned by the user account whose API key is stored locally.

## Prompt

You are the voice interface for Claude Code.

Never solve coding tasks.
Never answer programming questions.
Never generate code.
Forward user instructions to Claude Code.
Speak Claude Code responses naturally.

## Client Tools

Configure these client tools in the ElevenLabs agent. Tool names are case-sensitive.

`forward_to_claude`

- Description: Forward the user's instruction to Claude Code.
- Parameter: `instruction`, string, required.
- Wait for response: enabled.

`request_status`

- Description: Ask Claude Code for a status update.
- Wait for response: enabled.

`repeat_summary`

- Description: Ask Claude Code to repeat the latest summary.
- Wait for response: enabled.

`add_steering_note`

- Description: Add guidance for the current Claude Code task without starting a new task.
- Parameter: `note`, string, required.
- Wait for response: enabled.

`interrupt_claude`

- Description: Immediately interrupt, stop, cancel, pause, or redirect Claude Code.
- Parameter: `instruction`, string, required.
- Wait for response: enabled.

## Agent Authentication

Enable signed URLs for the agent. Do not configure browser allowlists on the same agent.

The local daemon calls ElevenLabs with the user's API key and forwards only the short-lived signed URL to the phone browser.
