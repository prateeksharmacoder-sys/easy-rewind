/**
 * easy-rewind Learning Assistant — Shared Helpers
 *
 * Extracted from api.js for modularity. All utility functions, runtime config,
 * AI helpers, and database operations that are shared across route modules.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ─────────────────────────────────────────────
// Runtime Configuration (mutable — changes visible to all importers)
// ─────────────────────────────────────────────
const config = {
  apiKey: process.env.GEMINI_API_KEY || null,
  model: 'gemini-2.5-flash',
  apiBaseUrl: 'http://localhost:5000',
  summarizationBackend: 'auto',
  spacedReviewEnabled: true,
  reviewIntervalDays: 3,
  profileUserId: null,
  embedProvider: 'auto',
};

let db = null;
let genAI = null;

// ─────────────────────────────────────────────
// SQLite Database Setup
// ─────────────────────────────────────────────
function getDb() {
  if (db) return db;

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'easy-rewind.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');

  // ─── Create Tables ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'anonymous',
      url         TEXT    NOT NULL,
      title       TEXT    NOT NULL DEFAULT '',
      topic       TEXT    NOT NULL,
      notes       TEXT    DEFAULT '',
      remind_at   TEXT,
      reminded    INTEGER DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      term        TEXT    NOT NULL UNIQUE,
      definition  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS search_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'anonymous',
      query       TEXT    NOT NULL,
      found       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT    NOT NULL DEFAULT 'anonymous',
      content       TEXT    NOT NULL,
      source_url    TEXT,
      source_title  TEXT,
      remind_at     TEXT,
      reminded      INTEGER DEFAULT 0,
      reminder_note TEXT,
      completed     INTEGER DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL DEFAULT 'anonymous',
      reminder_type  TEXT    DEFAULT 'custom',
      reference_type TEXT,
      reference_id   INTEGER,
      title          TEXT    NOT NULL,
      message        TEXT,
      remind_at      TEXT    NOT NULL,
      reminded       INTEGER DEFAULT 0,
      dismissed      INTEGER DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      repeat_interval_days INTEGER DEFAULT 0,
      repeat_count   INTEGER DEFAULT 0,
      max_repeats    INTEGER,
      next_review_at TEXT
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'anonymous',
      endpoint    TEXT    NOT NULL,
      keys        TEXT,
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS research_queue (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT    NOT NULL DEFAULT 'anonymous',
      url              TEXT    NOT NULL,
      title            TEXT,
      user_notes       TEXT,
      research_result  TEXT,
      status           TEXT    DEFAULT 'pending',
      error_message    TEXT,
      remind_when_done INTEGER DEFAULT 1,
      created_at       TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      completed_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'anonymous',
      url         TEXT    NOT NULL,
      page_title  TEXT    DEFAULT '',
      text        TEXT    NOT NULL,
      context     TEXT,
      color       TEXT    DEFAULT 'yellow',
      tags        TEXT    DEFAULT '',
      note        TEXT    DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT    NOT NULL DEFAULT 'anonymous',
      url              TEXT,
      title            TEXT     DEFAULT '',
      content          TEXT     DEFAULT '',
      ai_summary       TEXT     DEFAULT '',
      tags             TEXT     DEFAULT '',
      embedding        TEXT,
      source_type      TEXT     DEFAULT 'web',
      memory_score     REAL    DEFAULT 0.5,
      interaction_count INTEGER DEFAULT 0,
      last_interaction TEXT,
      created_at       TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS item_tags (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id  INTEGER NOT NULL,
      tag      TEXT    NOT NULL,
      UNIQUE(item_id, tag)
    );

    CREATE TABLE IF NOT EXISTS memory_connections (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL DEFAULT 'anonymous',
      source_item_id INTEGER NOT NULL,
      target_item_id INTEGER NOT NULL,
      relationship   TEXT    DEFAULT 'related',
      confidence     REAL   DEFAULT 0.5,
      source         TEXT    DEFAULT 'manual',
      auto_discovered INTEGER DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      UNIQUE(source_item_id, target_item_id)
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'anonymous',
      level       TEXT    DEFAULT 'INFO',
      component   TEXT    DEFAULT 'client',
      message     TEXT,
      stack       TEXT,
      metadata    TEXT,
      created_at  TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS flashcards (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT    NOT NULL DEFAULT 'anonymous',
      term             TEXT    NOT NULL,
      definition       TEXT    NOT NULL DEFAULT '',
      source           TEXT    DEFAULT 'manual',
      source_id        INTEGER,
      source_url       TEXT,
      ease_factor      REAL    DEFAULT 2.5,
      interval_days    INTEGER DEFAULT 0,
      repetitions      INTEGER DEFAULT 0,
      next_review_at   TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      last_reviewed_at TEXT,
      created_at       TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS quiz_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT    NOT NULL DEFAULT 'anonymous',
      item_id       INTEGER NOT NULL,
      item_type     TEXT    NOT NULL,
      correct       INTEGER NOT NULL DEFAULT 0,
      time_spent_ms INTEGER,
      quizzed_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS digests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT    NOT NULL DEFAULT 'anonymous',
      title           TEXT    NOT NULL,
      summary         TEXT    DEFAULT '',
      period_start    TEXT    NOT NULL,
      period_end      TEXT    NOT NULL,
      bookmark_count  INTEGER DEFAULT 0,
      note_count      INTEGER DEFAULT 0,
      highlight_count INTEGER DEFAULT 0,
      flashcard_count INTEGER DEFAULT 0,
      quiz_accuracy   REAL    DEFAULT 0,
      top_topics      TEXT    DEFAULT '[]',
      top_items       TEXT    DEFAULT '[]',
      sent_at         TEXT,
      created_at      TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS items_fts (
      id      INTEGER PRIMARY KEY,
      title   TEXT,
      content TEXT,
      tags    TEXT
    );
  `);

  // ─── Create Indexes ──────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id    ON bookmarks (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_topic      ON bookmarks (user_id, topic);
    CREATE INDEX IF NOT EXISTS idx_notes_user_id        ON notes (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reminders_user_id    ON reminders (user_id, remind_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_pending    ON reminders (remind_at) WHERE reminded = 0 AND dismissed = 0;
    CREATE INDEX IF NOT EXISTS idx_research_user        ON research_queue (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_search_log_user      ON search_log (user_id);
    CREATE INDEX IF NOT EXISTS idx_cache_term           ON cache (term);
    CREATE INDEX IF NOT EXISTS idx_items_user_created   ON items (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag        ON item_tags (tag);
    CREATE INDEX IF NOT EXISTS idx_highlights_user      ON highlights (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_connections_user     ON memory_connections (user_id);
    CREATE INDEX IF NOT EXISTS idx_error_log_user       ON error_log (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_flashcards_user      ON flashcards (user_id, next_review_at);
    CREATE INDEX IF NOT EXISTS idx_flashcards_due       ON flashcards (next_review_at);
    CREATE INDEX IF NOT EXISTS idx_quiz_user_date       ON quiz_results (user_id, quizzed_at);
    CREATE INDEX IF NOT EXISTS idx_quiz_item            ON quiz_results (item_id, item_type);
    CREATE INDEX IF NOT EXISTS idx_digests_user          ON digests (user_id, created_at DESC);
  `);

  // ─── Migrations (for existing databases) ────
  try {
    db.exec(`ALTER TABLE memory_connections ADD COLUMN source TEXT DEFAULT 'manual'`);
  } catch (_) {
    /* column already exists */
  }

  // Try to create the FTS virtual table (best-effort — SQLite version dependent)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        title, content, tags, content='items', content_rowid='id'
      );
    `);
  } catch (_) {
    /* FTS5 not available — hybrid search falls back to LIKE queries */
  }

  console.log(`[DB] SQLite ready at ${dbPath}`);
  return db;
}

// ─────────────────────────────────────────────
// Settings (persisted to settings.json)
// ─────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(raw);
      const savedKey = saved.apiKey || saved.gemini_api_key;
      // Only override with saved key if it's not the placeholder AND not empty
      if (savedKey && savedKey !== 'your_gemini_api_key_here') {
        config.apiKey = savedKey;
      }
      if (saved.apiBaseUrl || saved.api_base_url)
        config.apiBaseUrl = saved.apiBaseUrl || saved.api_base_url || 'http://localhost:5000';
      if (saved.summarizationBackend || saved.summarization_backend)
        config.summarizationBackend = saved.summarizationBackend || saved.summarization_backend || 'auto';
      if (saved.spacedReviewEnabled !== undefined) config.spacedReviewEnabled = saved.spacedReviewEnabled;
      if (saved.reviewIntervalDays) config.reviewIntervalDays = parseInt(saved.reviewIntervalDays) || 3;
      if (saved.embedProvider) config.embedProvider = saved.embedProvider || 'auto';
      if (saved.model || saved.ai_model) {
        const model = saved.model || saved.ai_model;
        const deprecatedModels = ['gemini-1.5-pro', 'gemini-1.0-pro'];
        config.model = deprecatedModels.includes(model) ? 'gemini-2.5-flash' : model || 'gemini-2.5-flash';
      }
      if (saved.digestPrefs) config.digestPrefs = saved.digestPrefs;
      if (saved.profileUserId) config.profileUserId = saved.profileUserId;
      if (!config.profileUserId) {
        config.profileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        saveSettings();
      }
      console.log(
        `[Settings] Loaded: model=${config.model}, summarization=${config.summarizationBackend}, has_key=!!${!!config.apiKey}`
      );
    } else {
      config.profileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      saveSettings();
    }
  } catch (err) {
    console.warn('[Settings] Could not load settings file:', err.message);
    config.profileUserId =
      config.profileUserId || 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

function saveSettings() {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      SETTINGS_PATH,
      JSON.stringify(
        {
          apiKey: config.apiKey || '',
          model: config.model,
          apiBaseUrl: config.apiBaseUrl,
          summarizationBackend: config.summarizationBackend,
          spacedReviewEnabled: !!config.spacedReviewEnabled,
          reviewIntervalDays: config.reviewIntervalDays,
          profileUserId: config.profileUserId,
          embedProvider: config.embedProvider,
          digestPrefs: config.digestPrefs || null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn('[Settings] Could not save settings file:', err.message);
  }
}

// Load settings on module init
loadSettings();

// ─────────────────────────────────────────────
// Gemini AI Client
// ─────────────────────────────────────────────
function getGenAI() {
  const aiKey = config.apiKey || process.env.GEMINI_API_KEY;
  if (!aiKey || aiKey === 'your_gemini_api_key_here') return null;
  if (!genAI) genAI = new GoogleGenerativeAI(aiKey);
  return genAI;
}

function resetGenAI() {
  genAI = null;
}

async function callGemini(prompt) {
  const ai = getGenAI();
  if (!ai) return null;
  const model = ai.getGenerativeModel({ model: config.model });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ─────────────────────────────────────────────
// General Helpers
// ─────────────────────────────────────────────
function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.user_id || req.query?.user_id || 'anonymous';
}

function normalizeDate(dateValue) {
  if (!dateValue) return null;
  if (dateValue instanceof Date && !isNaN(dateValue.getTime())) return dateValue.toISOString();
  if (typeof dateValue !== 'string') return null;
  const normalized = dateValue.trim().replace(' ', 'T');
  const withZone = normalized.endsWith('Z') ? normalized : normalized + 'Z';
  const date = new Date(withZone);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeUserId(value) {
  const cleaned = sanitize(value || '', 120);
  return cleaned || config.profileUserId || 'anonymous';
}

function createReminder(database, userId, reminder) {
  const remindAt = normalizeDate(reminder.remind_at) || new Date().toISOString();
  const repeatIntervalDays = Math.max(0, parseInt(reminder.repeat_interval_days) || 0);
  const maxRepeats =
    reminder.max_repeats === undefined || reminder.max_repeats === null
      ? null
      : Math.max(0, parseInt(reminder.max_repeats));
  const repeatCount = Math.max(0, parseInt(reminder.repeat_count) || 0);

  return database
    .prepare(
      `
    INSERT INTO reminders (
      user_id, reminder_type, reference_type, reference_id, title, message,
      remind_at, repeat_interval_days, repeat_count, max_repeats, next_review_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      userId,
      reminder.reminder_type || 'custom',
      reminder.reference_type || null,
      reminder.reference_id || null,
      sanitize(reminder.title || 'Reminder', 200),
      sanitize(reminder.message || '', 1000),
      remindAt,
      repeatIntervalDays || null,
      repeatCount,
      maxRepeats,
      reminder.next_review_at || null
    );
}

/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Calculates the next review interval and eased factor based on the quality
 * of recall (0-5). Quality >= 3 is considered a successful recall.
 *
 * @param {number} quality — recall quality 0-5 (0=forgotten, 5=perfect)
 * @param {object} card   — {ease_factor, interval_days, repetitions}
 * @returns {{ ease_factor: number, interval_days: number, repetitions: number, next_review_at: string }}
 */
function calculateNextReview(quality, card = {}) {
  const ef = Math.max(1.3, card.ease_factor || 2.5);
  const interval = Math.max(0, parseInt(card.interval_days) || 0);
  const reps = parseInt(card.repetitions) || 0;

  let newEf, newInterval, newReps;

  if (quality >= 3) {
    // Correct recall
    if (reps === 0) {
      newInterval = 1;
    } else if (reps === 1) {
      newInterval = 6;
    } else {
      newInterval = Math.round(interval * ef);
    }
    newReps = reps + 1;
  } else {
    // Incorrect recall — reset
    newInterval = 1;
    newReps = 0;
  }

  // Update ease factor using SM-2 formula
  newEf = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

  const nextDate = new Date(Date.now() + newInterval * 24 * 60 * 60 * 1000);
  return {
    ease_factor: Math.round(newEf * 100) / 100,
    interval_days: newInterval,
    repetitions: newReps,
    next_review_at: nextDate.toISOString(),
  };
}

function scheduleNextReview(database, reminder) {
  if (!config.spacedReviewEnabled) return null;
  const intervalDays = parseInt(reminder.repeat_interval_days) || config.reviewIntervalDays || 3;
  const maxRepeats =
    reminder.max_repeats === null || reminder.max_repeats === undefined ? null : parseInt(reminder.max_repeats);
  const repeatCount = parseInt(reminder.repeat_count) || 0;
  if (!intervalDays || (maxRepeats !== null && repeatCount >= maxRepeats)) return null;

  const nextAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
  return createReminder(database, reminder.user_id, {
    reminder_type: reminder.reminder_type,
    reference_type: reminder.reference_type,
    reference_id: reminder.reference_id,
    title: `Review again: ${sanitize(reminder.title || 'Saved item', 160)}`,
    message: reminder.message || 'Time for your next spaced review.',
    remind_at: nextAt,
    repeat_interval_days: intervalDays,
    repeat_count: repeatCount + 1,
    max_repeats,
  });
}

function sanitize(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

function isValidId(id) {
  if (!id) return false;
  const num = parseInt(id);
  return !isNaN(num) && num > 0 && String(num) === String(id);
}

async function sendPushNotification(userId, title, body, data = {}) {
  console.log(`[Push] Would notify ${userId}: "${title}" — ${body}`);
}

// ─────────────────────────────────────────────
// Embedding Helpers
// ─────────────────────────────────────────────
async function generateEmbedding(text) {
  const trimmed = text.trim().slice(0, 8000);
  const provider = config.embedProvider || 'auto';

  if (provider === 'openai' || (provider === 'auto' && config.apiKey && config.apiKey.startsWith('sk-'))) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { input: trimmed, model: 'text-embedding-ada-002' },
        { headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' } }
      );
      if (response.data?.data?.[0]?.embedding) {
        return response.data.data[0].embedding;
      }
    } catch (err) {
      console.warn('[Embedding] OpenAI embedding failed:', err.message);
    }
    if (provider === 'openai') {
      console.warn('[Embedding] OpenAI explicitly selected but failed, using hash fallback');
      return generateHashEmbedding(trimmed, 128);
    }
  }

  const ai = getGenAI();
  if (ai && provider !== 'openai') {
    try {
      const embedModel = ai.getGenerativeModel({ model: 'text-embedding-004' });
      const result = await embedModel.embedContent(trimmed);
      const vector = result?.embedding?.values;
      if (vector && Array.isArray(vector) && vector.length > 0) {
        return vector;
      }
    } catch (err) {
      console.warn('[Embedding] Gemini embedding failed, trying fallback:', err.message);
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('[Embedding] Using hash fallback (no AI embedding provider configured)');
  }
  return generateHashEmbedding(trimmed, 128);
}

function generateHashEmbedding(text, dimensions = 128) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const vector = new Array(dimensions).fill(0);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= magnitude;
    }
  }
  return vector;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(embeddingStr) {
  try {
    if (typeof embeddingStr === 'string') return JSON.parse(embeddingStr);
    if (Array.isArray(embeddingStr)) return embeddingStr;
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// AI Summarization Helper
// ─────────────────────────────────────────────
async function summarizeText(text, options = {}) {
  const { maxSentences = 3, style = 'concise' } = options;
  const trimmed = text.trim().slice(0, 12000);
  if (!trimmed) return { success: false, error: 'No text to summarize' };

  const ai = getGenAI();
  if (!ai) {
    return { success: false, error: 'AI not configured — set GEMINI_API_KEY in .env or runtime settings' };
  }

  const styleGuide =
    style === 'concise'
      ? `Summarize the following content in ${maxSentences} clear, concise sentences. Focus on the core message. Use plain language.`
      : style === 'bullet'
        ? `Summarize the following content as ${maxSentences} bullet points. Each point should be one line.`
        : `Summarize the following content in ${maxSentences} sentences. Be thorough but concise.`;

  const prompt = `${styleGuide}

Content:
${trimmed}

Summary:`;

  try {
    const summary = await callGemini(prompt);
    if (!summary) return { success: false, error: 'AI returned empty response' };
    return { success: true, summary: summary.trim() };
  } catch (err) {
    console.error('[Summarize Error]', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// Auto-Tagging Helper
// ─────────────────────────────────────────────
async function generateTags(text, options = {}) {
  const { maxTags = 5 } = options;
  const trimmed = text.trim().slice(0, 3000);
  if (!trimmed) return { success: false, error: 'No text to tag', tags: [] };

  const ai = getGenAI();
  if (!ai) {
    const words = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    const sorted = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTags);
    return { success: true, tags: sorted.map(([tag]) => tag) };
  }

  const prompt = `Extract up to ${maxTags} key tags or topics from the following text.
Return ONLY a JSON array of strings, like: ["tag1", "tag2", "tag3"]
No explanation, no formatting, just the array.

Text:
${trimmed}

Tags:`;

  try {
    const result = await callGemini(prompt);
    if (!result) return { success: true, tags: [] };

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : result;
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return {
        success: true,
        tags: parsed
          .slice(0, maxTags)
          .map(t => String(t).trim())
          .filter(Boolean),
      };
    }
    return { success: true, tags: [] };
  } catch (err) {
    console.warn('[Tag Generation Error]', err.message);
    return { success: true, tags: [] };
  }
}

function storeItemTags(database, itemId, tags, userId) {
  if (!tags || tags.length === 0) return;

  database.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId);

  const insert = database.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)');
  const tx = database.transaction(tags => {
    for (const tag of tags) {
      insert.run(itemId, tag.trim().toLowerCase());
    }
  });
  tx(tags);

  const tagString = tags
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
  database.prepare('UPDATE items SET tags = ? WHERE id = ?').run(tagString, itemId);
}

// ─────────────────────────────────────────────
// Source Type Detection
// ─────────────────────────────────────────────
function detectSourceType(url) {
  if (!url) return 'web';
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('github.com')) return 'github';
  if (u.includes('medium.com') || u.includes('substack.com') || u.includes('blog.')) return 'blog';
  if (
    u.includes('news.') ||
    u.includes('reuters.com') ||
    u.includes('cnn.com') ||
    u.includes('bbc.com') ||
    u.includes('nytimes.com') ||
    u.includes('theguardian.com')
  )
    return 'news';
  try {
    const parsed = new URL(u);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const isDocsDomain =
      u.includes('docs.') ||
      u.includes('learn.') ||
      u.includes('wiki.') ||
      parsed.hostname.endsWith('.dev') ||
      parsed.hostname.endsWith('.io') ||
      parsed.hostname.includes('developer') ||
      parsed.hostname.includes('dev.');
    const hasDocsPath =
      pathSegments.some(s => ['docs', 'learn', 'tutorial', 'guide', 'manual', 'reference'].includes(s)) ||
      pathSegments.some(s => s.startsWith('doc') && s.length < 10);
    if (isDocsDomain || hasDocsPath) return 'docs';
  } catch (_) {
    /* Invalid URL — treat as web */
  }
  return 'web';
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────
module.exports = {
  config,
  getDb,
  loadSettings,
  saveSettings,
  getGenAI,
  resetGenAI,
  callGemini,
  getUserId,
  normalizeDate,
  sanitizeUserId,
  createReminder,
  scheduleNextReview,
  calculateNextReview,
  sanitize,
  isValidId,
  sendPushNotification,
  generateEmbedding,
  generateHashEmbedding,
  cosineSimilarity,
  parseEmbedding,
  summarizeText,
  generateTags,
  storeItemTags,
  detectSourceType,
};
