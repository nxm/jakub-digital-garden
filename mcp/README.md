# garden-log MCP

Remote MCP server that writes a daily log into the Obsidian vault. Added to
Claude as a custom connector, it lets you photograph a meal or dictate a
thought from your phone and have it land in the right day's note — with no
dates, paths or file names in the conversation.

## Why remote

Claude's mobile apps cannot run local MCP servers, only remote ones. Since the
whole point is capturing things during the day from a phone, this has to be
reachable over HTTPS.

## What writes what

The **client** does the thinking: Claude looks at the photo, identifies the
items and estimates portions. The **server** is a dumb, reliable writer — it
sums the calories, resolves the date and appends to the note. No vision model
or API key lives here.

## The day boundary

The server resolves "today" itself, in `Europe/Warsaw`, and the log day rolls
over at **04:00** rather than midnight so a 01:00 snack still lands on the day
it belongs to. Tools take an optional `date` only for backfilling.

## Tools

| tool | purpose |
| --- | --- |
| `log_meal` | Record a meal or drink. Pass items with portions and calories; the server sums them. Set `contains_fish` — Jakub is allergic. |
| `log_thought` | Append a thought in the user's own words. |
| `get_day` | Read a day back, including the running calorie total. |

## Where it writes

`docs/private/log/YYYY-MM-DD.md`, with `publish: false` in the frontmatter.

Two independent guards keep this off the public web:

1. `engine/build.ts` never walks `docs/private/`, and honours `publish: false`.
2. `docs/private/` is gitignored — **this repository is public**, so a
   committed log would be readable by anyone even though the site excludes it.

The logs live in Obsidian Sync and on the server, never in git.

## Running

```shell
npm install
npm run build
MCP_AUTH_TOKEN=$(openssl rand -hex 32) VAULT_PATH=/srv/jakub-digital-garden/docs node dist/server.js
```

See `.env.example` for the full set of variables.

## Security

The endpoint is a publicly reachable vault writer, so it refuses to start
without `MCP_AUTH_TOKEN` and rejects every request that does not present it as
a bearer token (compared in constant time). Terminate TLS in front of it —
never expose the plain HTTP port.

`GET /health` is deliberately unauthenticated so a proxy can probe it; it
returns nothing but `ok`.

## Concurrency

Appends to one day's note are serialised through a per-file lock. Without it,
two tool calls landing together would both read the same note and the second
write would silently drop the first.
