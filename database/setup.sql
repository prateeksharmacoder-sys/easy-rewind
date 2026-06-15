-- ═══════════════════════════════════════════════════════════
-- easy-rewind Learning Assistant — Reference Schema
--
-- This schema is auto-created by backend/routes/api.js on startup.
-- This file is kept as a reference for the table structure only.
-- The actual runtime uses SQLite (via better-sqlite3), not PostgreSQL.
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
  reminded    INTEGER     DEFAULT 0,
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
  found       INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 4: notes
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notes (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT        NOT NULL DEFAULT 'anonymous',
  content      TEXT        NOT NULL,
  source_url   TEXT,
  source_title TEXT,
  remind_at    TIMESTAMPTZ,
  reminded     INTEGER     DEFAULT 0,
  reminder_note TEXT,
  completed    INTEGER     DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 5: reminders
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reminders (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT        NOT NULL DEFAULT 'anonymous',
  reminder_type   TEXT        NOT NULL,  -- bookmark_review, note_action, research_done, custom, tab_close
  reference_type  TEXT,                  -- bookmark, note, research
  reference_id    BIGINT,
  title           TEXT        NOT NULL,
  message         TEXT,
  remind_at       TIMESTAMPTZ NOT NULL,
  reminded        INTEGER     DEFAULT 0,
  dismissed       INTEGER     DEFAULT 0,
  repeat_interval_days INTEGER,           -- (v2.1) spaced review interval
  repeat_count    INTEGER     DEFAULT 0, -- (v2.1) how many times repeated
  max_repeats     INTEGER,                -- (v2.1) max spaced review repeats
  next_review_at  TIMESTAMPTZ,            -- (v2.1) when next spaced review is due
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 6: push_subscriptions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT        NOT NULL DEFAULT 'anonymous',
  platform          TEXT        NOT NULL,  -- 'web', 'android', 'windows', 'macos'
  subscription_json TEXT        NOT NULL,
  device_name       TEXT,
  last_active       TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- TABLE 7: research_queue
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_queue (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT        NOT NULL DEFAULT 'anonymous',
  url              TEXT        NOT NULL,
  title            TEXT,
  user_notes       TEXT,
  research_result  TEXT,
  status           TEXT        DEFAULT 'pending',  -- pending, processing, done, failed
  error_message    TEXT,
  remind_when_done INTEGER     DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- TABLE 8: highlights
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.highlights (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT        NOT NULL DEFAULT 'anonymous',
  url         TEXT        NOT NULL,
  page_title  TEXT        NOT NULL DEFAULT '',
  text        TEXT        NOT NULL,
  context     TEXT,
  color       TEXT        DEFAULT 'yellow',
  tags        TEXT        DEFAULT '',
  note        TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id    ON public.bookmarks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_topic      ON public.bookmarks (user_id, topic);
CREATE INDEX IF NOT EXISTS idx_notes_user_id        ON public.notes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminders_user_id    ON public.reminders (user_id, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_pending    ON public.reminders (remind_at) WHERE reminded = 0 AND dismissed = 0;
CREATE INDEX IF NOT EXISTS idx_research_user        ON public.research_queue (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_log_user      ON public.search_log (user_id);
CREATE INDEX IF NOT EXISTS idx_cache_term           ON public.cache (lower(term));
CREATE INDEX IF NOT EXISTS idx_highlights_user_id   ON public.highlights (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_highlights_url       ON public.highlights (user_id, url);

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
ALTER TABLE public.highlights           ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (avoid conflicts on re-run)
DROP POLICY IF EXISTS "Allow all for anon" ON public.bookmarks;
DROP POLICY IF EXISTS "Allow all for anon" ON public.cache;
DROP POLICY IF EXISTS "Allow all for anon" ON public.search_log;
DROP POLICY IF EXISTS "Allow all for anon" ON public.notes;
DROP POLICY IF EXISTS "Allow all for anon" ON public.reminders;
DROP POLICY IF EXISTS "Allow all for anon" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Allow all for anon" ON public.research_queue;
DROP POLICY IF EXISTS "Allow all for anon" ON public.highlights;

-- Create permissive policies for anon key (server controls access)
CREATE POLICY "Allow all for anon" ON public.bookmarks          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.cache              FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.search_log         FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.notes              FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.reminders          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.push_subscriptions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.research_queue     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON public.highlights         FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────
-- GRANT PERMISSIONS
-- ─────────────────────────────────────────────
GRANT ALL ON public.bookmarks          TO anon;
GRANT ALL ON public.cache              TO anon;
GRANT ALL ON public.search_log         TO anon;
GRANT ALL ON public.notes              TO anon;
GRANT ALL ON public.reminders          TO anon;
GRANT ALL ON public.push_subscriptions TO anon;
GRANT ALL ON public.research_queue     TO anon;
GRANT ALL ON public.highlights         TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
