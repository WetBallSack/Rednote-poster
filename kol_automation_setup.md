# KOL Automation — Setup Guide

## Architecture Overview

```
Supabase (DB + Edge Functions + Cron)
    ├── cron-generator/    ← runs every 8h, calls Groq, stores posts
    ├── xhs-poster/        ← runs every 12h, posts to XHS via API (no VPS)
    └── DB tables          ← posts, topics, accounts, analytics, logs

xhs-login-helper/          ← Express + Playwright, deploy on Render (free)
                             Visit in browser once per account to save session cookies

reddit-poster.ts           ← Node.js, runs on Railway/Fly.io

Dashboard (React)          ← deploy on Vercel
```

> ✅ **iPad-compatible**: Every step can be completed from a browser on iPad.
> No terminal, SSH, or local installs required.

---

## Step 1 — Supabase Setup

1. Create project at https://supabase.com
2. Go to **SQL Editor** → paste contents of `schema.sql` → **Run**
3. Enable extensions in Dashboard > Database > Extensions:
   - `pg_cron` ✓
   - `pg_net` ✓
   - `uuid-ossp` ✓
4. Go to **Storage** → **New Bucket** → name it `post-images` → set to **Public**
   _(Stores carousel slide images before they are uploaded to XHS)_

---

## Step 2 — Deploy Edge Functions (Supabase Dashboard, no CLI)

### cron-generator (content generation)
1. Supabase Dashboard → **Edge Functions** → **New Function**
2. Name: `cron-generator`
3. Paste contents of `cron-generator.ts` → **Deploy**
4. **Settings** → add secret: `GROQ_API_KEY=your_key`
5. **Schedules** → add: `0 */8 * * *`

### xhs-poster (posts to 小红书)
1. Supabase Dashboard → **Edge Functions** → **New Function**
2. Name: `xhs-poster`
3. Paste contents of `xhs-poster.ts` → **Deploy**
4. **Schedules** → add: `0 4,16 * * *`

---

## Step 3 — Reddit Setup

### Create Reddit App
1. Go to https://www.reddit.com/prefs/apps
2. Click "create another app" → type: **script**
3. Name: anything, redirect uri: `http://localhost:8080`
4. Note your **client_id** (under app name) and **client_secret**

### Deploy reddit-poster on Railway
1. Go to https://railway.app → **New Project** → **Deploy from GitHub**
2. Select this repo
3. Set env vars in Railway dashboard:
```
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=KOLBot/1.0 by u/YOUR_USERNAME
REDDIT_PASSWORD_YOUR_USERNAME=your_reddit_password
```
4. Add cron in Railway: `0 */8 * * *` → command: `npx ts-node reddit-poster.ts`

### Insert Reddit accounts into DB
```sql
INSERT INTO reddit_accounts (username) VALUES ('your_reddit_username');
```

---

## Step 4 — 小红书 Setup (iPad-compatible, no VPS)

### How it works
- **xhs-poster** Edge Function (Step 2) handles all automated posting via XHS web API — no server required.
- **xhs-login-helper** is a small web app on **Render** (free). Visit it once per account in Safari to scan the QR code. It saves session cookies to Supabase automatically.
- Sessions last ~30 days. Just revisit the login helper when they expire.

### 4a — Deploy xhs-login-helper on Render

1. Go to https://render.com → sign up with GitHub
2. **New** → **Web Service** → connect this GitHub repo
3. Render will auto-detect `xhs-login-helper/render.yaml` — confirm settings:
   - **Root Directory**: `xhs-login-helper`
   - **Region**: Singapore
   - **Plan**: Free
4. Add **Environment Variables**:
   ```
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   LOGIN_SECRET=pick_any_password_here
   ```
5. Click **Deploy** — you'll get a URL like `https://xhs-login-helper.onrender.com`

> ⚠️ **Render free tier** spins down after 15 min of inactivity. It wakes up in ~30 seconds when you visit it — this is fine since the login helper is only used occasionally.

### 4b — Add XHS account to DB

In Supabase **SQL Editor**:
```sql
INSERT INTO xhs_accounts (phone) VALUES ('+86 138 xxxx xxxx');
```

### 4c — Log in to XHS (once per account, from iPad)

1. Open **Safari** on your iPad
2. Go to: `https://xhs-login-helper.onrender.com/login?phone=+86138xxxx&token=YOUR_SECRET`
3. Wait ~30 seconds for Render to wake up, then the QR code appears
4. Open your **小红书 app** → tap the scan icon → scan the QR code
5. Page auto-updates and shows **"✅ Login successful! Cookies saved to Supabase."**

Repeat for each account. When cookies expire (~30 days), just revisit the login URL.

> ⚠️ **Chinese IP note**: XHS login works best from a Chinese or HK IP. Render Singapore usually works. If it doesn't, use a Chinese VPN on your phone only during the QR scan step.

### 4d — Monitor accounts

Visit `https://xhs-login-helper.onrender.com/accounts?token=YOUR_SECRET` to see all account statuses, session health, and re-login links.

---

## Step 5 — Dashboard Setup

### Update App.jsx with your credentials
```jsx
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "your_anon_key"; // public anon key, safe to expose
```

### Deploy on Vercel
1. Go to https://vercel.com → **New Project** → connect this GitHub repo
2. Click **Deploy**

---

## Adding More Topics

```sql
INSERT INTO topics (title, description, source) VALUES
('Your topic title', 'Context for Claude to write about', 'manual');
```

## Auto-Topic Generation (Optional)

Add a second edge function that fetches from CoinGecko trending:
```
GET https://api.coingecko.com/api/v3/search/trending
→ Extract trending coins → insert as topics
```

---

## Account Safety Tips

### Reddit
- Each account should have 50+ karma before posting
- Vary posting times (not exactly every 8h)
- Engage in comments on other posts between your own posts
- Never post the referral link in the post body — only in comments or bio

### 小红书
- Warm up new accounts for 2 weeks (like, comment, follow organically)
- Post max 1-2 times per day per account
- Avoid posting at exactly the same time each day
- If engagement drops suddenly → potential shadowban → rotate to new account
- Keep a pool of 3-5 accounts for rotation
- Re-run the login helper every ~25 days to refresh cookies before they expire

---

## Monitoring (all browser-accessible from iPad)

| What | Where |
|---|---|
| Account health + re-login | `https://xhs-login-helper.onrender.com/accounts?token=SECRET` |
| All generated/published posts | Supabase Dashboard → Table Editor → `posts` |
| Cron run history | Supabase Dashboard → Table Editor → `cron_logs` |
| XHS poster logs | Supabase Dashboard → Edge Functions → `xhs-poster` → Logs |
| Reddit poster logs | Railway dashboard → Deployments → Logs |
| Full dashboard | Your Vercel URL |