# slav-ops-pings

A tiny public repo that watches Slavomir's apps. Every 10 minutes a GitHub Actions job checks each app's
health URL (`apps.json`) and sends a signed heartbeat to the Ops Cockpit. GitHub's cron is best-effort
(it fired once in twelve hours here), so one run keeps pinging for about five and a half hours and then
starts the next run itself; the cron only restarts the chain if it breaks. A monthly keepalive commit
stops GitHub from disabling the schedules.

## What is in here

- `ping.mjs`: Node 22, no dependencies. GET each health URL (15 s timeout), then POST the result to
  `$COCKPIT_URL/api/ops/heartbeat` with an HMAC-SHA256 signature. `--rounds 33 --every 600` repeats
  that every 10 minutes inside one job.
- `apps.json`: the watched apps and their public health URLs.
- `.github/workflows/ping.yml`: the long-running ping job and its hand-over; its only permission is
  `actions: write`, which it needs to start its own next run.
- `.github/workflows/keepalive.yml`: monthly timestamp commit to `KEEPALIVE.md`.

## What this repo holds

Only public health URLs and one secret, `PINGS_HMAC_SECRET`, stored as a GitHub Actions secret
(with `COCKPIT_URL`). Nothing else lives here. Never commit a secret.

## Rules

- The cockpit must stay first in `apps.json`.
- Keep `apps.json` in step with the cockpit's app list (`lib/ops/apps.ts`); a test there checks it.

## Try it locally

```sh
COCKPIT_URL=http://localhost:3000 PINGS_HMAC_SECRET=throwaway node ping.mjs --dry-run
```

`--dry-run` checks the apps and prints what it would send, but posts nothing.
