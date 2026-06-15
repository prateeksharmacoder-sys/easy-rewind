-- ═══════════════════════════════════════════════════════════
-- easy-rewind Learning Assistant — Reference Schema
--
-- This schema is auto-created by backend/routes/api.js on startup.
-- This file is kept as a reference for the table structure only.
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- TABLE 1: bookmarks
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookmarks (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT        NOT NULL DEFAULT 'anonymous',
  url         TEXT        NOT NULL,
  title       TEXT        NOT NULL DEFAULT '',
  topic       TEXT        NOT NULL,
  notes       TEXT        DEFAULT '',
  remind_at   TIMESTAMPTZ,             -- when to remind user to review this
  reminded    BOOLEAN     DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 2: cache
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cache (
  id          BIGSERIAL PRIMARY KEY,
  term        TEXT        NOT NULL,
  answer      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cache_term_unique UNIQUE (term)
);

-- ─────────────────────────────────────────────
-- TABLE 3: search_log
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.search_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT        NOT NULL DEFAULT 'anonymous',
  query       TEXT        NOT NULL,
  found       BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 4: notes (Problem #4 — Ephemeral Thoughts)
-- For quick capture of thoughts/ideas/to-dos
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notes (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT        NOT NULL DEFAULT 'anonymous',
  content      TEXT        NOT NULL,
  source_url   TEXT,                    -- what page you were on when you wrote this
  source_title TEXT,
  remind_at    TIMESTAMPTZ,             -- optional: remind me at this time
  reminded     BOOLEAN     DEFAULT false,
  reminder_note TEXT,                   -- custom reminder message
  completed    BOOLEAN     DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 5: reminders (Central Reminder Engine)
-- Fires reminders for bookmarks, notes, research, anything
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reminders (
  id             BIGSERIAL PRIMARY KEY,
  user_id        TEXT        NOT NULL DEFAULT 'anonymous',
  reminder_type  TEXT        NOT NULL,  -- 'bookmark_review', 'note_action', 'research_done', 'custom'
  reference_type TEXT,                  -- 'bookmark', 'note', 'research'
  reference_id   BIGINT,
  title          TEXT        NOT NULL,
  message        TEXT,
  remind_at      TIMESTAMPTZ NOT NULL,
  reminded       BOOLEAN     DEFAULT false,
  dismissed      BOOLEAN     DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 6: push_subscriptions
-- Stores Web Push / FCM subscription tokens per device
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT        NOT NULL DEFAULT 'anonymous',
  platform          TEXT        NOT NULL,  -- 'web', 'android', 'windows', 'macos'
  subscription_json TEXT        NOT NULL,  -- full push subscription object
  device_name       TEXT,
  last_active       TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 7: research_queue (Problem #2 — Research Later)
-- Queued URLs for AI-powered deep research
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_queue (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT        NOT NULL DEFAULT 'anonymous',
  url              TEXT        NOT NULL,
  title            TEXT,
  user_notes       TEXT,
  research_result  TEXT,                  -- AI-generated research output
  status           TEXT        DEFAULT 'pending',  -- pending, processing, done, failed
  error_message    TEXT,
  remind_when_done BOOLEAN     DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- INDEXES for new tables
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_notes_user_id           ON public.notes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_remind_at         ON public.notes (remind_at) WHERE reminded = false;
CREATE INDEX IF NOT EXISTS idx_reminders_user_id       ON public.reminders (user_id, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_pending       ON public.reminders (remind_at) WHERE reminded = false AND dismissed = false;
CREATE INDEX IF NOT EXISTS idx_push_sub_user           ON public.push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_research_user           ON public.research_queue (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_status         ON public.research_queue (status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_remind_at     ON public.bookmarks (remind_at) WHERE reminded = false;

-- ─────────────────────────────────────────────
-- INDEXES (existing)
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id       ON public.bookmarks (user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at    ON public.bookmarks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_topic         ON public.bookmarks (user_id, topic);
CREATE INDEX IF NOT EXISTS idx_cache_term              ON public.cache (lower(term));
CREATE INDEX IF NOT EXISTS idx_search_log_user         ON public.search_log (user_id);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────
ALTER TABLE public.bookmarks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_queue       ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (avoid conflicts on re-run)
DROP POLICY IF EXISTS "Allow all for anon" ON public.bookmarks;
DROP POLICY IF EXISTS "Allow all for anon" ON public.cache;
DROP POLICY IF EXISTS "Allow all for anon" ON public.search_log;
DROP POLICY IF EXISTS "Allow all for anon" ON public.notes;
DROP POLICY IF EXISTS "Allow all for anon" ON public.reminders;
DROP POLICY IF EXISTS "Allow all for anon" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Allow all for anon" ON public.research_queue;

-- Create permissive policies for anon key (server controls access)
CREATE POLICY "Allow all for anon" ON public.bookmarks          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.cache              FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.search_log         FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.notes              FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.reminders          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.push_subscriptions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.research_queue     FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────
-- GRANT PERMISSIONS EXPLICITLY
-- ─────────────────────────────────────────────
GRANT ALL ON public.bookmarks          TO anon;
GRANT ALL ON public.cache              TO anon;
GRANT ALL ON public.search_log         TO anon;
GRANT ALL ON public.notes              TO anon;
GRANT ALL ON public.reminders          TO anon;
GRANT ALL ON public.push_subscriptions TO anon;
GRANT ALL ON public.research_queue     TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- ─────────────────────────────────────────────
-- VERIFY (Run this to confirm everything worked)
-- ─────────────────────────────────────────────
SELECT
  table_name,
  (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns,
  (SELECT count(*) FROM information_schema.table_privileges tp WHERE tp.table_name = t.table_name AND tp.grantee = 'anon') AS anon_grants
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('bookmarks', 'cache', 'search_log', 'notes', 'reminders', 'push_subscriptions', 'research_queue')
ORDER BY table_name;
