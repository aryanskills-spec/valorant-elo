# VAL·ELO — Deployment Guide

## Deploy to Railway (free, always-on, friends can access from home)

### Step 1 — Push to GitHub

1. Install Git: https://git-scm.com/download/win
2. Open a terminal in this folder and run:
   ```
   git init
   git add .
   git commit -m "initial commit"
   ```
3. Go to https://github.com, create a new **private** repo called `valorant-elo`
4. Push:
   ```
   git remote add origin https://github.com/YOUR_USERNAME/valorant-elo.git
   git branch -M main
   git push -u origin main
   ```

### Step 2 — Deploy on Railway

1. Go to https://railway.app and sign up with GitHub
2. Click **New Project → Deploy from GitHub repo** → select `valorant-elo`
3. Click **Add Service → Database → PostgreSQL**
4. Railway auto-sets the `DATABASE_URL` env var — no action needed
5. Go to your Node.js service → **Settings → Variables**, add:
   ```
   JWT_SECRET = some-long-random-string-here
   NODE_ENV   = production
   ```
6. Click **Deploy** — done!

Your app will be live at something like `valorant-elo-production.up.railway.app`
Share that URL with your friends.

---

## Default Passwords

Each player's default password is their name in lowercase:

| Player | Username | Default Password |
|--------|----------|-----------------|
| Aryan  | aryan    | aryan           |
| Mateo  | mateo    | mateo           |
| Joey   | joey     | joey            |
| Jay    | jay      | jay             |
| Max    | max      | max             |
| Tommy  | tommy    | tommy           |
| Ethan  | ethan    | ethan           |

**Everyone should change their password after first login** (click the 🔑 icon in the header).
Aryan can reset anyone's password using the 🛡 icon.

---

## How It Works

1. **Aryan** logs in and clicks **+ New Game** after you play
2. Aryan selects who played and whether you won or lost
3. Everyone gets a **"Rate Now!"** banner — they log in and rate each other 1–5 stars
4. Once everyone rates (or Aryan force-finalizes), ELO updates automatically
5. The leaderboard updates in real-time for everyone

---

## ELO Formula

- **Win base:** +12 / **Loss base:** −12
- **Performance modifier:** ±up to 16 points based on your rank among teammates
- Best player on winning team: **+28** | Worst on losing team: **−28**
- Top performer on losing team still breaks even or gains a little
