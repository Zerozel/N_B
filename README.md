# NEXA Dispatch Bot — Deployment Guide

## Stack
- **Runtime:** Node.js 18+ on Render.com (free tier works)
- **Database:** Supabase (PostgreSQL)
- **Messaging:** Meta WhatsApp Cloud API

---

## Step 1 — Supabase Setup

1. Go to [supabase.com](https://supabase.com) → New Project.
2. Open **SQL Editor** → paste the full contents of `schema.sql` → Run.
3. Go to **Settings → API**:
   - Copy **Project URL** → `SUPABASE_URL`
   - Copy **service_role** key (starts with `eyJ...`) → `SUPABASE_SERVICE_ROLE_KEY`
   - ⚠️ Do NOT use the `anon` or `publishable` key — the bot needs full DB access.

---

## Step 2 — Meta WhatsApp Cloud API Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → your App → WhatsApp → API Setup.
2. Copy **Phone Number ID** → `META_PHONE_ID`
3. Copy **Temporary or Permanent Access Token** → `META_ACCESS_TOKEN`
4. Note your **WhatsApp Business Account ID** (for reference only).

### Create the 2 required Message Templates
Go to **WhatsApp → Message Templates → Create Template**:

**Template 1: `nexa_job_alert`**
- Category: `UTILITY`
- Language: `English (US)`
- Body: `New job alert! Zone: {{1}}. Issue: {{2}}. Reply ACCEPT to claim or PASS to skip.`

**Template 2: `nexa_payment_verify`**
- Category: `UTILITY`
- Language: `English (US)`
- Body: `Your artisan has completed the job. The total amount is ₦{{1}}. Reply YES to confirm payment or DISPUTE if incorrect.`

---

## Step 3 — Deploy to Render

1. Push this entire folder to a GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service → Connect your repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node Version:** 18+
4. Add **Environment Variables** (from `.env.template`):

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The `eyJ...` service_role key |
| `META_ACCESS_TOKEN` | Your Meta access token |
| `META_PHONE_ID` | Your WhatsApp Phone Number ID |
| `BOT_PHONE_NUMBER` | Your bot's number (e.g., `2348113343613`) |
| `VERIFY_TOKEN` | Any secret string (e.g., `nexa_secure_launch_2026`) |
| `CUSTOMER_SERVICE_NUMBER` | Number that receives enquiries & disputes |
| `ADMIN_NUMBER` | Number with admin command access |

5. Deploy. Render gives you a URL like `https://nexa-bot.onrender.com`.

---

## Step 4 — Register the Webhook with Meta

In Meta Developer Console → WhatsApp → Configuration → Webhook:

- **Callback URL:** `https://nexa-bot.onrender.com/webhook`
- **Verify Token:** Must match your `VERIFY_TOKEN` env var exactly
- **Subscribe to:** `messages`

Click Verify. You should see `✅ WEBHOOK VERIFIED!` in your Render logs.

---

## Step 5 — Set Up the Cron Job (Waterfall Escalation)

The `/cron` endpoint must be called every 60 seconds to escalate jobs through tiers.

**Option A — Free:** Use [cron-job.org](https://cron-job.org)
- URL: `https://nexa-bot.onrender.com/cron`
- Schedule: Every 1 minute

**Option B — Render Cron (Paid):** Add a Cron Job service in Render pointing to `/cron`.

---

## Step 6 — Test the System

### Register an Artisan
Text the bot: `JOIN NEXA`

### Register an Agent
Text the bot: `JOIN AGENT`

### Client Request Flow
Text the bot: `hi` → follow prompts

### Admin Commands (from ADMIN_NUMBER only)
- `NEXA LOGS` — Monthly revenue & job report
- `UNBLOCK 2348012345678` — Unblock a stuck artisan

### Health Check
`GET https://nexa-bot.onrender.com/health` → `{"status":"ok","version":"2.0.0"}`

---

## Bug Fixes Applied (vs. Original Code)

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `.env` | File was corrupted with curl commands pasted in | Clean template provided |
| 2 | `config/supabase.js` | Used `publishable` key which has no write access | Requires `service_role` key |
| 3 | `.env` | Missing `VERIFY_TOKEN`, `ADMIN_NUMBER`, `BOT_PHONE_NUMBER`, `CUSTOMER_SERVICE_NUMBER` | All documented in template |
| 4 | `artisanFlow.js` | `ACCEPT` had no zone filter — artisan in Bosso could steal Gidan Kwano job | Added `.ilike('zone', artisan.zone)` |
| 5 | `artisanFlow.js` | `ON_SITE` price query used `.single()` without `.limit(1)` — crashes with old test data | Added `.order().limit(1)` |
| 6 | `agentFlow.js` | `APPROVING_ARTISAN` both branches missing `.limit(1)` | Added `.order().limit(1)` |
| 7 | `agentFlow.js` | `VERIFYING_PRICE` dispute branch missing `.limit(1)` | Added `.order().limit(1)` |
| 8 | `onboardingFlow.js` | `.replace('_', ' ')` only replaced first underscore (no `/g` flag) — `GIDAN_KWANO` → `GIDAN KWANO` failed | Changed to `.replace(/_/g, ' ')` |
| 9 | `clientFlow.js` | `RATE_` parsing used `split('_')[2]` — wrong index with UUID containing dashes | Changed to `parts[parts.length - 1]` (`.pop()` style) |
| 10 | `artisanFlow.js` | `AWAITING_PRICE` lookup was `.single()` only — no guard | Added `.order('updated_at').limit(1)` |

---

## Operational Zones

Currently configured zones (add more by extending the list messages in `clientFlow.js`):
- Gidan Kwano
- Bosso  
- Minna Town

## Service Categories

Currently: Electrical, Plumbing, Carpentry

To add a new category, update `clientFlow.js` (AWAITING_CATEGORY), `onboardingFlow.js` (ONBOARDING_CAT), and `agentFlow.js` (PROXY_CATEGORY).
