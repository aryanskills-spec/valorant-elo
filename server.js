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
// ELO ENGINE
// ─────────────────────────────────────────────

function calcElo(ids, won, avgRatings) {
  const N = ids.length;
  if (N < 2) return {};
  const BASE = 12, K = (N - 1) * 4;

  const sorted = [...ids].sort((a, b) => (avgRatings[b] || 3) - (avgRatings[a] || 3));
  const ranks  = {};
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    const rv = avgRatings[sorted[i]] || 3;
    while (j < sorted.length && (avgRatings[sorted[j]] || 3) === rv) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[sorted[k]] = avgRank;
    i = j;
  }

  const out = {};
  for (const id of ids) {
    const perf = ((N - ranks[id]) / (N - 1) * 2 - 1) * K;
    out[id] = Math.round((won ? BASE : -BASE) + perf);
  }
  return out;
}

// ─────────────────────────────────────────────
// FINALIZE GAME (called when all rated, or force-finalized)
// ─────────────────────────────────────────────

async function finalizeGame(gameId) {
  const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = rows[0];
  if (!game) throw new Error('Game not found');

  const { participants, won, ratings } = game;

  // Average rating each player received from others
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
      : 3; // neutral default if nobody rated them
  }

  const eloChanges = calcElo(participants, won, avgRatings);

  for (const pid of participants) {
    const change = eloChanges[pid] || 0;
    const col    = won ? 'wins' : 'losses';
    await pool.query(
      `UPDATE players SET elo = elo + $1, games = games + 1, ${col} = ${col} + 1 WHERE id = $2`,
      [change, pid]
    );
  }

  await pool.query(
    `UPDATE games
     SET status = 'complete', avg_ratings = $1, elo_changes = $2,
         pending_raters = '{}', completed_at = NOW()
     WHERE id = $3`,
    [avgRatings, eloChanges, gameId]
  );
}

// ─────────────────────────────────────────────
// DATABASE INIT + SEED
// ─────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id     SERIAL PRIMARY KEY,
      name   TEXT    NOT NULL,
      elo    INTEGER DEFAULT 1000,
      wins   INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      games  INTEGER DEFAULT 0
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

  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM players');
  if (parseInt(rows[0].c) === 0) {
    const names = ['Aryan', 'Mateo', 'Joey', 'Jay', 'Max', 'Tommy', 'Ethan'];
    for (let i = 0; i < names.length; i++) {
      const { rows: pr } = await pool.query(
        'INSERT INTO players (name) VALUES ($1) RETURNING id', [names[i]]
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

// Public: player list for login dropdown (no auth needed)
app.get('/api/players-list', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM players ORDER BY id');
  res.json(rows);
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query(
      `SELECT u.*, p.id AS pid
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
    res.json({ token, id: u.pid, name: u.name, isAdmin: u.is_admin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Current user info
app.get('/api/me', auth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, isAdmin: req.user.isAdmin });
});

// Full app state
app.get('/api/state', auth, async (req, res) => {
  const players = await pool.query('SELECT * FROM players ORDER BY elo DESC');
  const games   = await pool.query(
    "SELECT * FROM games WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 30"
  );
  const pending = await pool.query("SELECT * FROM games WHERE status = 'pending' LIMIT 1");
  res.json({
    players:     players.rows,
    games:       games.rows,
    pendingGame: pending.rows[0] || null
  });
});

// Admin: create a new game
app.post('/api/game/create', auth, adminOnly, async (req, res) => {
  try {
    const { participants, won } = req.body;
    if (!Array.isArray(participants) || participants.length < 2)
      return res.status(400).json({ error: 'Need at least 2 participants' });
    if (typeof won !== 'boolean')
      return res.status(400).json({ error: 'Must specify win or loss' });

    const existing = await pool.query("SELECT id FROM games WHERE status = 'pending'");
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'There is already a pending game — cancel it first' });

    const id   = Date.now();
    const pIds = participants.map(Number);
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    await pool.query(
      `INSERT INTO games (id, won, status, participants, ratings, pending_raters, game_date)
       VALUES ($1, $2, 'pending', $3, '{}', $4, $5)`,
      [id, won, pIds, pIds, date]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit ratings
app.post('/api/game/rate', auth, async (req, res) => {
  try {
    const { gameId, ratings } = req.body;
    const raterId = req.user.id;

    const { rows } = await pool.query(
      "SELECT * FROM games WHERE id = $1 AND status = 'pending'", [Number(gameId)]
    );
    const game = rows[0];
    if (!game)                             return res.status(404).json({ error: 'No pending game found' });
    if (!game.participants.includes(raterId)) return res.status(403).json({ error: 'You were not in this game' });
    if (game.ratings[String(raterId)])     return res.status(400).json({ error: 'You already submitted ratings' });

    // Validate: must rate every other participant 1–5
    const others = game.participants.filter(id => id !== raterId);
    for (const oid of others) {
      const s = ratings[oid] ?? ratings[String(oid)];
      if (!s || s < 1 || s > 5)
        return res.status(400).json({ error: 'Please rate all players 1–5 stars' });
    }

    const newRatings = { ...game.ratings, [String(raterId)]: {} };
    for (const oid of others)
      newRatings[String(raterId)][String(oid)] = Number(ratings[oid] ?? ratings[String(oid)]);

    const newPending = game.pending_raters.filter(id => id !== raterId);

    await pool.query(
      'UPDATE games SET ratings = $1, pending_raters = $2 WHERE id = $3',
      [newRatings, newPending, game.id]
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

// Admin: force finalize (uses ratings submitted so far; missing = 3 stars)
app.post('/api/game/finalize', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id FROM games WHERE status = 'pending' LIMIT 1");
    if (!rows[0]) return res.status(404).json({ error: 'No pending game' });
    await finalizeGame(rows[0].id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: cancel pending game
app.post('/api/game/cancel', auth, adminOnly, async (req, res) => {
  await pool.query("DELETE FROM games WHERE status = 'pending'");
  res.json({ ok: true });
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

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`VAL·ELO running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
