# Voice inbox

Status: implemented.

An agent says one short sentence out loud to its own user. A habla client the user runs registers as an agent of
kind `habla`, long-polls for messages, and speaks them. Nothing is stored for a user with no connected listener.

## Behavior

- `voice_say(text)` (MCP) queues text for the caller's principal only while an agent of kind `habla` registered by
  that principal is connected (polled within the presence window). Otherwise it queues nothing and answers
  `queued: false`.
- Text is trimmed and holds 1 to 500 characters.
- `POST /api/v1/agents/:agentId/voice?wait=N` (agent:connect, kind `habla`, the registering principal only) is the
  listener's heartbeat and long poll. It answers the principal's pending messages oldest first and deletes them, or
  `204` when none arrive within `wait` (capped at 25 s).
- A message is delivered at most once and expires 60 s after it was queued.
- Voice messages are not artifacts: no artifact listing, search, or UI shows them.

## Conformance

VOX-001 and VOX-002 in `conformance.yml`.
