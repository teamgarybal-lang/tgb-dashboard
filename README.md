# Harcourts TGB Group – Team Dashboard

Node.js (Express) + SQLite (`data.db`). Port 3100. Run under pm2 as `tgb-dashboard` (`ecosystem.config.js`).

- `/login` – agents and admins sign in (email + password, 180-day session cookie, bcrypt-hashed passwords). The same cookie keeps you signed in when the site is opened from the phone home screen. Behind a proxy the cookie is Secure.
- Installable phone app: `/manifest.webmanifest` (name Harcourts TGB Group Dashboard) and `/sw.js`. Opening the installed app loads `/`, which sends you to sign-in or your page. The service worker caches files under `/static` only. Bump `CACHE` in `sw.js` when those files change. It never caches `/api` or the signed-in pages, so the numbers stay live.
- `/me` – agent phone view: daily +1 totals for today (or any of the last 14 days), this week's day-by-day own totals, this week's and this month's own totals, team progress, their own pipeline addresses, weekly history
- `/admin` – per-agent weekly and monthly totals, daily team totals for the week, leaderboard, quote of the day, day-by-day history, every agent's pipeline addresses, CSV for daily rows, weekly and monthly rollups, and pipeline addresses, weekly targets, TV code. Add an agent or another admin. Reset, deactivate, or delete other accounts, including other admins. You can't do that to yourself, and the last active admin can't be removed. Admin accounts are left out of the leaderboard, the TV, the missing list, and the CSV.
- `/tv` – office TV board (this week, this calendar month, daily breakdown, leaderboard, pipeline count, quote of the day), no login, refreshes every 12 s. The link is `/tv/` plus a 6-character code (lowercase letters and digits, no 0, o, 1, l or i). Opening it on the TV sets a one-year cookie, so plain `/tv` keeps working. The TV can also type the code. `/tv?key=` still accepts the current code. On startup a long key is replaced with a short code, so an old long link stops working. Wrong codes are limited to 10 tries in 10 minutes per address. A new code from /admin signs that TV out. The quote follows the Auckland date and repeats from a built-in list. The TV never shows property addresses.
- Daily metrics, in order: appraisals done, appraisals booked, cold calls, door knocks, letter / flyer drops. Weeks run Monday–Sunday and months are calendar months, both in Pacific/Auckland. Weekly totals feed the weekly targets. There is no separate monthly target, so the TV month bars use the weekly target times the days in that month, divided by 7. The admin month view still shows totals only. Pipeline is a list of addresses per agent. An address is kept to 200 characters, and a long address or note wraps inside the card. The team and TV show how many addresses, not the addresses. Older weekly pipeline counts stay on the weekly CSV.
- Leaderboard score = appraisals done × 30 + appraisals booked × 20 + cold calls + door knocks + letter / flyer drops. Only agents are scored.
- "Numbers in" / the missing list means the agent logged a number above zero on any day in that week (on the TV and week view) or month (on the month view).
- Admin temporary password: `ADMIN_PASSWORD.txt` (change it after first sign-in).

Ops: `pm2 ls`, `pm2 logs tgb-dashboard`, `pm2 restart tgb-dashboard`. Backup = copy `data.db`.

## Public hosting
Cloudflare quick tunnels can't run from this box (outbound port 7844 is blocked). SSH tunnels (localhost.run, pinggy) and localtunnel are blocked too.
Permanent options:
1. Render / Railway / Fly.io: deploy this folder (`npm install && node server.js`) with a persistent disk mounted for `data.db` (SQLite needs a disk; on Render the free plan has no disk, so use the paid Starter plan with a disk, or Fly.io with a volume).
2. Named Cloudflare Tunnel from any always-on PC/mini-PC in the office: `cloudflared tunnel login` → `cloudflared tunnel create tgb` → route DNS `team.<gary-domain>` → `cloudflared tunnel run`. This needs a domain on Gary's Cloudflare account.
3. Quick test from any computer with internet: `node server.js` and then `cloudflared tunnel --url http://localhost:3100` (the URL changes every restart).
