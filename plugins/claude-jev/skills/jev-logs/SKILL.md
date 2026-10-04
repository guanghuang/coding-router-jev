<!-- managed by coding-router-jev -->
---
name: jev-logs
description: >-
  Query active Claude JEV routing session logs. Shows routing decisions,
  model/tier selections, effort levels, and cache observations for the
  current Claude session.
---

# jev-logs

Query the active Claude JEV routing session's routing log. Responds to
questions like "show the last log", "show the last 3 decisions", and
"what model was used for the last turn".

## When to use

Use this skill when the user asks about:
- Recent routing decisions or logs
- Which model or tier was selected
- Reasoning effort levels
- Cache hit/miss observations
- Routing confidence or decision reasons

## How it works

The launcher sets the session log path at startup. Run the query helper
to search only the current session's routing decisions.

## Commands

### Show the last log entry
```sh
jev-logs "$JEV_SESSION_LOG" --last 1
```

### Show the last N log entries
```sh
jev-logs "$JEV_SESSION_LOG" --last N
```

### Filter by tier
```sh
jev-logs "$JEV_SESSION_LOG" --last 10 --filter-tier fast
```

### Filter by model
```sh
jev-logs "$JEV_SESSION_LOG" --last 10 --filter-model claude-sonnet
```

### Filter by decision reason
```sh
jev-logs "$JEV_SESSION_LOG" --last 10 --filter-decision jev
```

### Filter by keyword in prompt
```sh
jev-logs "$JEV_SESSION_LOG" --last 10 --filter-keyword "debug"
```

### Filter by date
```sh
jev-logs "$JEV_SESSION_LOG" --last 10 --filter-date 2026-10-04
```

### Show full details (including full prompt)
```sh
jev-logs "$JEV_SESSION_LOG" --last 1 --detail
```

## Native invocation

This skill is delivered as the `claude-jev` plugin.
Use `/claude-jev:jev-logs` to invoke it explicitly.

## Output format

Default output is a concise human-readable summary with:
- Timestamp
- Prompt preview (truncated to 120 characters)
- Tier, model, effort, decision reason, confidence
- JEV usage tokens (when available)
- Cache observations (when available)

Use `--detail` to include the full prompt text and JEV latency.

## Privacy

- Only the active session log is searched; other sessions are never accessed.
- Full prompt text is shown only with `--detail`.
- API keys and authorization headers are never present in logs.

## Troubleshooting

- "No active session log found": The router has not started or the
  session was not launched through claude-jev.
- "The session log is empty": No routing decisions yet in this session.
- Empty filter results: Try broader filters or check available tiers/models.
