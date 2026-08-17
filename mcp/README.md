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
| `log_training` | Record the day's training, or that there was none. Replaces rather than appends. |
| `log_thought` | Append a thought in the user's own words. |
| `get_day` | Read a day back, including the running calorie total. |

## Where each part lands

| what | where | published |
| --- | --- | --- |
| meals, drinks, calories | `docs/Daily/YYYY-MM-DD.md` | yes |
| health metrics (Garmin) | same note's frontmatter | yes |
| training | `docs/Me/Training/session-*.md`, linked from the day | yes |
| thoughts | `docs/private/thoughts/YYYY-MM-DD.md` | **no** |

The day note is the hub. Meals accumulate, so `log_meal` appends. A day has one
training state, so `log_training` replaces — calling it twice corrects rather
than duplicates.

Training keeps its own note because a session has substance worth comparing
across weeks. Meals do not: nothing ever links to one breakfast, and there would
be some 1800 of them a year.

## Why thoughts are split off

The repository is public, and the publisher pushes within ten minutes. Nothing
stands between speaking into a phone and the note being online — no review step.

Meals and heart rate are dull enough to publish. `log_thought` is not: it is
specified to keep the user's own words without tidying them, which is exactly the
material worth reading twice before it becomes permanent. Git history does not
forget, so publishing is one-way.

So the split runs along the boundary that matters — publishable or not — rather
than along diet and training. `private/` is gitignored and the site never walks
it, which is two independent guards rather than a flag that could be flipped.

Links therefore run from private notes out to public ones, never the reverse: a
public note pointing at a private one renders as a dead link.

## No verdict on rest days

`log_training` takes minutes and, optionally, a real reason — illness, travel.
It does not record whether a rest was planned or a session was skipped. The
weekly plan in `Me/Training.md` already says what each day was for, and comparing
it against what happened is more honest than a label chosen in hindsight, which
would always be chosen generously.

`training_minutes` is absent until something is logged, and `0` means a recorded
rest day. Those are different facts and the frontmatter keeps them apart.

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
