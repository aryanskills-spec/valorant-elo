# VAL·ELO — Project Context

## Overview
Full-stack friend group Valorant ELO tracker. Node.js/Express backend with a PostgreSQL database and a single-page frontend (`public/index.html`). Deployed; friends use it to track ELO across real matches.

## Players
Aryan (admin), Mateo, Joey, Jay, Max, Tommy, Ethan — seeded with default password = lowercase name.

## Stack
- **Backend:** `server.js` — Express, `pg` (PostgreSQL), `jsonwebtoken`
- **Frontend:** `public/index.html` — vanilla JS SPA, no framework, no bundler
- **Auth:** JWT stored in localStorage (`val-elo-token`), 30-day expiry
- **DB:** PostgreSQL via `DATABASE_URL` env var; SSL in production
- **Match data:** HenrikDev API (`api.henrikdev.xyz`) — requires `HENRIK_API_KEY` env var

## Key Files
- `server.js` — all API routes, ELO engine, DB init/migrations, match sync logic
- `public/index.html` — entire frontend (login, leaderboard, history, rating modal, admin panel)
- `.env` — `DATABASE_URL`, `JWT_SECRET`, `HENRIK_API_KEY`, `VALORANT_REGION`, `PORT`

## ELO System (1–100 scale, starting at 50)
Three components, scaled by K-factor:
- `winComp`: ±3 flat win/loss
- `perfComp`: ±2 based on ACS rank within group (falls back to perf rating if no stats)
- `ratingComp`: ±5 based on peer performance slider (1–100, neutral=50)
- K-factor decay: `max(0.3, 2 / (1 + games * 0.1))` — new players feel changes more

ELO is clamped to `GREATEST(1, LEAST(100, elo + change))`.

## Game Flow
1. **Sync** — any logged-in user hits 🔄 Sync → server fetches last 15 matches per player from HenrikDev, deduplicates by `match_id`, inserts as `status='synced'`
2. **Rate** — each participant rates teammates: performance slider (1–100) + bait score (1–10 🔥)
3. **Finalize** — once all pending raters submit, `finalizeGame()` runs: averages ratings, calculates ELO changes, updates players, marks game `complete`
4. **Force finalize** — admin only, missing raters get neutral score (50 perf, null bait)

## DB Schema (key columns)
- `players`: `id, name, elo, wins, losses, games, riot_id`
- `users`: `id, username, name, password, is_admin, player_id`
- `games`: `id (BIGINT), won, status (pending/synced/complete), participants (int[]), ratings (JSONB), pending_raters (int[]), elo_changes, avg_ratings, avg_bait, match_data, match_id, game_date`

`match_data` JSONB shape: `{ map, mode, score, playerStats: { [playerId]: { agent, kills, deaths, assists, acs, hs, lastAlive?: { count, maxVs } } }, gameStartTs }`

## Sync Cutoff
Games are only imported if `game_start >= today at 8 AM Eastern`. This prevents pulling old matches on first sync.

## API Routes
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/players-list` | public | for login dropdown |
| POST | `/api/login` | public | returns JWT |
| GET | `/api/me` | auth | current user info |
| GET | `/api/state` | auth | players + completed games + pending/synced |
| POST | `/api/game/rate` | auth | submit perf + bait ratings |
| POST | `/api/game/:id/force-finalize` | admin | finalize with neutral for missing raters |
| POST | `/api/game/cancel` | admin | delete pending game |
| DELETE | `/api/game/:id/active` | admin | delete synced game (no ELO) |
| DELETE | `/api/game/:id` | admin | delete complete game + reverse ELO |
| POST | `/api/password/change` | auth | change own password |
| POST | `/api/password/reset` | admin | reset any player's password |
| POST | `/api/player/riot-id` | auth | set own Riot ID |
| POST | `/api/player/riot-id/admin` | admin | set any player's Riot ID |
| GET | `/api/match/sync` | auth | fetch + import matches from HenrikDev |

## Frontend Notes
- Single HTML file, no build step — edit `public/index.html` directly
- State held in `DATA` (from `/api/state`), `ME` (current user), `TOKEN` (JWT)
- Polls `/api/state` every 8 seconds while logged in
- `gv(obj, id)` helper handles both numeric and string keys in JSONB responses
- Modals: `overlay` div contains `M-rating`, `M-changepass`, `M-resetpass`, `M-riotid`

## Ignore
- `valorant-elo.html` on the Desktop — old standalone localStorage prototype, no longer used
