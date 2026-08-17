# Garmin enrichment

Attaches Garmin Connect health metrics to vault day notes. It is enrichment,
not capture: the MCP server records what you ate and thought during the day,
and this fills in what your watch already knew.

## Why it is re-runnable

Metrics live in the note's **frontmatter**, which has replace semantics, so a
day can be enriched any number of times. Nothing here ever appends to the note
body. That is what makes arbitrary backfill safe — a month you never logged
gets its notes created from health data alone, and a gap left by a failed run
is closed by simply running it again.

```shell
python enrich.py                                  # yesterday and today
python enrich.py --days 7                         # trailing week
python enrich.py --since 2026-07-01 --until 2026-07-31
python enrich.py --date 2026-08-10 --force
python enrich.py --days 30 --dry-run
```

## Partial days

A day enriched at 14:00 has incomplete steps and Body Battery, and a day whose
watch had not synced yet may be missing metrics entirely. Each note records
when it was fetched and whether it is done with:

```yaml
garmin_synced: 2026-08-18T05:12+02:00
garmin_final: true
```

`garmin_final` means **the day is over and nothing is missing** — not merely
that the date has passed. A day written with holes stays open and is fetched
again on later runs, which is what makes an unsynced watch recoverable instead
of permanently lossy.

The escape hatch is age: past `SETTLE_DAYS` an incomplete day is accepted as
incomplete. Garmin does not backfill weeks later, and without a cutoff a day
that genuinely never recorded HRV would be re-fetched forever.

Days marked final are skipped unless `--force` is passed, so the nightly run
converges without re-fetching settled history. Its window is wider than a
couple of days precisely so that still-open ones stay in reach.

## Where it writes

`docs/Daily/YYYY-MM-DD.md` — the same published note the MCP server writes meals
and training into. These metrics go on the site.

What stays private is `docs/private/thoughts/`, which the MCP server keeps
separately: that directory is gitignored and the site never walks it. Nothing
here touches it.

## Fields written

```yaml
sleep_hours: 7.4
body_battery_morning: 82
body_battery_min: 24
body_battery_max: 82
resting_hr: 48
steps: 11240
hrv_last_night: 78
```

Sleep is attributed to the **morning you woke up**, not the evening you fell
asleep — Garmin's day runs midnight to midnight while the vault's log day rolls
over at 04:00, so the two need an explicit rule.

## Cost

The client exposes range endpoints (`get_sleep_daily`, `get_body_battery`,
`get_rhr_daily`, `get_daily_steps`, `get_hrv_data_range`), so a month costs
five requests rather than one per day per metric. Requests are still chunked at
28 days, since these endpoints are undocumented and have been seen to truncate
long spans.

## Field mapping is unverified

Response shapes here were written against community usage, not against a live
account. Rather than guessing silently, any metric that arrives in an
unrecognised shape is reported at the end of the run with the keys that were
actually present:

```
garmin: 1 field(s) returned in an unrecognised shape:
  2026-08-15 body_battery: date, bodyBatteryValuesArray
Map these keys in pick() and re-run.
```

Expect to adjust `pick()` once after the first real run.

## Setup

Log in once, interactively — the account has MFA, so there is a code to type:

```shell
pip install -r requirements.txt
GARMIN_EMAIL=you@example.com GARMIN_PASSWORD=... python enrich.py --login --dry-run
```

Every later run resumes the cached session and never touches the password:

```shell
python enrich.py --days 3 --dry-run
```

**A normal run will not log in.** MFA cannot be answered by a timer, and Garmin
rate-limits its login endpoints by IP — two of the three strategies start
answering `429` after a handful of attempts, which is exactly the hole an
automatic retry would dig. So without a cached session the script stops and
says how to make one, rather than trying.

`garth` keeps the tokens under `~/.garminconnect` (mode 0600) and refreshes
them on its own. Set `GARMIN_TOKENS` to move that directory.

This uses Garmin's private endpoints — there is no free official API for
personal use. It is a grey area under Garmin's terms and will break when they
change authentication. Keep the manual path usable as a fallback.
