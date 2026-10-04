<!-- managed by coding-router-jev -->
---
name: jev-logs
description: >-
  Query active Pi JEV routing session logs. Shows routing decisions,
  model/tier selections, effective effort levels, classifier usage,
  and cache observations for the current Pi session.
---

# jev-logs (Pi)

Query the active Pi JEV routing session's log. Responds to questions
like "show the last log", "show the last 3 decisions", "what model
was used", and "show cache observations".

## When to use

Use this skill when the user asks about:
- Recent routing decisions or logs
- Which model or tier was selected
- Effective reasoning effort levels
- Cache hit/miss observations
- Routing confidence or decision reasons
- Classifier (JEV) token usage

## How it works

Call the `jev_logs` tool to query the current active session. The tool
reads only the active session's JSONL log and returns formatted results.
Do not shell out to a globally installed Bun CLI, scan all logs, or
access other sessions.

The `jev_logs` tool is registered by the Pi extension when the package
is enabled. It delegates to `piQueryLogs()` from `src/pi-logs.ts`,
bound to the active session's log path. The tool accepts only the
active session — arbitrary file paths are not exposed.

## Tool usage

### Show the latest decision
Call `jev_logs` with no arguments or `{ "last": 1 }`.

### Show the last N decisions
Call `jev_logs` with `{ "last": N }` where N is 1–100.

### Show full details including prompt and latency
Call `jev_logs` with `{ "last": 1, "detail": true }`.

### Filter by tier
Call `jev_logs` with `{ "last": 10, "filter_tier": "strong" }`.

### Filter by model name
Call `jev_logs` with `{ "last": 10, "filter_model": "gpt-6.1-sol" }`.

### Filter by decision reason
Call `jev_logs` with `{ "last": 10, "filter_decision": "jev" }`.

### Filter by prompt keyword
Call `jev_logs` with `{ "last": 10, "filter_keyword": "debug" }`.

### Filter by date
Call `jev_logs` with `{ "last": 10, "filter_date": "2026-10-04" }`.

## Output format

Summarize the tool output for the user. Include:
- Timestamp and prompt preview
- Tier, model, and effective effort level
- Decision reason and confidence
- JEV classifier usage (input/output tokens) when available
- Cache observations (read/write tokens) when available
- Response usage from the agent model when merged

Never dump raw JSON unless the user explicitly requests it.

## Privacy

- Only the active session log is queried; other sessions are never accessed.
- Full prompt text is shown only with `detail: true`.
- API keys and authorization headers are never present in logs.

## Troubleshooting

- "No active session log found": The router has not started or the
  session log path is not configured.
- "The session log is empty": No routing decisions yet in this session.
- Empty filter results: Try broader filters or check available tiers/models.
