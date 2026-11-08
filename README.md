# Harcourts TGB Group – Team Dashboard

Node.js (Express) + SQLite (`data.db`). Port 3100. Run under pm2 as `tgb-dashboard` (`ecosystem.config.js`).

- `/login` – agents and admins sign in (email + password, 180-day session cookie, bcrypt-hashed passwords). The same cookie keeps you signed in when the site is opened from the phone home screen. Behind a proxy the cookie is Secure.
- Installable phone app: `/manifest.webmanifest` (name Harcourts TGB Group Dashboard) and `/sw.js`. Opening the installed app loads `/`, which sends you to sign-in or your page. The service worker caches files under `/static` only. Bump `CACHE` in `sw.js` when those files change. It never caches `/api` or the signed-in pages, so the numbers stay live.
- `/me` – agent phone view: daily +1 totals for today (or any of the last 14 days), this week's day-by-day own totals, this week's and this month's own totals, team progress, their own pipeline addresses, weekly history
- `/admin` – per-agent weekly and monthly totals, daily team totals for the week, leaderboard, quote of the day, day-by-day history, every agent's pipeline addresses, CSV for daily rows, weekly and monthly rollups, and pipeline addresses, weekly targets, TV code. Add an agent or another admin. Reset, deactivate, or delete other accounts, including other admins. You can't do that to yourself, and the last active admin can't be removed. Admin accounts are left out of the leaderboard, the TV, the missing list, and the CSV.
- `/access` – admin-only record of who signed in or opened the dashboard, starting from the moment tracking was turned on (`access_tracking_started_at` in `settings`). Nothing earlier is reconstructed. A successful sign-in is one event. A visit is opening a signed-in page (`/me`, `/admin`, `/board`, `/opportunities`, `/access`) or saving a number, address, or other deliberate change. The timed refresh of `/api/me`, team totals, the opportunities status poll, and the listings board reload are not visits. A wrong password or an expired session is not a sign-in. Weeks are Monday–Sunday in Pacific/Auckland. `GET /api/admin/access?week=current` is this week through today. `week=previous` is the Monday–Sunday before that. `week=YYYY-MM-DD` is the Monday–Sunday that contains that date. `GET /api/admin/access.csv` uses the same week parameter. Enabled agents are the accountability list. Admins are returned separately. Inactive agents and any other role are listed as roster notes. If the requested week ended before tracking began, everyone is `unknown_history`. That means the interval was not recorded. It does not mean the person never used the dashboard. Number entries in `day_entries` are not sign-ins.
- `/tv` – office TV board (this week, this calendar month, daily breakdown, leaderboard, pipeline count, quote of the day), no login, refreshes every 12 s. The address is `/tv` (and `/tv/`). It is public and read-only: anyone with the link can view it, and nothing on it can be edited. An older `/tv/<code>` link and `/tv?key=` still open the same board. Wrong codes are limited to 10 tries in 10 minutes per address. The quote follows the Auckland date and repeats from a built-in list. The TV never shows property addresses, emails, or passwords.
- `/opportunities` – admin-only South Auckland chase list. The web service collects public OneRoof suburb search pages once a day at about 5:00am Pacific/Auckland (a Render cron job cannot see this service's disk). Admins can also press Run now. Suburb pages are about 150 requests with a two-second pause, so that part usually takes 8 to 15 minutes. The run then opens listing pages for the agent's search price (`priceSearch`), also two seconds apart. The first pass can cover a few thousand homes and take about 2 to 3 hours. Later days only fetch new listings, homes whose displayed price text changed, and long-listed or unpriced homes last fetched more than 7 days ago. The rest of the site keeps working during a run. Days on market come from OneRoof. Price rises and drops are the change between daily snapshots of the numeric asking price and the search price. Listings that leave a suburb search are marked disappeared. Upload a REINZ Statistics Portal CSV on the same page: a disappeared listing with the same normalised address and suburb becomes Sold, and the rest stay Withdrawn / likely unsold. One suburb from the machine that holds the disk: `node opportunities.js suburb_favona-manukau-city-2360`. A suburb crawl that does not reach the reported total does not mark the missing homes as disappeared.
- Agency check for homes that have left OneRoof. It does not run on its own clock. A Monday and Friday 9:00am Pacific/Auckland routine should call `POST /api/admin/opportunities/verification/run` with `{ "trigger": "routine" }`, then `GET /api/admin/opportunities/verification/status` until `run.running` is false, then `GET /api/admin/opportunities/verification/report`. If the 5am crawl is still going the run returns 409 with `deferred: true`. If no full crawl has finished it returns 409 with `no_baseline: true`. Leaving OneRoof, a 404, or the word sold in a footer does not confirm anything. Confirmed sold or confirmed withdrawn requires the same public agency page to show that street address and those words together. Offices without a supported public site stay unverified. The routine can file its own finding with `POST /api/admin/opportunities/verification/evidence`.
- `/board` – listings TV (new listings on the left; sold and conditional on the right). Admins only. The same sign-in cookie is used (180 days, Secure behind the HTTPS proxy). The page reloads its data every 6 minutes and shows one month at a time, the current Auckland month unless an admin picks another month on `/board/manage`. A listing’s month is the optional date on the entry, or the day it was added. Each listing can have an optional second agent. `/board/add` is the short form. `/board/manage` adds, edits, hides and deletes entries. Nothing is loaded from a website.
- Daily metrics, in order: appraisals done, appraisals booked, cold calls, door knocks, letter / flyer drops. Weeks run Monday–Sunday and months are calendar months, both in Pacific/Auckland. Weekly totals feed the weekly targets. There is no separate monthly target, so the TV month bars use the weekly target times the days in that month, divided by 7. The admin month view still shows totals only. Pipeline is a list of addresses per agent. Each address has a stage: Appraised, Appraisal Booked, Hot, Warm, then Cold. Older stages are rewritten on startup (Appraisal booked becomes Appraisal Booked, appraised or appraisal done becomes Appraised, and anything else, including a blank, becomes Warm). An address is kept to 200 characters, and a long address or note wraps inside the card. The team and TV show how many addresses, not the addresses or the stages. Older weekly pipeline counts stay on the weekly CSV.
- Leaderboard score = appraisals done × 5 + appraisals booked × 3. Only agents are scored.
- "Numbers in" / the missing list means the agent logged a number above zero on any day in that week (on the TV and week view) or month (on the month view).
- Admin temporary password: `ADMIN_PASSWORD.txt` (change it after first sign-in).

Ops: `pm2 ls`, `pm2 logs tgb-dashboard`, `pm2 restart tgb-dashboard`. Backup = copy `data.db`.

Clear every KPI number for all time (leaderboard and team totals) with an admin `POST /api/admin/clear-activity`. It runs only when an admin calls it, never on startup. One SQLite transaction deletes every row in `day_entries`, `entries` (so a restart cannot copy the old weekly snapshots back), `activity`, and `weekly_metric_migration` when that table exists. It leaves `users`, `sessions`, `settings`, `pipeline_entries`, pipeline migration tables, and `board_listings` alone. Copy `data.db` first. The body must be JSON. `sid` is an admin session cookie (sign in at `/login`, then copy the cookie, or use the cookie jar below).

```bash
curl -sS -c /tmp/tgb-cookies -X POST 'https://THE-LIVE-HOST/api/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"ADMIN_EMAIL","password":"ADMIN_PASSWORD"}'

curl -sS -b /tmp/tgb-cookies -X POST 'https://THE-LIVE-HOST/api/admin/clear-activity' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

The same call with the cookie pasted directly:

```bash
curl -sS -X POST 'https://THE-LIVE-HOST/api/admin/clear-activity' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: sid=PASTE_ADMIN_SESSION_COOKIE' \
  -d '{}'
```

On the machine that runs the app, `http://127.0.0.1:3100` works in place of `https://THE-LIVE-HOST`. Success looks like `{ "ok": true, "deleted": { "day_entries": N, "entries": N, "activity": N, "weekly_metric_migration": N } }`. No cookie is 401. An agent is 403. A POST that is not JSON is 415.

## Public hosting
Cloudflare quick tunnels can't run from this box (outbound port 7844 is blocked). SSH tunnels (localhost.run, pinggy) and localtunnel are blocked too.
Permanent options:
1. Render / Railway / Fly.io: deploy this folder (`npm install && node server.js`) with a persistent disk mounted for `data.db` (SQLite needs a disk; on Render the free plan has no disk, so use the paid Starter plan with a disk, or Fly.io with a volume).
2. Named Cloudflare Tunnel from any always-on PC/mini-PC in the office: `cloudflared tunnel login` → `cloudflared tunnel create tgb` → route DNS `team.<gary-domain>` → `cloudflared tunnel run`. This needs a domain on Gary's Cloudflare account.
3. Quick test from any computer with internet: `node server.js` and then `cloudflared tunnel --url http://localhost:3100` (the URL changes every restart).
