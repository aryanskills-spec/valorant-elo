require('dotenv').config();
const express = require('express');
const { Pool }  = require('pg');
const jwt       = require('jsonwebtoken');
const path      = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'val-elo-dev-secret';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────

const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired — please log in again' }); }
};

const adminOnly = (req, res, next) =>
  req.user?.isAdmin ? next() : res.status(403).json({ error: 'Admin only' });

// ─────────────────────────────────────────────
// ELO ENGINE  (1–100 scale, start 50)
// ─────────────────────────────────────────────
//
// 3-component formula:
//   winComp:    ±3  flat win/loss bonus
//   perfComp:   ±2  based on ACS rank within the group (falls back to rating rank if no stats)
//   ratingComp: ±5  peer ratings — dominant factor (3★=0, 5★=+5, 1★=-5)
//
// K-factor decay: kMult = max(0.3, 2 / (1 + games * 0.1))
//   New player (0 games) → 2x impact; 10 games → ~1x; 50+ games → 0.3x floor
//
function calcElo(ids, won, avgRatings, gamesCounts, playerStats) {
  const N = ids.length;
  if (N < 2) return {};

  const hasStats = playerStats && Object.keys(playerStats).length > 0;

  // Sort by ACS (or by avg rating if no stats available)
  const sortedByPerf = [...ids].sort((a, b) => {
    if (hasStats) return (playerStats[String(b)]?.acs || 0) - (playerStats[String(a)]?.acs || 0);
    return (avgRatings[String(b)] || 3) - (avgRatings[String(a)] || 3);
  });

  // Assign ranks, handling ties with averaged rank index
  const perfRank = {};
  let i = 0;
  while (i < sortedByPerf.length) {
    let j = i;
    const getVal = id => hasStats
      ? (playerStats[String(id)]?.acs || 0)
      : (avgRatings[String(id)] || 3);
    const val = getVal(sortedByPerf[i]);
    while (j < sortedByPerf.length && getVal(sortedByPerf[j]) === val) j++;
    const avgIdx = (i + j - 1) / 2;
    for (let k = i; k < j; k++) perfRank[sortedByPerf[k]] = avgIdx;
    i = j;
  }

  const out = {};
  for (const id of ids) {
    const games = gamesCounts?.[id] ?? 0;
    const kMult = Math.max(0.3, 2 / (1 + games * 0.1));

    const winComp    = won ? 3 : -3;
    const perfComp   = N > 1
      ? ((N - 1 - perfRank[id]) / (N - 1) * 2 - 1) * 2
      : 0;
    // Performance slider is 1-100; 50 = neutral → ±5 ELO component
    const rating     = avgRatings[id] ?? 50;
    const ratingComp = (rating - 50) / 50 * 5;

    out[id] = Math.round((winComp + perfComp + ratingComp) * kMult);
  }
  return out;
}

// ─────────────────────────────────────────────
// FINALIZE GAME
// ─────────────────────────────────────────────

async function finalizeGame(gameId) {
  const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = rows[0];
  if (!game) throw new Error('Game not found');

  const { participants, won, ratings } = game;
  const baitRatings = game.bait_ratings || {};
  const playerStats = game.match_data?.playerStats || {};

  // Average perf rating each player received from others (absent raters → 3 stars)
  const avgRatings = {};
  for (const pid of participants) {
    const received = [];
    for (const rid of participants) {
      if (rid === pid) continue;
      const v = ratings[String(rid)]?.[String(pid)];
      if (v !== undefined) received.push(Number(v));
    }
    avgRatings[pid] = received.length > 0
      ? received.reduce((a, b) => a + b, 0) / received.length
      : 50; // neutral for absent raters on 1-100 scale
  }

  // Average bait rating each player received from others
  const avgBait = {};
  for (const pid of participants) {
    const received = [];
    for (const rid of participants) {
      if (rid === pid) continue;
      const v = baitRatings[String(rid)]?.[String(pid)];
      if (v !== undefined) received.push(Number(v));
    }
    avgBait[pid] = received.length > 0
      ? received.reduce((a, b) => a + b, 0) / received.length
      : null;
  }

  // Fetch games played BEFORE this game for K-factor decay
  const gamesCounts = {};
  for (const pid of participants) {
    const { rows: pr } = await pool.query('SELECT games FROM players WHERE id = $1', [pid]);
    gamesCounts[pid] = pr[0]?.games ?? 0;
  }

  const eloChanges = calcElo(participants, won, avgRatings, gamesCounts, playerStats);

  for (const pid of participants) {
    const change = eloChanges[pid] || 0;
    const col    = won ? 'wins' : 'losses';
    await pool.query(
      `UPDATE players SET elo = GREATEST(1, LEAST(100, elo + $1)), games = games + 1, ${col} = ${col} + 1 WHERE id = $2`,
      [change, pid]
    );
  }

  await pool.query(
    `UPDATE games
     SET status = 'complete', avg_ratings = $1, elo_changes = $2,
         avg_bait = $3, pending_raters = '{}', completed_at = NOW()
     WHERE id = $4`,
    [avgRatings, eloChanges, avgBait, gameId]
  );
}

// ─────────────────────────────────────────────
// LAST ALIVE DERIVER
// Given all match players + top-level kills array (v4), returns
// { [puuid]: { count: N, maxVs: M } } — how many times each player
// was the last one alive on their team, and the biggest clutch they faced.
// ─────────────────────────────────────────────

function computeLastAlive(matchPlayers, kills) {
  // Group all 10 players by team
  const teamPlayers = {};
  for (const p of matchPlayers) {
    const team = (p.team_id || p.team || '').toLowerCase();
    if (!team) continue;
    if (!teamPlayers[team]) teamPlayers[team] = new Set();
    if (p.puuid) teamPlayers[team].add(p.puuid);
  }
  const teams = Object.keys(teamPlayers);
  if (teams.length < 2) return {};

  // Group kills by round number
  const killsByRound = {};
  for (const kill of (kills || [])) {
    const r = kill.round ?? 0;
    if (!killsByRound[r]) killsByRound[r] = [];
    killsByRound[r].push(kill);
  }

  const stats = {}; // puuid → { count, maxVs }

  for (const roundKills of Object.values(killsByRound)) {
    // Process kills in chronological order
    const sorted = [...roundKills].sort(
      (a, b) => (a.time_in_round_in_ms ?? 0) - (b.time_in_round_in_ms ?? 0)
    );

    // Clone alive sets for this round
    const alive = {};
    for (const [team, players] of Object.entries(teamPlayers)) {
      alive[team] = new Set(players);
    }

    // Track who we've already flagged as last-alive this round (avoid double-counting)
    const markedLastAlive = new Set();

    for (const kill of sorted) {
      const victimPuuid = kill.victim?.puuid;
      const victimTeam  = (kill.victim?.team || '').toLowerCase();

      if (victimPuuid && alive[victimTeam]) {
        alive[victimTeam].delete(victimPuuid);
      }

      // After each kill, check if any team is down to 1
      for (const [team, aliveSet] of Object.entries(alive)) {
        if (aliveSet.size !== 1) continue;
        const lastPuuid = [...aliveSet][0];
        if (markedLastAlive.has(lastPuuid)) continue;

        markedLastAlive.add(lastPuuid);
        const enemyTeam  = teams.find(t => t !== team);
        const enemyCount = alive[enemyTeam]?.size ?? 0;
        if (enemyCount > 0) {
          if (!stats[lastPuuid]) stats[lastPuuid] = { count: 0, maxVs: 0 };
          stats[lastPuuid].count++;
          stats[lastPuuid].maxVs = Math.max(stats[lastPuuid].maxVs, enemyCount);
        }
      }
    }
  }

  return stats;
}

// ─────────────────────────────────────────────
// DATABASE INIT + SEED
// ─────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id      SERIAL  PRIMARY KEY,
      name    TEXT    NOT NULL,
      elo     INTEGER DEFAULT 50,
      wins    INTEGER DEFAULT 0,
      losses  INTEGER DEFAULT 0,
      games   INTEGER DEFAULT 0,
      riot_id TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL  PRIMARY KEY,
      username  TEXT    UNIQUE NOT NULL,
      name      TEXT    NOT NULL,
      password  TEXT    NOT NULL,
      is_admin  BOOLEAN DEFAULT false,
      player_id INTEGER REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS games (
      id             BIGINT  PRIMARY KEY,
      won            BOOLEAN NOT NULL,
      status         TEXT    DEFAULT 'pending',
      participants   INTEGER[] NOT NULL,
      ratings        JSONB   DEFAULT '{}',
      pending_raters INTEGER[] NOT NULL,
      elo_changes    JSONB,
      avg_ratings    JSONB,
      game_date      TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      completed_at   TIMESTAMP
    );
  `);

  // Migrations for existing installs
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS riot_id TEXT`);
  await pool.query(`ALTER TABLE games   ADD COLUMN IF NOT EXISTS match_data JSONB`);
  await pool.query(`ALTER TABLE games   ADD COLUMN IF NOT EXISTS bait_ratings JSONB DEFAULT '{}'`);
  await pool.query(`ALTER TABLE games   ADD COLUMN IF NOT EXISTS avg_bait JSONB`);
  await pool.query(`ALTER TABLE games   ADD COLUMN IF NOT EXISTS match_id TEXT`);
  await pool.query(`UPDATE players SET elo = 50 WHERE elo = 1000 AND games = 0`);

  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM players');
  if (parseInt(rows[0].c) === 0) {
    const names = ['Aryan', 'Mateo', 'Joey', 'Jay', 'Max', 'Tommy', 'Ethan'];
    for (let i = 0; i < names.length; i++) {
      const { rows: pr } = await pool.query(
        'INSERT INTO players (name, elo) VALUES ($1, 50) RETURNING id', [names[i]]
      );
      await pool.query(
        `INSERT INTO users (username, name, password, is_admin, player_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [names[i].toLowerCase(), names[i], names[i].toLowerCase(), i === 0, pr[0].id]
      );
    }
    console.log('✓ Seeded players. Default password = lowercase name (e.g. aryan, mateo...)');
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Public: player list for login dropdown
app.get('/api/players-list', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM players ORDER BY id');
  res.json(rows);
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query(
      `SELECT u.*, p.id AS pid, p.riot_id
       FROM users u JOIN players p ON u.player_id = p.id
       WHERE u.username = $1`,
      [username?.toLowerCase().trim()]
    );
    const u = rows[0];
    if (!u || u.password !== password)
      return res.status(401).json({ error: 'Wrong username or password' });

    const token = jwt.sign(
      { id: u.pid, name: u.name, isAdmin: u.is_admin },
      SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, id: u.pid, name: u.name, isAdmin: u.is_admin, riotId: u.riot_id || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Current user info
app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT riot_id FROM players WHERE id = $1', [req.user.id]);
  res.json({ id: req.user.id, name: req.user.name, isAdmin: req.user.isAdmin, riotId: rows[0]?.riot_id || '' });
});

// Full app state
app.get('/api/state', auth, async (req, res) => {
  const players = await pool.query('SELECT * FROM players ORDER BY elo DESC');
  const games   = await pool.query(
    "SELECT * FROM games WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 30"
  );
  const pending = await pool.query("SELECT * FROM games WHERE status = 'pending' LIMIT 1");
  const synced  = await pool.query(
    "SELECT * FROM games WHERE status = 'synced' ORDER BY created_at DESC"
  );
  res.json({
    players:     players.rows,
    games:       games.rows,
    pendingGame: pending.rows[0] || null,
    syncedGames: synced.rows,
  });
});

// Submit ratings (works for both pending and synced games)
app.post('/api/game/rate', auth, async (req, res) => {
  try {
    const { gameId, ratings, baitRatings = {} } = req.body;
    const raterId = req.user.id;

    const { rows } = await pool.query(
      "SELECT * FROM games WHERE id = $1 AND status IN ('pending', 'synced')", [Number(gameId)]
    );
    const game = rows[0];
    if (!game)                              return res.status(404).json({ error: 'Game not found or already completed' });
    if (!game.participants.includes(raterId)) return res.status(403).json({ error: 'You were not in this game' });
    if (game.ratings[String(raterId)])      return res.status(400).json({ error: 'You already submitted ratings' });

    const others = game.participants.filter(id => id !== raterId);
    for (const oid of others) {
      const s = ratings[oid] ?? ratings[String(oid)];
      if (!s || s < 1 || s > 100)
        return res.status(400).json({ error: 'Please rate all players 1–100' });
      const b = baitRatings[oid] ?? baitRatings[String(oid)];
      if (!b || b < 1 || b > 10)
        return res.status(400).json({ error: 'Please rate bait score for all players 1–10' });
    }

    const newRatings = { ...game.ratings, [String(raterId)]: {} };
    for (const oid of others)
      newRatings[String(raterId)][String(oid)] = Number(ratings[oid] ?? ratings[String(oid)]);

    const prevBait = game.bait_ratings || {};
    const newBaitRatings = { ...prevBait, [String(raterId)]: {} };
    for (const oid of others)
      newBaitRatings[String(raterId)][String(oid)] = Number(baitRatings[oid] ?? baitRatings[String(oid)]);

    const newPending = game.pending_raters.filter(id => id !== raterId);

    await pool.query(
      'UPDATE games SET ratings = $1, pending_raters = $2, bait_ratings = $3 WHERE id = $4',
      [newRatings, newPending, newBaitRatings, game.id]
    );

    if (newPending.length === 0) {
      await finalizeGame(game.id);
      return res.json({ ok: true, finalized: true });
    }
    res.json({ ok: true, finalized: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: force finalize any active game by ID (missing raters → 3 stars neutral)
app.post('/api/game/:id/force-finalize', auth, adminOnly, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    const { rows } = await pool.query(
      "SELECT id FROM games WHERE id = $1 AND status IN ('pending', 'synced')", [gameId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Active game not found' });
    await finalizeGame(gameId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: cancel/delete a pending or synced game (no ELO reversal)
app.post('/api/game/cancel', auth, adminOnly, async (req, res) => {
  await pool.query("DELETE FROM games WHERE status = 'pending'");
  res.json({ ok: true });
});

app.delete('/api/game/:id/active', auth, adminOnly, async (req, res) => {
  await pool.query(
    "DELETE FROM games WHERE id = $1 AND status IN ('pending', 'synced')",
    [Number(req.params.id)]
  );
  res.json({ ok: true });
});

// Admin: delete a completed game and reverse its ELO changes
app.delete('/api/game/:id', auth, adminOnly, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    const { rows } = await pool.query(
      "SELECT * FROM games WHERE id = $1 AND status = 'complete'", [gameId]
    );
    const game = rows[0];
    if (!game) return res.status(404).json({ error: 'Completed game not found' });

    const { participants, won, elo_changes } = game;
    const col = won ? 'wins' : 'losses';

    for (const pid of participants) {
      const change = Math.round(Number(elo_changes?.[String(pid)] ?? elo_changes?.[pid] ?? 0));
      await pool.query(
        `UPDATE players
         SET elo    = GREATEST(1, LEAST(100, elo - $1)),
             games  = GREATEST(0, games - 1),
             ${col} = GREATEST(0, ${col} - 1)
         WHERE id = $2`,
        [change, pid]
      );
    }

    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change own password
app.post('/api/password/change', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 3)
    return res.status(400).json({ error: 'Password must be at least 3 characters' });
  const { rows } = await pool.query('SELECT * FROM users WHERE player_id = $1', [req.user.id]);
  if (!rows[0] || rows[0].password !== currentPassword)
    return res.status(401).json({ error: 'Current password is wrong' });
  await pool.query('UPDATE users SET password = $1 WHERE player_id = $2', [newPassword, req.user.id]);
  res.json({ ok: true });
});

// Admin: reset any player's password
app.post('/api/password/reset', auth, adminOnly, async (req, res) => {
  const { playerId, newPassword } = req.body;
  if (!newPassword || newPassword.length < 3)
    return res.status(400).json({ error: 'Password must be at least 3 characters' });
  const r = await pool.query('UPDATE users SET password = $1 WHERE player_id = $2', [newPassword, Number(playerId)]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Player not found' });
  res.json({ ok: true });
});

// Set own Riot ID
app.post('/api/player/riot-id', auth, async (req, res) => {
  const { riotId } = req.body;
  if (!riotId || !riotId.includes('#'))
    return res.status(400).json({ error: 'Riot ID must be in format Name#Tag (e.g. Aryan#NA1)' });
  await pool.query('UPDATE players SET riot_id = $1 WHERE id = $2', [riotId.trim().replace(/\s*#\s*/, '#'), req.user.id]);
  res.json({ ok: true });
});

// Admin: set any player's Riot ID
app.post('/api/player/riot-id/admin', auth, adminOnly, async (req, res) => {
  const { playerId, riotId } = req.body;
  if (!riotId || !riotId.includes('#'))
    return res.status(400).json({ error: 'Riot ID must be in format Name#Tag (e.g. Aryan#NA1)' });
  const r = await pool.query('UPDATE players SET riot_id = $1 WHERE id = $2', [riotId.trim().replace(/\s*#\s*/, '#'), Number(playerId)]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Player not found' });
  res.json({ ok: true });
});

// Admin: recalculate all ELO from scratch by replaying completed games in order
app.post('/api/admin/recalculate-elo', auth, adminOnly, async (req, res) => {
  try {
    const { rows: players } = await pool.query('SELECT id FROM players');
    const { rows: games }   = await pool.query(
      "SELECT * FROM games WHERE status = 'complete' ORDER BY completed_at ASC"
    );

    // Reset every player to baseline
    await pool.query('UPDATE players SET elo = 50, wins = 0, losses = 0, games = 0');

    // Track games played so far for K-factor
    const gamesCounts = {};
    for (const p of players) gamesCounts[p.id] = 0;

    for (const game of games) {
      const { participants, won } = game;

      // Normalise avg_ratings keys to numbers (JSONB stores them as strings)
      const avgRatings = {};
      for (const [pid, val] of Object.entries(game.avg_ratings || {}))
        avgRatings[Number(pid)] = Number(val);

      // Normalise playerStats keys to numbers
      const rawStats = game.match_data?.playerStats || {};
      const playerStats = {};
      for (const [pid, val] of Object.entries(rawStats))
        playerStats[Number(pid)] = val;

      const currentCounts = {};
      for (const pid of participants) currentCounts[pid] = gamesCounts[pid] ?? 0;

      const eloChanges = calcElo(participants, won, avgRatings, currentCounts, playerStats);

      const col = won ? 'wins' : 'losses';
      for (const pid of participants) {
        const change = eloChanges[pid] || 0;
        await pool.query(
          `UPDATE players SET elo = GREATEST(1, LEAST(100, elo + $1)), games = games + 1, ${col} = ${col} + 1 WHERE id = $2`,
          [change, pid]
        );
        gamesCounts[pid] = (gamesCounts[pid] ?? 0) + 1;
      }

      // Persist updated elo_changes so the history graph stays accurate
      await pool.query('UPDATE games SET elo_changes = $1 WHERE id = $2', [eloChanges, game.id]);
    }

    res.json({ ok: true, gamesReplayed: games.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ELO history — replays all completed games from 50 to build per-player timeline
app.get('/api/elo-history', auth, async (req, res) => {
  try {
    const { rows: players } = await pool.query('SELECT id, name FROM players ORDER BY id');
    const { rows: games }   = await pool.query(
      "SELECT elo_changes, game_date, completed_at FROM games WHERE status = 'complete' ORDER BY completed_at ASC"
    );

    const elo = {};
    for (const p of players) elo[p.id] = 50;

    const labels  = ['Start'];
    const series  = {}; // id → [elo values]
    for (const p of players) series[p.id] = [50];

    for (const g of games) {
      for (const [pid, change] of Object.entries(g.elo_changes || {})) {
        const id = Number(pid);
        if (elo[id] == null) elo[id] = 50;
        elo[id] = Math.max(1, Math.min(100, elo[id] + Number(change)));
      }
      const label = g.game_date ||
        new Date(g.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      labels.push(label);
      for (const p of players) series[p.id].push(elo[p.id] ?? 50);
    }

    res.json({ players, labels, series });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Temporary debug route — admin only, returns raw v4 response for first player
app.get('/api/debug/v4-sample', auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM players WHERE riot_id IS NOT NULL AND riot_id LIKE '%#%' LIMIT 1");
  if (!rows[0]) return res.status(400).json({ error: 'No player with Riot ID' });
  const [name, tag] = rows[0].riot_id.split('#').map(s => s.trim());
  const region  = process.env.VALORANT_REGION || 'na';
  const headers = { 'User-Agent': 'val-elo/1.0' };
  if (process.env.HENRIK_API_KEY) headers['Authorization'] = process.env.HENRIK_API_KEY;
  const url = `https://api.henrikdev.xyz/valorant/v4/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`;
  const apiRes = await fetch(url, { headers });
  const data = await apiRes.json();
  // Return just the first match's metadata + first player + kills[0] so we can see field names
  const m = data.data?.[0];
  res.json({
    status: apiRes.status,
    metadata: m?.metadata,
    first_player: m?.players?.[0],
    teams: m?.teams,
    kills_sample: m?.kills?.slice(0, 2),
    raw_error: data.errors || data.error || null,
  });
});

// ─────────────────────────────────────────────
// SYNC — fetch recent matches from Henrik Dev API
// Any authenticated user can trigger a sync
// ─────────────────────────────────────────────

app.get('/api/match/sync', auth, async (req, res) => {
  try {
    const { rows: allPlayers } = await pool.query('SELECT * FROM players');
    const playersWithId = allPlayers.filter(p => p.riot_id && p.riot_id.includes('#'));

    if (playersWithId.length === 0)
      return res.status(400).json({ error: 'No Riot IDs set yet — ask Aryan to set them via 🎯' });

    const region  = process.env.VALORANT_REGION || 'na';
    const headers = { 'User-Agent': 'val-elo/1.0' };
    if (process.env.HENRIK_API_KEY) headers['Authorization'] = process.env.HENRIK_API_KEY;

    // Cutoff: today at 8 AM Eastern time
    // Using a fixed UTC offset for Eastern (-5h standard / -4h daylight).
    // We pick whichever "8 AM Eastern today" is still in the past.
    const nowMs    = Date.now();
    const etOffset = -5 * 3600 * 1000; // EST (close enough; DST is max 1h off)
    const nowET    = new Date(nowMs + etOffset);
    const cutoffET = new Date(nowET);
    cutoffET.setUTCHours(8, 0, 0, 0); // 8 AM in ET expressed as UTC
    if (cutoffET > nowET) cutoffET.setUTCDate(cutoffET.getUTCDate() - 1); // haven't hit 8am yet
    const cutoffTs = Math.floor((cutoffET.getTime() - etOffset) / 1000);

    // Fetch last 15 matches for each player with a Riot ID; deduplicate by matchId
    const matchMap = new Map();
    for (const player of playersWithId) {
      const [name, tag] = player.riot_id.split('#').map(s => s.trim());
      const url = `https://api.henrikdev.xyz/valorant/v4/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=15`;
      try {
        const apiRes = await fetch(url, { headers });
        if (!apiRes.ok) continue;
        const data = await apiRes.json();
        for (const match of (data.data || [])) {
          const matchId = match.metadata?.match_id;
          if (!matchId) continue;
          const matchStartSec = match.metadata?.started_at
            ? Math.floor(new Date(match.metadata.started_at).getTime() / 1000)
            : 0;
          if (matchStartSec < cutoffTs) continue;
          if (!matchMap.has(matchId)) matchMap.set(matchId, match);
        }
      } catch (e) {
        console.error(`Fetch failed for ${player.riot_id}:`, e.message);
      }
    }

    if (matchMap.size === 0)
      return res.json({ imported: 0, message: 'No matches found since yesterday.' });

    // Skip matchIds already in DB
    const { rows: existingGames } = await pool.query(
      'SELECT match_id FROM games WHERE match_id IS NOT NULL'
    );
    const existingIds = new Set(existingGames.map(g => g.match_id));

    let imported = 0;
    for (const [matchId, match] of matchMap) {
      if (existingIds.has(matchId)) continue;

      const matchPlayers = match.players || [];
      const roundsPlayed = match.metadata?.rounds_played ||
        ((match.teams?.red?.rounds_won ?? 0) + (match.teams?.blue?.rounds_won ?? 0)) || 1;

      // Find which registered players are in this match
      const participants = allPlayers.filter(p => {
        if (!p.riot_id) return false;
        const [pName, pTag] = p.riot_id.split('#').map(s => s.trim());
        return matchPlayers.some(mp =>
          mp.name?.toLowerCase() === pName?.toLowerCase() &&
          mp.tag?.toLowerCase()  === pTag?.toLowerCase()
        );
      });

      if (participants.length < 2) continue;

      // Determine win/loss from first participant's perspective
      const [p1Name, p1Tag] = participants[0].riot_id.split('#').map(s => s.trim());
      const p1Data  = matchPlayers.find(mp =>
        mp.name?.toLowerCase() === p1Name?.toLowerCase() &&
        mp.tag?.toLowerCase()  === p1Tag?.toLowerCase()
      );
      const ourTeam  = (p1Data?.team_id || p1Data?.team)?.toLowerCase();
      const oppTeam  = ourTeam === 'red' ? 'blue' : 'red';
      const won      = match.teams?.[ourTeam]?.has_won === true;
      const ourRounds = match.teams?.[ourTeam]?.rounds_won ?? '?';
      const oppRounds = match.teams?.[oppTeam]?.rounds_won ?? '?';

      // Build per-player stats
      const playerStats = {};
      for (const p of participants) {
        const [pName, pTag] = p.riot_id.split('#').map(s => s.trim());
        const mp = matchPlayers.find(m =>
          m.name?.toLowerCase() === pName?.toLowerCase() &&
          m.tag?.toLowerCase()  === pTag?.toLowerCase()
        );
        if (mp) {
          const totalShots = (mp.stats?.headshots ?? 0) + (mp.stats?.bodyshots ?? 0) + (mp.stats?.legshots ?? 0);
          playerStats[String(p.id)] = {
            agent:   mp.agent?.name || mp.character || 'Unknown',
            kills:   mp.stats?.kills   ?? 0,
            deaths:  mp.stats?.deaths  ?? 0,
            assists: mp.stats?.assists ?? 0,
            acs:     Math.round((mp.stats?.score ?? 0) / roundsPlayed),
            hs:      totalShots > 0 ? Math.round((mp.stats?.headshots ?? 0) / totalShots * 100) : 0,
          };
        }
      }

      // Derive last-alive clutch stats from kill feed (v4 only)
      const lastAliveByPuuid = computeLastAlive(matchPlayers, match.kills || []);
      for (const p of participants) {
        const [laName, laTag] = p.riot_id.split('#').map(s => s.trim());
        const mp2 = matchPlayers.find(m =>
          m.name?.toLowerCase() === laName?.toLowerCase() &&
          m.tag?.toLowerCase()  === laTag?.toLowerCase()
        );
        if (mp2?.puuid && playerStats[String(p.id)] && lastAliveByPuuid[mp2.puuid]) {
          playerStats[String(p.id)].lastAlive = lastAliveByPuuid[mp2.puuid];
        }
      }

      const gameStart = match.metadata?.started_at
        ? Math.floor(new Date(match.metadata.started_at).getTime() / 1000)
        : (match.metadata?.game_start || Math.floor(Date.now() / 1000));
      // Format date in Eastern time so it matches when the game was actually played
      const gameDate  = new Date(gameStart * 1000).toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric', year: 'numeric'
      });
      const matchData = {
        map:         match.metadata?.map?.name  || match.metadata?.map  || 'Unknown',
        mode:        match.metadata?.queue?.name || match.metadata?.mode || '',
        score:       `${ourRounds} - ${oppRounds}`,
        playerStats,
        gameStartTs: gameStart, // store raw ts so client can format in local tz
      };

      const pIds   = participants.map(p => p.id);
      const gameId = gameStart * 1000;

      await pool.query(
        `INSERT INTO games (id, won, status, participants, ratings, pending_raters, game_date, match_data, match_id)
         VALUES ($1, $2, 'synced', $3, '{}', $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [gameId, won, pIds, pIds, gameDate, matchData, matchId]
      );
      imported++;
    }

    res.json({
      imported,
      message: imported > 0
        ? `Imported ${imported} new game${imported !== 1 ? 's' : ''}!`
        : 'No new games to import.',
    });
  } catch (e) {
    console.error('Sync error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`VAL·ELO running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
