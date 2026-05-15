-- ============================================================
-- NEXA DISPATCH BOT — SUPABASE SCHEMA
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. PROFILES: Every WhatsApp user (clients, artisans, agents)
CREATE TABLE IF NOT EXISTS public.profiles (
  phone_number     TEXT PRIMARY KEY,
  full_name        TEXT,
  user_type        TEXT NOT NULL DEFAULT 'CLIENT', -- 'CLIENT' | 'ARTISAN' | 'AGENT'
  current_status   TEXT NOT NULL DEFAULT 'NEW',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. ARTISAN META: Extra info for registered artisans
CREATE TABLE IF NOT EXISTS public.artisan_meta (
  artisan_id   TEXT PRIMARY KEY,               -- e.g. NX-ELE-7W2P
  phone_number TEXT NOT NULL UNIQUE,
  category     TEXT NOT NULL,                  -- 'Electrical' | 'Plumbing' | 'Carpentry'
  zone         TEXT NOT NULL,                  -- 'Gidan Kwano' | 'Bosso' | 'Minna Town'
  tier         INT  NOT NULL DEFAULT 3,        -- 1 = Premium, 2 = Standard, 3 = New
  trust_score  NUMERIC(3,1) NOT NULL DEFAULT 5.0,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  total_jobs   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. JOBS: Every service request
CREATE TABLE IF NOT EXISTS public.jobs (
  job_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_phone        TEXT NOT NULL,
  assigned_artisan    TEXT,
  category            TEXT,
  zone                TEXT,
  problem_description TEXT,
  quoted_price        NUMERIC(12,2),
  referred_artisan    TEXT,   -- NX-XXX-XXXX (deep link) or phone number (agent proxy)
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. LEDGER: Financial tracking (15% commission)
CREATE TABLE IF NOT EXISTS public.ledger (
  ledger_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL,
  artisan_phone   TEXT NOT NULL,
  total_job_value NUMERIC(12,2) NOT NULL,
  commission_owed NUMERIC(12,2) NOT NULL,
  payment_status  TEXT NOT NULL DEFAULT 'PENDING',  -- 'PENDING' | 'CLEARED'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES for fast lookups (the bot queries these constantly)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_phone    ON public.profiles (phone_number);
CREATE INDEX IF NOT EXISTS idx_jobs_client       ON public.jobs (client_phone);
CREATE INDEX IF NOT EXISTS idx_jobs_artisan      ON public.jobs (assigned_artisan);
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON public.jobs (status);
CREATE INDEX IF NOT EXISTS idx_artisan_available ON public.artisan_meta (is_available, category, zone);

-- ============================================================
-- ROW LEVEL SECURITY
-- Disabled for now (bot uses service_role key which bypasses RLS).
-- Enable and add policies BEFORE the web dashboard goes live.
-- ============================================================
ALTER TABLE public.profiles    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.artisan_meta DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger       DISABLE ROW LEVEL SECURITY;
