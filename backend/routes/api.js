/**
 * easy-rewind Learning Assistant — API Routes
 *
 * All endpoints:
 *   GET    /api/health             — Server health check
 *   POST   /api/quick-lookup       — AI-powered tech term definition (cached)
 *   POST   /api/bookmark           — Save a bookmark
 *   GET    /api/bookmarks          — List bookmarks
 *   GET    /api/search             — Search bookmarks
 *   DELETE /api/bookmark/:id       — Delete a bookmark
 *   POST   /api/notes              — Create a quick note (Problem #4)
 *   GET    /api/notes              — List notes
 *   PATCH  /api/notes/:id/toggle   — Toggle note completed
 *   DELETE /api/notes/:id          — Delete a note
 *   POST   /api/reminders          — Schedule a reminder
 *   GET    /api/reminders          — Get due/pending reminders
 *   PATCH  /api/reminders/:id      — Acknowledge a reminder
 *   DELETE /api/reminders/:id      — Delete a reminder
 *   POST   /api/research           — Queue deep research (Problem #2)
 *   GET    /api/research           — Get research results
 *   POST   /api/push-subscribe     — Register push subscription
 *   DELETE /api/push-subscribe/:id — Unsubscribe
 *   POST   /api/check-reminders    — Internal: check & send due reminders
 *   POST   /api/summarize          — AI text summarization
 *   POST   /api/items              — Save item with summary + embedding + tags
 *   GET    /api/items              — List items (optional ?since= for sync)
 *   DELETE /api/items/:id          — Delete an item
 *   GET    /api/items/search       — Vector search over items
 *   GET    /api/ask                — RAG question answering
 *   POST   /api/tag                — Auto-tagging
 *   POST   /api/log                — Client error logging
 *   GET    /api/logs               — View error logs
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─────────────────────────────────────────────
// SQLite Database Setup
// ─────────────────────────────────────────────
const Database = require('better-sqlite3');
let db = null;

function getDb() {
  if (db) return db;

  // Ensure data directory exists
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'easy-rewind.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ─── Create Tables ────────────────────────────
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
      answer      TEXT    NOT NULL,
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
      reminder_type  TEXT    NOT NULL,
      reference_type TEXT,
      reference_id   INTEGER,
      title          TEXT    NOT NULL,
      message        TEXT,
      remind_at      TEXT    NOT NULL,
      reminded       INTEGER DEFAULT 0,
      dismissed      INTEGER DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL DEFAULT 'anonymous',
      platform          TEXT    NOT NULL,
      subscription_json TEXT    NOT NULL,
      device_name       TEXT,
      last_active       TEXT    DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      created_at        TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT    NOT NULL DEFAULT 'anonymous',
      url           TEXT    NOT NULL,
      page_title    TEXT    NOT NULL DEFAULT '',
      text          TEXT    NOT NULL,
      context       TEXT,
      color         TEXT    DEFAULT 'yellow',
      tags          TEXT    DEFAULT '',
      note          TEXT    DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
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
  `);

  // ─── New: items + embeddings + tags tables ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT    NOT NULL DEFAULT 'anonymous',
      url           TEXT,
      title         TEXT,
      content       TEXT,
      summary       TEXT,
      tags          TEXT    DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      updated_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    );

    CREATE TABLE IF NOT EXISTS item_embeddings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL UNIQUE,
      embedding     TEXT    NOT NULL,
      model         TEXT    NOT NULL DEFAULT 'gemini',
      created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_tags (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL,
      tag           TEXT    NOT NULL COLLATE NOCASE,
      created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      UNIQUE(item_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_items_user_id     ON items (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_updated_at  ON items (user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag     ON item_tags (tag);

  CREATE TABLE IF NOT EXISTS error_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT    NOT NULL DEFAULT 'anonymous',
    level         TEXT    NOT NULL DEFAULT 'ERROR',
    component     TEXT,
    message       TEXT,
    stack         TEXT,
    metadata      TEXT,
    created_at    TEXT    NOT NULL DEFAULT ((strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
  );

  CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log (created_at DESC);
  `);

  // ─── Backward-compatible schema migrations ───
  const reminderColumns = db.prepare("PRAGMA table_info(reminders)").all().map(row => row.name);
  if (!reminderColumns.includes('repeat_interval_days')) db.exec("ALTER TABLE reminders ADD COLUMN repeat_interval_days INTEGER DEFAULT NULL");
  if (!reminderColumns.includes('repeat_count')) db.exec("ALTER TABLE reminders ADD COLUMN repeat_count INTEGER DEFAULT 0");
  if (!reminderColumns.includes('max_repeats')) db.exec("ALTER TABLE reminders ADD COLUMN max_repeats INTEGER DEFAULT NULL");
  if (!reminderColumns.includes('next_review_at')) db.exec("ALTER TABLE reminders ADD COLUMN next_review_at TEXT");

  // ─── Memory Score migration (Phase 1 — Smart Memory) ───
  const itemColumns = db.prepare("PRAGMA table_info(items)").all().map(row => row.name);
  if (!itemColumns.includes('memory_score')) db.exec("ALTER TABLE items ADD COLUMN memory_score REAL DEFAULT 0.0");
  if (!itemColumns.includes('last_interacted_at')) db.exec("ALTER TABLE items ADD COLUMN last_interacted_at TEXT");
  if (!itemColumns.includes('interaction_count')) db.exec("ALTER TABLE items ADD COLUMN interaction_count INTEGER DEFAULT 0");

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
    CREATE INDEX IF NOT EXISTS idx_highlights_user_id   ON highlights (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_highlights_url       ON highlights (user_id, url);
  `);

  console.log(`[DB] SQLite ready at ${dbPath}`);
  return db;
}

// ─────────────────────────────────────────────
// Gemini AI Client
// ─────────────────────────────────────────────
let genAI = null;
let runtimeApiKey = null;  // Override from settings (persisted)
let runtimeModel = 'gemini-2.5-flash';
let runtimeApiBaseUrl = 'http://localhost:5000';
let runtimeSummarizationBackend = 'auto';
let runtimeSpacedReviewEnabled = false;
let runtimeReviewIntervalDays = 3;
let runtimeProfileUserId = null;
let runtimeEmbedProvider = 'auto';

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// Load persisted settings from disk
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.apiKey || saved.gemini_api_key) runtimeApiKey = saved.apiKey || saved.gemini_api_key;
      if (saved.model || saved.ai_model) runtimeModel = saved.model || saved.ai_model || 'gemini-2.5-flash';
      if (saved.apiBaseUrl || saved.api_base_url) runtimeApiBaseUrl = saved.apiBaseUrl || saved.api_base_url || 'http://localhost:5000';
      if (saved.summarizationBackend || saved.summarization_backend) runtimeSummarizationBackend = saved.summarizationBackend || saved.summarization_backend || 'auto';
      if (saved.spacedReviewEnabled !== undefined) runtimeSpacedReviewEnabled = !!saved.spacedReviewEnabled;
      if (saved.reviewIntervalDays) runtimeReviewIntervalDays = parseInt(saved.reviewIntervalDays) || 3;
      if (saved.embedProvider) runtimeEmbedProvider = saved.embedProvider || 'auto';
      if (saved.model || saved.ai_model) {
        const model = saved.model || saved.ai_model;
        // Reject deprecated/invalid models, default to current
        const deprecatedModels = ['gemini-1.5-pro', 'gemini-1.0-pro'];
        runtimeModel = deprecatedModels.includes(model) ? 'gemini-2.5-flash' : (model || 'gemini-2.5-flash');
      }
      if (saved.profileUserId) runtimeProfileUserId = saved.profileUserId;
      if (!runtimeProfileUserId) {
        runtimeProfileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        saveSettings();
      }
      console.log(`[Settings] Loaded: model=${runtimeModel}, summarization=${runtimeSummarizationBackend}, has_key=!!${!!runtimeApiKey}`);
    } else {
      runtimeProfileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      saveSettings();
    }
  } catch (err) {
    console.warn('[Settings] Could not load settings file:', err.message);
    runtimeProfileUserId = runtimeProfileUserId || 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

// Persist settings to disk
function saveSettings() {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
      apiKey: runtimeApiKey || '',
      model: runtimeModel,
      apiBaseUrl: runtimeApiBaseUrl,
      summarizationBackend: runtimeSummarizationBackend,
      spacedReviewEnabled: !!runtimeSpacedReviewEnabled,
      reviewIntervalDays: runtimeReviewIntervalDays,
      profileUserId: runtimeProfileUserId,
      embedProvider: runtimeEmbedProvider,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.warn('[Settings] Could not save settings file:', err.message);
  }
}

// Load on module init
loadSettings();

function getGenAI() {
  const aiKey = runtimeApiKey || process.env.GEMINI_API_KEY;
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
  const model = ai.getGenerativeModel({ model: runtimeModel });
  const result = await model.generateContent(prompt);

  return result.response.text().trim();
}

// ─────────────────────────────────────────────
// Helpers
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
  return cleaned || runtimeProfileUserId || 'anonymous';
}

function createReminder(database, userId, reminder) {
  const remindAt = normalizeDate(reminder.remind_at) || new Date().toISOString();
  const repeatIntervalDays = Math.max(0, parseInt(reminder.repeat_interval_days) || 0);
  const maxRepeats = reminder.max_repeats === undefined || reminder.max_repeats === null ? null : Math.max(0, parseInt(reminder.max_repeats));
  const repeatCount = Math.max(0, parseInt(reminder.repeat_count) || 0);

  return database.prepare(`
    INSERT INTO reminders (
      user_id, reminder_type, reference_type, reference_id, title, message,
      remind_at, repeat_interval_days, repeat_count, max_repeats, next_review_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

function scheduleNextReview(database, reminder) {
  if (!runtimeSpacedReviewEnabled) return null;
  const intervalDays = parseInt(reminder.repeat_interval_days) || runtimeReviewIntervalDays || 3;
  const maxRepeats = reminder.max_repeats === null || reminder.max_repeats === undefined ? null : parseInt(reminder.max_repeats);
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

/** Stub: push notifications not yet implemented for local storage */
async function sendPushNotification(userId, title, body, data = {}) {
  // Desktop and extension poll /api/reminders — no push needed for local setup
  console.log(`[Push] Would notify ${userId}: "${title}" — ${body}`);
}

// ─────────────────────────────────────────────
// EMBEDDING HELPERS
// ─────────────────────────────────────────────

/**
 * Generate an embedding vector for a given text using the configured provider.
 * Returns an array of numbers.
 */
async function generateEmbedding(text) {
  const trimmed = text.trim().slice(0, 8000);

  const provider = runtimeEmbedProvider || 'auto';

  // When 'openai' is explicitly selected, try OpenAI first
  if (provider === 'openai' || (provider === 'auto' && runtimeApiKey && runtimeApiKey.startsWith('sk-'))) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { input: trimmed, model: 'text-embedding-ada-002' },
        { headers: { 'Authorization': `Bearer ${runtimeApiKey}`, 'Content-Type': 'application/json' } }
      );
      if (response.data?.data?.[0]?.embedding) {
        return response.data.data[0].embedding;
      }
    } catch (err) {
      console.warn('[Embedding] OpenAI embedding failed:', err.message);
    }
    if (provider === 'openai') {
      // Don't fall through to Gemini if OpenAI was explicitly chosen
      console.warn('[Embedding] OpenAI explicitly selected but failed, using hash fallback');
      return generateHashEmbedding(trimmed, 128);
    }
  }

  // Try Gemini embedding model
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

  // Fallback: simple deterministic embedding based on word hash (non-semantic, but functional)
  if (process.env.NODE_ENV === 'development') {
    console.log('[Embedding] Using hash fallback (no AI embedding provider configured)');
  }
  return generateHashEmbedding(trimmed, 128);
}

/**
 * Generate a deterministic hash-based embedding vector.
 * Not semantically meaningful — a fallback when no AI embedding is available.
 */
function generateHashEmbedding(text, dimensions = 128) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const vector = new Array(dimensions).fill(0);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1;
  }

  // Normalize
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= magnitude;
    }
  }
  return vector;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Parse a stored embedding JSON string back into an array.
 */
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
// LLM SUMMARIZATION HELPER
// ─────────────────────────────────────────────

/**
 * Call the configured LLM to generate a summary of text.
 * Returns { success: true, summary } or { success: false, error }.
 */
async function summarizeText(text, options = {}) {
  const { maxSentences = 3, style = 'concise' } = options;
  const trimmed = text.trim().slice(0, 12000);
  if (!trimmed) return { success: false, error: 'No text to summarize' };

  const ai = getGenAI();
  if (!ai) {
    return { success: false, error: 'AI not configured — set GEMINI_API_KEY in .env or runtime settings' };
  }

  const styleGuide = style === 'concise'
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
// AUTO-TAGGING HELPER
// ─────────────────────────────────────────────

/**
 * Call the configured LLM to extract tags from text.
 * Returns { success: true, tags: [...] } or { success: false, error }.
 */
async function generateTags(text, options = {}) {
  const { maxTags = 5 } = options;
  const trimmed = text.trim().slice(0, 3000);
  if (!trimmed) return { success: false, error: 'No text to tag', tags: [] };

  const ai = getGenAI();
  if (!ai) {
    // Fallback: extract simple keywords
    const words = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, maxTags);
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

    // Try to parse JSON from the response
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : result;
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return { success: true, tags: parsed.slice(0, maxTags).map(t => String(t).trim()).filter(Boolean) };
    }
    return { success: true, tags: [] };
  } catch (err) {
    console.warn('[Tag Generation Error]', err.message);
    return { success: true, tags: [] }; // Non-fatal
  }
}

/**
 * Store tags for an item in the item_tags table and the items.tags field.
 */
function storeItemTags(database, itemId, tags, userId) {
  if (!tags || tags.length === 0) return;

  // Delete existing tags for this item
  database.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId);

  // Insert new tags
  const insert = database.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)');
  const tx = database.transaction((tags) => {
    for (const tag of tags) {
      insert.run(itemId, tag.trim().toLowerCase());
    }
  });
  tx(tags);

  // Update the tags field on the items table
  const tagString = tags.map(t => t.trim().toLowerCase()).filter(Boolean).join(',');
  database.prepare('UPDATE items SET tags = ? WHERE id = ?').run(tagString, itemId);
}

// ─────────────────────────────────────────────
// ENDPOINT 1: GET /api/health
// ─────────────────────────────────────────────
router.get('/health', (req, res) => {
  const database = getDb();
  const dbOk = database && database.open;
  res.json({
    status: 'ok',
    service: 'easy-rewind Learning Assistant API',
    timestamp: new Date().toISOString(),
    version: '2.0.1',
    storage: 'sqlite',
    storage_ready: dbOk,
    ai_configured: !!getGenAI(),
  });
});

router.post('/session', (req, res) => {
  const { client_id, device, client_type } = req.body || {};
  const userId = runtimeProfileUserId || 'anonymous';
  return res.json({
    user_id: userId,
    client_id: sanitize(client_id || '', 120),
    device: sanitize(device || '', 120),
    client_type: sanitize(client_type || '', 80),
    synced_at: new Date().toISOString(),
  });
});

router.post('/users/merge', (req, res) => {
  const database = getDb();
  const targetUserId = sanitizeUserId(req.body?.to_user_id || runtimeProfileUserId);
  const sourceUserId = sanitizeUserId(req.body?.from_user_id);

  if (!sourceUserId || sourceUserId === targetUserId) {
    return res.json({ success: true, merged: false, user_id: targetUserId });
  }

  const tables = {
    bookmarks: ['user_id', 'url', 'title', 'topic', 'notes', 'remind_at', 'reminded', 'created_at'],
    notes: ['user_id', 'content', 'source_url', 'source_title', 'remind_at', 'reminded', 'reminder_note', 'completed', 'created_at'],
    highlights: ['user_id', 'url', 'page_title', 'text', 'context', 'color', 'tags', 'note', 'created_at'],
    research_queue: ['user_id', 'url', 'title', 'user_notes', 'research_result', 'status', 'error_message', 'remind_when_done', 'created_at', 'completed_at'],
    reminders: ['user_id', 'reminder_type', 'reference_type', 'reference_id', 'title', 'message', 'remind_at', 'reminded', 'dismissed', 'created_at', 'repeat_interval_days', 'repeat_count', 'max_repeats', 'next_review_at'],
    search_log: ['user_id', 'query', 'found', 'created_at'],
  };

  const merged = {};
  try {
    for (const [table, columns] of Object.entries(tables)) {
      const rows = database.prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE user_id = ?`).all(sourceUserId);
      const insert = database.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      const tx = database.transaction((rows) => {
        for (const row of rows) {
          const values = columns.map(col => col === 'user_id' ? targetUserId : row[col]);
          insert.run(...values);
        }
      });
      tx(rows);
      merged[table] = rows.length;
    }
    return res.json({ success: true, merged: true, user_id: targetUserId, merged_counts: merged });
  } catch (err) {
    console.error('[Merge Users Error]', err.message);
    return res.status(500).json({ error: 'Failed to merge users.' });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT 2: POST /api/quick-lookup
// ─────────────────────────────────────────────
router.post('/quick-lookup', async (req, res) => {
  const { term } = req.body;

  if (!term || typeof term !== 'string' || term.trim().length === 0) {
    return res.status(400).json({ error: 'Please provide a term to look up.' });
  }

  const cleanTerm = sanitize(term, 200);
  if (cleanTerm.length < 1) {
    return res.status(400).json({ error: 'Term is too short.' });
  }

  const database = getDb();

  // Step 1: Check Cache (case-insensitive)
  const cached = database.prepare('SELECT * FROM cache WHERE LOWER(term) = LOWER(?)').get(cleanTerm);
  if (cached) {
    try {
      database.prepare('INSERT INTO search_log (user_id, query, found) VALUES (?, ?, 1)').run(getUserId(req), cleanTerm);
    } catch (_) {}
    return res.json({
      term: cached.term,
      definition: cached.answer,
      source: 'cache',
      cached_at: cached.created_at,
    });
  }

  // Step 2: Check AI
  if (!getGenAI()) {
    const mockDefinition = `"${cleanTerm}" is a tech term. To get AI-powered definitions, please add your GEMINI_API_KEY to the backend/.env file.`;
    return res.json({
      term: cleanTerm,
      definition: mockDefinition,
      source: 'mock',
    });
  }

  // Step 3: Call Gemini (with optional page context + conversation)
  console.log(`[AI Lookup] "${cleanTerm}"`);
  let definition = null;
  let suggestions = [];

  try {
    const { page_context, page_title, conversation } = req.body;
    let prompt;

    // If there's a conversation history, this is a follow-up
    if (conversation && Array.isArray(conversation) && conversation.length > 0) {
      const history = conversation.slice(-4).map(ex =>
        `User: ${ex.term || ex.question}\nAssistant: ${ex.definition || ex.answer}`
      ).join('\n\n');

      prompt = `You are a helpful tech educator having a CONTINUING conversation with a learner.

Previous conversation:
${history}

Now the user says: "${cleanTerm}"

${page_context && page_context.trim().length > 10 ? `\nCurrent page context (for reference): ${page_context.slice(0, 500)}` : ''}

Answer their latest question naturally — it may be a follow-up, a clarification, or a new term.
Be crisp and beginner-friendly (2-4 sentences). Never use bullet points.

Also suggest 2 related tech terms they might want to learn next as a JSON array at the end:
---SUGGESTIONS
["term1", "term2"]`;
    } else if (page_context && page_context.trim().length > 10) {
      prompt = `You are a helpful tech educator. Define this tech term in exactly 2-3 sentences, relating it to the context where it appears.

Term: "${cleanTerm}"
Page Title: ${page_title || 'Unknown'}
Page Context: ${page_context.slice(0, 1000)}

Explain what this term means in plain language and how it relates to the current topic. Never use bullet points. Always write in plain sentences.

Also suggest 2 related tech terms they might want to learn next as a JSON array at the end:
---SUGGESTIONS
["term1", "term2"]`;
    } else {
      prompt = `You are a helpful tech educator. Define this tech term in exactly 2-3 sentences. Be crisp, precise, and beginner-friendly. Never use bullet points. Always write in plain sentences. Term: "${cleanTerm}"

Also suggest 2 related tech terms they might want to learn next as a JSON array at the end:
---SUGGESTIONS
["term1", "term2"]`;
    }
    definition = await callGemini(prompt);

    // Parse suggestions from the end of the response
    if (definition) {
      const suggestionsMatch = definition.match(/---SUGGESTIONS\s*(\[[\s\S]*?\])\s*$/);
      if (suggestionsMatch) {
        try {
          suggestions = JSON.parse(suggestionsMatch[1]);
          definition = definition.replace(/---SUGGESTIONS\s*\[[\s\S]*?\]\s*$/, '').trim();
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[AI API Error]', err.message);
    const isAuthError = err.message.includes('API key not valid') || err.message.includes('403');
    if (isAuthError) return res.status(401).json({ error: 'Gemini API key is invalid.' });
    return res.status(500).json({ error: 'Gemini is currently unavailable. Try again.' });
  }

  // Step 4: Cache
  try {
    database.prepare('INSERT INTO cache (term, answer) VALUES (?, ?)').run(cleanTerm, definition);
  } catch (_) {}
  try {
    database.prepare('INSERT INTO search_log (user_id, query, found) VALUES (?, ?, 1)').run(getUserId(req), cleanTerm);
  } catch (_) {}

  return res.json({ term: cleanTerm, definition, source: 'ai', suggestions });
});

// ─────────────────────────────────────────────
// ENDPOINT 3: POST /api/bookmark
// ─────────────────────────────────────────────
router.post('/bookmark', (req, res) => {
  const { url, title, topic, notes, remind_at, remind_in_minutes, repeat_interval_days, max_repeats } = req.body;
  const user_id = getUserId(req);

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required.' });
  }
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    return res.status(400).json({ error: 'Topic label is required.' });
  }

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  // Calculate remind_at if remind_at or remind_in_minutes is provided
  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    remindAt = new Date(Date.now() + parseInt(remind_in_minutes) * 60000).toISOString();
  }

  const database = getDb();

  try {
    const info = database.prepare(`
      INSERT INTO bookmarks (url, title, topic, notes, remind_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sanitize(url, 2000),
      sanitize(title || url, 500),
      sanitize(topic, 200),
      sanitize(notes || '', 1000),
      remindAt,
      user_id
    );

    const bookmark = database.prepare('SELECT * FROM bookmarks WHERE id = ?').get(info.lastInsertRowid);

    // If a reminder was set, also create a reminder entry
    if (remindAt && bookmark) {
      try {
        createReminder(database, user_id, {
          reminder_type: 'bookmark_review',
          reference_type: 'bookmark',
          reference_id: bookmark.id,
          title: `Review: ${sanitize(topic, 100)}`,
          message: `Time to review your bookmark about ${sanitize(topic, 100)}`,
          remind_at: remindAt,
          repeat_interval_days,
          max_repeats,
        });
      } catch (_) {}
    }

    return res.json({ success: true, bookmark });
  } catch (err) {
    console.error('[Bookmark Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to save bookmark.' });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT 4: GET /api/bookmarks
// ─────────────────────────────────────────────
router.get('/bookmarks', (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const sort = req.query.sort || 'newest';
  const topic = req.query.topic || null;

  const database = getDb();

  try {
    let whereClause = 'WHERE user_id = ?';
    const params = [user_id];

    if (topic) {
      whereClause += ' AND LOWER(topic) LIKE LOWER(?)';
      params.push(`%${topic}%`);
    }

    let orderClause;
    switch (sort) {
      case 'oldest':       orderClause = 'ORDER BY created_at ASC';  break;
      case 'alphabetical': orderClause = 'ORDER BY title ASC';       break;
      case 'topic':        orderClause = 'ORDER BY topic ASC';       break;
      default:             orderClause = 'ORDER BY created_at DESC';
    }

    const total = database.prepare(`SELECT COUNT(*) as count FROM bookmarks ${whereClause}`).get(...params).count;
    const bookmarks = database.prepare(`SELECT * FROM bookmarks ${whereClause} ${orderClause} LIMIT ? OFFSET ?`).all(...params, limit, offset);

    const uniqueTopics = database.prepare('SELECT COUNT(DISTINCT LOWER(topic)) as count FROM bookmarks WHERE user_id = ?').get(user_id).count;

    return res.json({
      bookmarks: bookmarks || [],
      total,
      stats: { total_bookmarks: total, unique_topics: uniqueTopics },
    });
  } catch (err) {
    console.error('[Get Bookmarks Error]', err.message);
    return res.status(500).json({ error: 'Failed to load bookmarks.' });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT 5: GET /api/search
// ─────────────────────────────────────────────
router.get('/search', (req, res) => {
  const query = req.query.q;
  const user_id = getUserId(req);

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  const cleanQuery = sanitize(query, 200);
  const database = getDb();
  const pattern = `%${cleanQuery}%`;

  try {
    const results = database.prepare(`
      SELECT * FROM bookmarks
      WHERE user_id = ?
        AND (LOWER(topic) LIKE LOWER(?) OR LOWER(title) LIKE LOWER(?) OR LOWER(url) LIKE LOWER(?) OR LOWER(notes) LIKE LOWER(?))
      ORDER BY created_at DESC
      LIMIT 50
    `).all(user_id, pattern, pattern, pattern, pattern);

    // Also search notes for the same query
    const noteResults = database.prepare(`
      SELECT * FROM notes
      WHERE user_id = ?
        AND (LOWER(content) LIKE LOWER(?) OR LOWER(source_title) LIKE LOWER(?) OR LOWER(source_url) LIKE LOWER(?))
      ORDER BY created_at DESC
      LIMIT 20
    `).all(user_id, pattern, pattern, pattern);

    try {
      database.prepare('INSERT INTO search_log (user_id, query, found) VALUES (?, ?, ?)').run(user_id, cleanQuery, results.length > 0 || noteResults.length > 0 ? 1 : 0);
    } catch (_) {}

    return res.json({
      results: results || [],
      notes: noteResults || [],
      count: results?.length || 0,
      notes_count: noteResults?.length || 0,
      query: cleanQuery
    });
  } catch (err) {
    console.error('[Search Error]', err.message);
    return res.status(500).json({ error: 'Search failed.' });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT 6: DELETE /api/bookmark/:id
// ─────────────────────────────────────────────
router.delete('/bookmark/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!id) return res.status(400).json({ error: 'Bookmark ID is required.' });

  const database = getDb();

  try {
    database.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(id, user_id);
    database.prepare("DELETE FROM reminders WHERE reference_type = 'bookmark' AND reference_id = ?").run(id);
    return res.json({ success: true, message: 'Bookmark deleted.' });
  } catch (err) {
    console.error('[Delete Bookmark Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete bookmark.' });
  }
});

// ═════════════════════════════════════════════
// NOTES ENDPOINTS (Problem #4 — Ephemeral Thoughts)
// ═════════════════════════════════════════════

// POST /api/notes — Create a quick note
router.post('/notes', (req, res) => {
  const { content, source_url, source_title, remind_at, remind_in_minutes, reminder_note, repeat_interval_days, max_repeats } = req.body;
  const user_id = getUserId(req);

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Note content is required.' });
  }

  const cleanContent = sanitize(content, 2000);
  if (cleanContent.length < 1) {
    return res.status(400).json({ error: 'Note is too short.' });
  }

  // Calculate remind_at
  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    remindAt = new Date(Date.now() + parseInt(remind_in_minutes) * 60000).toISOString();
  }

  const database = getDb();

  try {
    const info = database.prepare(`
      INSERT INTO notes (content, source_url, source_title, remind_at, reminder_note, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      cleanContent,
      sanitize(source_url || '', 2000),
      sanitize(source_title || '', 500),
      remindAt,
      sanitize(reminder_note || '', 500),
      user_id
    );

    const note = database.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);

    // If a reminder was set, create a reminder entry
    if (remindAt && note) {
      try {
        createReminder(database, user_id, {
          reminder_type: 'note_action',
          reference_type: 'note',
          reference_id: note.id,
          title: '📝 ' + (sanitize(reminder_note || cleanContent, 100)),
          message: cleanContent.slice(0, 200),
          remind_at: remindAt,
          repeat_interval_days,
          max_repeats,
        });
      } catch (_) {}
    }

    return res.json({ success: true, note });
  } catch (err) {
    console.error('[Note Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to save note.' });
  }
});

// GET /api/notes — List notes
router.get('/notes', (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const showCompleted = req.query.completed === 'true';

  const database = getDb();

  try {
    let whereClause = 'WHERE user_id = ?';
    const params = [user_id];

    if (!showCompleted) {
      whereClause += ' AND completed = 0';
    }

    const total = database.prepare(`SELECT COUNT(*) as count FROM notes ${whereClause}`).get(...params).count;
    const notes = database.prepare(`SELECT * FROM notes ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return res.json({ notes: notes || [], total });
  } catch (err) {
    console.error('[Get Notes Error]', err.message);
    return res.status(500).json({ error: 'Failed to load notes.' });
  }
});

// PATCH /api/notes/:id/toggle — Toggle note completed status
router.patch('/notes/:id/toggle', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!id) return res.status(400).json({ error: 'Note ID is required.' });

  const database = getDb();

  try {
    const note = database.prepare('SELECT completed FROM notes WHERE id = ? AND user_id = ?').get(id, user_id);
    if (!note) return res.status(404).json({ error: 'Note not found.' });

    const newCompleted = note.completed ? 0 : 1;
    database.prepare('UPDATE notes SET completed = ? WHERE id = ? AND user_id = ?').run(newCompleted, id, user_id);

    return res.json({ success: true, completed: !!newCompleted });
  } catch (err) {
    console.error('[Toggle Note Error]', err.message);
    return res.status(500).json({ error: 'Failed to update note.' });
  }
});

// DELETE /api/notes/:id
router.delete('/notes/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  const database = getDb();

  try {
    database.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(id, user_id);
    database.prepare("DELETE FROM reminders WHERE reference_type = 'note' AND reference_id = ?").run(id);
    return res.json({ success: true, message: 'Note deleted.' });
  } catch (err) {
    console.error('[Delete Note Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete note.' });
  }
});

// ═════════════════════════════════════════════
// REMINDERS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/reminders — Schedule a reminder
router.post('/reminders', (req, res) => {
  const { title, message, remind_at, remind_in_minutes, reminder_type, reference_type, reference_id, repeat_interval_days, max_repeats } = req.body;
  const user_id = getUserId(req);

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Reminder title is required.' });
  }

  // Calculate remind_at
  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    remindAt = new Date(Date.now() + parseInt(remind_in_minutes) * 60000).toISOString();
  }

  if (!remindAt) {
    return res.status(400).json({ error: 'Either remind_at or remind_in_minutes is required.' });
  }

  const database = getDb();

  try {
    const info = createReminder(database, user_id, {
      title,
      message,
      remind_at: remindAt,
      reminder_type,
      reference_type,
      reference_id,
      repeat_interval_days,
      max_repeats,
    });

    const reminder = database.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
    return res.json({ success: true, reminder });
  } catch (err) {
    console.error('[Reminder Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to create reminder.' });
  }
});

// GET /api/reminders — Get due/pending reminders
router.get('/reminders', (req, res) => {
  const user_id = getUserId(req);
  const due = req.query.due === 'true';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const database = getDb();

  try {
    let query, params;

    if (due) {
      query = `SELECT * FROM reminders WHERE user_id = ? AND remind_at <= ? AND reminded = 0 AND dismissed = 0 LIMIT ?`;
      params = [user_id, new Date().toISOString(), limit];
    } else {
      query = `SELECT * FROM reminders WHERE user_id = ? AND dismissed = 0 ORDER BY remind_at ASC LIMIT ?`;
      params = [user_id, limit];
    }

    const reminders = database.prepare(query).all(...params);
    return res.json({ reminders: reminders || [], total: reminders.length });
  } catch (err) {
    console.error('[Get Reminders Error]', err.message);
    return res.status(500).json({ error: 'Failed to load reminders.' });
  }
});

// PATCH /api/reminders/:id — Acknowledge/dismiss a reminder
router.patch('/reminders/:id', (req, res) => {
  const { id } = req.params;
  const { reminded, dismissed } = req.body;
  const user_id = getUserId(req);

  if (!id) return res.status(400).json({ error: 'Reminder ID is required.' });

  const database = getDb();

  try {
    const sets = [];
    const params = [];
    if (reminded !== undefined) { sets.push('reminded = ?'); params.push(reminded ? 1 : 0); }
    if (dismissed !== undefined) { sets.push('dismissed = ?'); params.push(dismissed ? 1 : 0); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    database.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params, id, user_id);

    return res.json({ success: true });
  } catch (err) {
    console.error('[Update Reminder Error]', err.message);
    return res.status(500).json({ error: 'Failed to update reminder.' });
  }
});

// DELETE /api/reminders/:id
router.delete('/reminders/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  const database = getDb();

  try {
    database.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(id, user_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete reminder.' });
  }
});

// ═════════════════════════════════════════════
// RESEARCH ENDPOINTS (Problem #2 — Research Later)
// ═════════════════════════════════════════════

// POST /api/research — Queue a deep research
router.post('/research', async (req, res) => {
  const { url, title, user_notes, auto_process } = req.body;
  const user_id = getUserId(req);

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required.' });
  }

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const database = getDb();

  try {
    const info = database.prepare(`
      INSERT INTO research_queue (url, title, user_notes, status, user_id)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(
      sanitize(url, 2000),
      sanitize(title || url, 500),
      sanitize(user_notes || '', 1000),
      user_id
    );

    const research = database.prepare('SELECT * FROM research_queue WHERE id = ?').get(info.lastInsertRowid);

    // Auto-process if requested (fetch page content and run AI analysis)
    if (auto_process !== false) {
      // Fire and forget
      processResearch(research.id, url, title, user_notes, user_id, database).catch(err => {
        console.warn('[Research Process Error]', err.message);
      });
    }

    return res.json({ success: true, research });
  } catch (err) {
    console.error('[Research Queue Error]', err.message);
    return res.status(500).json({ error: 'Failed to queue research.' });
  }
});

/**
 * Process a research queue item: fetch page, run AI analysis, store result.
 */
async function processResearch(id, url, title, userNotes, userId, database) {
  try {
    // Mark as processing
    database.prepare("UPDATE research_queue SET status = 'processing' WHERE id = ?").run(id);

    // Fetch page content
    let pageContent = '';
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; easy-rewind/1.0)' },
      });
      pageContent = response.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    } catch (fetchErr) {
      pageContent = `[Could not fetch page: ${fetchErr.message}]`;
    }

    // Generate AI research
    const ai = getGenAI();
    if (!ai) {
      database.prepare("UPDATE research_queue SET status = 'failed', error_message = 'AI not configured' WHERE id = ?").run(id);
      return;
    }

    const prompt = `You are a research assistant. Given the following content from a webpage, provide a comprehensive but concise analysis:

Page Title: ${title || 'Unknown'}
Page URL: ${url}
User's Notes: ${userNotes || 'N/A'}

Page Content (first 8000 chars):
${pageContent}

Please provide:
1. **Summary** — 2-3 sentence overview
2. **Key Takeaways** — 3-5 bullet points of the most important insights
3. **Why It Matters** — the significance/impact
4. **Related Topics** — 3-5 related concepts the user might want to explore
5. **Action Items** — things the user might want to do after reading this

Format using plain text with markdown headers.`;

    const analysis = await callGemini(prompt);

    // Save result
    database.prepare(`
      UPDATE research_queue SET status = 'done', research_result = ?, completed_at = (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')
      WHERE id = ?
    `).run(analysis, id);

    // Create a reminder that research is done — fire in 5 minutes so user isn't flooded instantly
    database.prepare(`
      INSERT INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at)
      VALUES (?, 'research_done', 'research', ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now', '+5 minutes') || 'Z'))
    `).run(
      userId,
      id,
      `📖 Research ready: ${sanitize(title || 'Untitled', 100)}`,
      'Your AI deep research has been completed.'
    );

    console.log(`[Research] Completed for ID ${id}: "${title}"`);
  } catch (err) {
    console.error('[Research Process Error]', err.message);
    try {
      database.prepare("UPDATE research_queue SET status = 'failed', error_message = ? WHERE id = ?").run(err.message, id);
    } catch (_) {}
  }
}

// GET /api/research — Get research results
router.get('/research', (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const database = getDb();

  try {
    const total = database.prepare('SELECT COUNT(*) as count FROM research_queue WHERE user_id = ?').get(user_id).count;
    const research = database.prepare('SELECT * FROM research_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(user_id, limit, offset);

    return res.json({ research: research || [], total });
  } catch (err) {
    console.error('[Get Research Error]', err.message);
    return res.status(500).json({ error: 'Failed to load research.' });
  }
});

// ═════════════════════════════════════════════
// PUSH SUBSCRIPTION ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/push-subscribe — Register a device for push notifications
router.post('/push-subscribe', (req, res) => {
  const { platform, subscription_json, device_name } = req.body;
  const user_id = getUserId(req);

  if (!platform || !subscription_json) {
    return res.status(400).json({ error: 'Platform and subscription_json are required.' });
  }

  const database = getDb();

  try {
    const info = database.prepare(`
      INSERT INTO push_subscriptions (platform, subscription_json, device_name, last_active, user_id)
      VALUES (?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'), ?)
    `).run(
      sanitize(platform, 20),
      typeof subscription_json === 'string' ? subscription_json : JSON.stringify(subscription_json),
      sanitize(device_name || '', 100),
      user_id
    );

    const subscription = database.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(info.lastInsertRowid);
    return res.json({ success: true, subscription });
  } catch (err) {
    console.error('[Push Subscribe Error]', err.message);
    return res.status(500).json({ error: 'Failed to register device.' });
  }
});

// DELETE /api/push-subscribe/:id — Unsubscribe
router.delete('/push-subscribe/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  const database = getDb();

  try {
    database.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, user_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to unsubscribe.' });
  }
});

// ═════════════════════════════════════════════
// INTERNAL: Check and process due reminders
// ═════════════════════════════════════════════

// POST /api/check-reminders — Called periodically by desktop app or extension
router.post('/check-reminders', (req, res) => {
  const database = getDb();

  try {
    const now = new Date().toISOString();

    // Find all due reminders
    const dueReminders = database.prepare(`
      SELECT * FROM reminders
      WHERE remind_at <= ?
        AND reminded = 0
        AND dismissed = 0
      LIMIT 50
    `).all(now);

    if (!dueReminders || dueReminders.length === 0) {
      return res.json({ processed: 0 });
    }

    const ids = dueReminders.map(r => r.id);

    // Mark them as reminded
    const updateStmt = database.prepare('UPDATE reminders SET reminded = 1 WHERE id = ?');
    const markReminded = database.transaction((ids) => {
      for (const id of ids) {
        updateStmt.run(id);
      }
    });
    markReminded(ids);

    // Group by user and log push notifications; schedule next spaced review if configured
    const byUser = {};
    for (const reminder of dueReminders) {
      if (!byUser[reminder.user_id]) byUser[reminder.user_id] = [];
      byUser[reminder.user_id].push(reminder);
      scheduleNextReview(database, reminder);
    }

    for (const [userId, reminders] of Object.entries(byUser)) {
      for (const reminder of reminders) {
        sendPushNotification(userId, reminder.title, reminder.message || 'You have a pending reminder.', {
          reminderId: reminder.id,
          type: reminder.reminder_type,
        });
      }
    }

    return res.json({ processed: dueReminders.length });
  } catch (err) {
    console.error('[Check Reminders Error]', err.message);
    return res.status(500).json({ error: 'Failed to check reminders.' });
  }
});

// ═════════════════════════════════════════════
// PAGE SUMMARY ENDPOINT
// ═════════════════════════════════════════════

// POST /api/page-summary — Generate an AI summary of the current page
router.post('/page-summary', async (req, res) => {
  const { url, title, description, text_content } = req.body;
  const textPieces = [
    title && typeof title === 'string' ? `Title: ${title}` : '',
    description && typeof description === 'string' ? `Description: ${description}` : '',
    text_content && typeof text_content === 'string' ? text_content : '',
  ].filter(Boolean).join('\n\n');

  if (!textPieces || textPieces.trim().length < 20) {
    return res.status(400).json({ error: 'Not enough page content to summarize. Try a longer article or reload the page.' });
  }

  // Check AI availability
  if (!getGenAI()) {
    return res.json({
      summary: `**${title || 'Page'}**\n\nTo enable remote AI summaries, add your GEMINI_API_KEY to the backend .env file or configure it in the extension settings.`,
      source: 'stub',
      title: title || 'Page Summary',
      url: url || '',
    });
  }

  try {
    const prompt = `You are a reading assistant. Summarize the following webpage content in 3-4 clear paragraphs.

Page Title: ${title || 'Unknown'}
Page URL: ${url || 'Unknown'}
Meta Description: ${description || 'N/A'}

Page Content:
${textPieces.slice(0, 12000)}

Provide:
1. **Brief Summary** — 2-3 sentences capturing the core topic
2. **Key Points** — 3-5 bullet points of the most important takeaways
3. **Who Is This For** — one sentence on the target audience

Use plain markdown formatting, no extra commentary.`;

    const summary = await callGemini(prompt);

    return res.json({
      summary,
      title: title || 'Page Summary',
      url: url || '',
      source: 'ai',
    });
  } catch (err) {
    console.error('[Page Summary Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate summary.' });
  }
});

// ═════════════════════════════════════════════
// HIGHLIGHTS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/highlights — Save a highlight
router.post('/highlights', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const { url, page_title, text, context, color, tags, note } = req.body;
    if (!url || !text) return res.status(400).json({ error: 'url and text are required' });

    const cleanText = sanitize(text, 2000);
    const existing = database.prepare('SELECT id FROM highlights WHERE user_id = ? AND url = ? AND text = ?').get(uid, url, cleanText);
    if (existing) {
      return res.json({ highlight: existing, duplicate: true });
    }

    const stmt = database.prepare(
      `INSERT INTO highlights (user_id, url, page_title, text, context, color, tags, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      uid,
      sanitize(url, 2048),
      sanitize(page_title || '', 500),
      cleanText,
      sanitize(context || '', 3000),
      color || 'yellow',
      sanitize(tags || '', 500),
      sanitize(note || '', 1000)
    );

    const highlight = database.prepare('SELECT * FROM highlights WHERE id = ?').get(result.lastInsertRowid);
    return res.json({ highlight });
  } catch (err) {
    console.error('[Highlights Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to save highlight.', detail: err.message });
  }
});

// GET /api/highlights — List highlights (optional ?url= filter)
router.get('/highlights', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const url = req.query.url;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;

    let where = 'WHERE user_id = ?';
    const params = [uid];

    if (url) {
      where += ' AND url = ?';
      params.push(sanitize(url, 2048));
    }

    const total = database.prepare(`SELECT COUNT(*) as count FROM highlights ${where}`).get(...params).count;
    const highlights = database.prepare(
      `SELECT * FROM highlights ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return res.json({ highlights, total, page, limit });
  } catch (err) {
    console.error('[Highlights List Error]', err.message);
    return res.status(500).json({ error: 'Failed to load highlights.' });
  }
});

// GET /api/highlights/stats — Get highlight count per page
router.get('/highlights/stats', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const total = database.prepare('SELECT COUNT(*) as count FROM highlights WHERE user_id = ?').get(uid).count;
    const perPage = database.prepare(
      `SELECT url, page_title, COUNT(*) as count FROM highlights WHERE user_id = ? GROUP BY url ORDER BY count DESC LIMIT 10`
    ).all(uid);
    const colors = database.prepare(
      `SELECT color, COUNT(*) as count FROM highlights WHERE user_id = ? GROUP BY color ORDER BY count DESC`
    ).all(uid);
    return res.json({ total, perPage, colors });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// DELETE /api/highlights/:id — Delete a highlight
router.delete('/highlights/:id', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid highlight ID' });

    const result = database.prepare('DELETE FROM highlights WHERE id = ? AND user_id = ?').run(id, uid);
    if (result.changes === 0) return res.status(404).json({ error: 'Highlight not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Highlights Delete Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete highlight.' });
  }
});

router.get('/review-digest', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const recentLimit = Math.min(parseInt(req.query.limit) || 20, 50);

    const bookmarks = database.prepare(`
      SELECT id, url, title, topic, notes, created_at
      FROM bookmarks
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(uid, since, recentLimit);
    const notes = database.prepare(`
      SELECT id, content, source_url, source_title, created_at
      FROM notes
      WHERE user_id = ? AND created_at >= ? AND completed = 0
      ORDER BY created_at DESC LIMIT ?
    `).all(uid, since, recentLimit);
    const highlights = database.prepare(`
      SELECT id, url, page_title, text, color, created_at
      FROM highlights
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(uid, since, recentLimit);
    const dueReminders = database.prepare(`
      SELECT id, reminder_type, reference_type, title, message, remind_at
      FROM reminders
      WHERE user_id = ? AND reminded = 0 AND dismissed = 0 AND remind_at <= ?
      ORDER BY remind_at ASC LIMIT ?
    `).all(uid, new Date().toISOString(), recentLimit);

    const reviewItems = [
      ...bookmarks.map(item => ({ type: 'bookmark', title: item.title || item.topic, detail: item.topic, url: item.url, created_at: item.created_at })),
      ...notes.map(item => ({ type: 'note', title: item.source_title || 'Note', detail: item.content.slice(0, 160), url: item.source_url || '', created_at: item.created_at })),
      ...highlights.map(item => ({ type: 'highlight', title: item.page_title || 'Highlight', detail: item.text.slice(0, 160), url: item.url, color: item.color, created_at: item.created_at })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, recentLimit);

    return res.json({
      days,
      generated_at: new Date().toISOString(),
      stats: {
        bookmarks: bookmarks.length,
        notes: notes.length,
        highlights: highlights.length,
        due_reminders: dueReminders.length,
      },
      due_reminders: dueReminders,
      review_items: reviewItems,
    });
  } catch (err) {
    console.error('[Review Digest Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate review digest.' });
  }
});

// ═════════════════════════════════════════════
// EXPORT / IMPORT ENDPOINTS
// ═════════════════════════════════════════════

// GET /api/export — Export all user data as JSON
router.get('/export', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);

    const bookmarks = database.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    const notes = database.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    const highlights = database.prepare('SELECT * FROM highlights WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    const research = database.prepare('SELECT * FROM research_queue WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    const reminders = database.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY created_at DESC').all(uid);

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: uid,
      version: '2.0.0',
      stats: {
        bookmarks: bookmarks.length,
        notes: notes.length,
        highlights: highlights.length,
        research: research.length,
        reminders: reminders.length,
        total: bookmarks.length + notes.length + highlights.length + research.length + reminders.length,
      },
      data: { bookmarks, notes, highlights, research, reminders },
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="easy-rewind-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(exportData);
  } catch (err) {
    console.error('[Export Error]', err.message);
    return res.status(500).json({ error: 'Export failed.' });
  }
});

// POST /api/import — Import data from JSON export
router.post('/import', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid import data. Expected { data: { bookmarks, notes, highlights, ... } }' });
    }

    const imported = { bookmarks: 0, notes: 0, highlights: 0, research: 0, reminders: 0 };

    const insertBookmark = database.prepare(
      `INSERT OR IGNORE INTO bookmarks (user_id, url, title, topic, notes, remind_at, reminded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const b of (data.bookmarks || [])) {
      insertBookmark.run(uid, b.url, b.title, b.topic, b.notes || '', b.remind_at || null, b.reminded || 0, b.created_at);
      imported.bookmarks++;
    }

    const insertNote = database.prepare(
      `INSERT OR IGNORE INTO notes (user_id, content, source_url, source_title, remind_at, reminded, completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const n of (data.notes || [])) {
      insertNote.run(uid, n.content, n.source_url || null, n.source_title || null, n.remind_at || null, n.reminded || 0, n.completed || 0, n.created_at);
      imported.notes++;
    }

    const insertHighlight = database.prepare(
      `INSERT OR IGNORE INTO highlights (user_id, url, page_title, text, context, color, tags, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const h of (data.highlights || [])) {
      insertHighlight.run(uid, h.url, h.page_title || '', h.text, h.context || null, h.color || 'yellow', h.tags || '', h.note || '', h.created_at);
      imported.highlights++;
    }

    const insertResearch = database.prepare(
      `INSERT OR IGNORE INTO research_queue (user_id, url, title, user_notes, research_result, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of (data.research || [])) {
      insertResearch.run(uid, r.url, r.title || '', r.user_notes || null, r.research_result || null, r.status || 'pending', r.created_at);
      imported.research++;
    }

    const insertReminder = database.prepare(
      `INSERT OR IGNORE INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of (data.reminders || [])) {
      insertReminder.run(uid, 'imported', r.reference_type || null, r.reference_id || null, r.title, r.message || null, r.remind_at, r.created_at);
      imported.reminders++;
    }

    return res.json({ success: true, imported });
  } catch (err) {
    console.error('[Import Error]', err.message);
    return res.status(500).json({ error: 'Import failed.' });
  }
});

// ═════════════════════════════════════════════
// SETTINGS ENDPOINT
// ═════════════════════════════════════════════

// GET /api/settings — Retrieve current runtime settings
router.get('/settings', (req, res) => {
  return res.json({
    ai_configured: !!getGenAI(),
    model: runtimeModel,
    api_base_url: runtimeApiBaseUrl,
    summarization_backend: runtimeSummarizationBackend,
    spaced_review_enabled: runtimeSpacedReviewEnabled,
    review_interval_days: runtimeReviewIntervalDays,
    embed_provider: runtimeEmbedProvider,
    has_runtime_key: !!runtimeApiKey,
    has_env_key: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here',
    settings_file_exists: fs.existsSync(SETTINGS_PATH),
  });
});

// POST /api/settings — Update runtime settings — persists to disk
router.post('/settings', (req, res) => {
  const { gemini_api_key, ai_model, api_base_url, summarization_backend, spaced_review_enabled, review_interval_days, embed_provider } = req.body;

  if (gemini_api_key !== undefined) {
    runtimeApiKey = gemini_api_key || null;
    resetGenAI();
  }

  if (ai_model !== undefined) {
    runtimeModel = ai_model || 'gemini-2.5-flash';
  }

  if (api_base_url !== undefined) {
    runtimeApiBaseUrl = api_base_url.replace(/\/+$/, '') || 'http://localhost:5000';
  }

  if (summarization_backend !== undefined) {
    const allowed = ['auto', 'chrome', 'local', 'gemini', 'backend'];
    runtimeSummarizationBackend = allowed.includes(summarization_backend) ? summarization_backend : 'auto';
  }

  if (spaced_review_enabled !== undefined) {
    runtimeSpacedReviewEnabled = !!spaced_review_enabled;
  }

  if (review_interval_days !== undefined) {
    runtimeReviewIntervalDays = Math.max(1, parseInt(review_interval_days) || 3);
  }

  if (embed_provider !== undefined) {
    const allowed = ['auto', 'gemini', 'openai'];
    runtimeEmbedProvider = allowed.includes(embed_provider) ? embed_provider : 'auto';
  }

  // Persist to disk so it survives server restarts
  saveSettings();

  console.log('[Settings] Runtime config updated:', {
    ai_configured: !!runtimeApiKey || !!process.env.GEMINI_API_KEY,
    model: runtimeModel,
    summarization_backend: runtimeSummarizationBackend,
    spaced_review_enabled: runtimeSpacedReviewEnabled,
  });

  return res.json({
    success: true,
    ai_configured: !!getGenAI(),
    model: runtimeModel,
    api_base_url: runtimeApiBaseUrl,
    summarization_backend: runtimeSummarizationBackend,
    spaced_review_enabled: runtimeSpacedReviewEnabled,
    review_interval_days: runtimeReviewIntervalDays,
  });
});

// ═════════════════════════════════════════════
// NEW: SUMMARIZE ENDPOINT
// ═════════════════════════════════════════════

// POST /api/summarize — Generate an AI summary of provided text
router.post('/summarize', async (req, res) => {
  const { text, max_sentences, style } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide at least 10 characters of text to summarize.' });
  }

  const cleanText = sanitize(text, 12000);

  try {
    const result = await summarizeText(cleanText, { maxSentences: parseInt(max_sentences) || 3, style: style || 'concise' });

    if (!result.success) {
      console.error('[Summarize Error]', result.error);
      return res.status(502).json({ error: `Summarization failed: ${result.error}`, fallback: cleanText.slice(0, 500) });
    }

    return res.json({
      success: true,
      summary: result.summary,
      source: 'ai',
      model: runtimeModel,
      length: result.summary.length,
    });
  } catch (err) {
    console.error('[Summarize Critical Error]', err.message);
    return res.status(500).json({ error: 'Summarization service unavailable.', fallback: cleanText.slice(0, 500) });
  }
});

// ═════════════════════════════════════════════
// NEW: ITEMS ENDPOINTS (Unified Save + Sync)
// ═════════════════════════════════════════════

// POST /api/items — Save a new item with summary, embedding, tags
router.post('/items', async (req, res) => {
  const { url, title, content, skip_summary, skip_embedding, skip_tags } = req.body;
  const user_id = getUserId(req);

  if (!content && !url) {
    return res.status(400).json({ error: 'Provide at least content or a URL to save.' });
  }

  const cleanContent = sanitize(content || '', 50000);
  const cleanTitle = sanitize(title || url || 'Untitled', 500);
  const cleanUrl = sanitize(url || '', 2000);

  const database = getDb();

  try {
    // Step 1: Insert the item
    const info = database.prepare(`
      INSERT INTO items (user_id, url, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'), (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    `).run(user_id, cleanUrl, cleanTitle, cleanContent);
    const itemId = info.lastInsertRowid;

    // Step 2: Generate summary (parallel with embedding)
    let summary = '';
    let tags = [];
    let embedding = null;

    const summaryPromise = skip_summary
      ? Promise.resolve('')
      : summarizeText(cleanContent || cleanTitle)
          .then(r => { summary = r.success ? r.summary : ''; })
          .catch(err => { console.warn('[Items] Summary failed:', err.message); });

    const embeddingPromise = skip_embedding
      ? Promise.resolve()
      : generateEmbedding(cleanContent || cleanTitle)
          .then(vec => { embedding = vec; })
          .catch(err => { console.warn('[Items] Embedding failed:', err.message); });

    await Promise.all([summaryPromise, embeddingPromise]);

    // Step 3: Update item with summary
    database.prepare('UPDATE items SET summary = ?, updated_at = (strftime(\'%Y-%m-%dT%H:%M:%S\', \'now\') || \'Z\') WHERE id = ?')
      .run(summary || '', itemId);

    // Step 4: Store embedding if generated
    if (embedding && Array.isArray(embedding)) {
      try {
        database.prepare(`
          INSERT OR REPLACE INTO item_embeddings (item_id, embedding, model)
          VALUES (?, ?, ?)
        `).run(itemId, JSON.stringify(embedding), runtimeApiKey?.startsWith('sk-') ? 'openai' : 'gemini');
      } catch (embedErr) {
        console.warn('[Items] Embedding storage failed:', embedErr.message);
      }
    }

    // Step 5: Auto-tag if not skipped
    if (!skip_tags) {
      try {
        const tagResult = await generateTags((summary || cleanContent || cleanTitle));
        if (tagResult.success && tagResult.tags.length > 0) {
          tags = tagResult.tags;
          storeItemTags(database, itemId, tags, user_id);
        }
      } catch (tagErr) {
        console.warn('[Items] Auto-tagging failed:', tagErr.message);
      }
    }

    // Return the created item
    const item = database.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    return res.json({
      success: true,
      item,
      tags,
      has_summary: !!summary,
      has_embedding: !!embedding,
    });
  } catch (err) {
    console.error('[Items Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to save item.' });
  }
});

// GET /api/items — List items with optional ?since= param for sync
router.get('/items', (req, res) => {
  const user_id = getUserId(req);
  const since = req.query.since || null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const database = getDb();

  try {
    let query, params;
    if (since) {
      // Sync: return items updated since the given timestamp
      const sinceDate = normalizeDate(since);
      if (!sinceDate) return res.status(400).json({ error: 'Invalid since timestamp. Use ISO 8601 format.' });
      query = `SELECT * FROM items WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ? OFFSET ?`;
      params = [user_id, sinceDate, limit, offset];
    } else {
      query = `SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params = [user_id, limit, offset];
    }

    const items = database.prepare(query).all(...params);
    const total = database.prepare('SELECT COUNT(*) as count FROM items WHERE user_id = ?').get(user_id).count;

    // Normalize timestamps for client consumption (ensure 'Z' suffix)
    for (const item of items) {
      if (item.created_at && !item.created_at.endsWith('Z')) item.created_at += 'Z';
      if (item.updated_at && !item.updated_at.endsWith('Z')) item.updated_at += 'Z';
    }

    return res.json({ items: items || [], total, since: since || null });
  } catch (err) {
    console.error('[Items List Error]', err.message);
    return res.status(500).json({ error: 'Failed to load items.' });
  }
});

// DELETE /api/items/:id — Delete an item and its embeddings/tags
router.delete('/items/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();

  try {
    const item = database.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(id, user_id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    database.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(id, user_id);
    // CASCADE deletes remove embeddings and tags
    return res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    console.error('[Items Delete Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete item.' });
  }
});

// ═════════════════════════════════════════════
// NEW: ITEM INTERACTION (Memory Score)
// ═════════════════════════════════════════════

// PATCH /api/items/:id/interact — Record interaction, bumps memory_score
router.patch('/items/:id/interact', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const action = req.body.action || 'view'; // view, click, search, review
  const database = getDb();

  try {
    const item = database.prepare('SELECT id, memory_score, interaction_count FROM items WHERE id = ? AND user_id = ?').get(id, user_id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    // Score increments by action type
    const actionPoints = {
      view:    0.2,
      click:   0.5,
      search:  1.0,
      review:  2.0,
      link:    0.3,
    };
    const increment = actionPoints[action] || 0.2;
    const newScore = Math.min((item.memory_score || 0) + increment, 100);
    const newCount = (item.interaction_count || 0) + 1;
    const now = new Date().toISOString();

    database.prepare(`
      UPDATE items
      SET memory_score = ?, interaction_count = ?, last_interacted_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(newScore, newCount, now, now, id, user_id);

    return res.json({
      success: true,
      item_id: parseInt(id),
      memory_score: newScore,
      interaction_count: newCount,
      action,
    });
  } catch (err) {
    console.error('[Interact Error]', err.message);
    return res.status(500).json({ error: 'Failed to record interaction.' });
  }
});

// ═════════════════════════════════════════════
// NEW: VECTOR SEARCH ENDPOINT
// ═════════════════════════════════════════════

// GET /api/items/search — Hybrid search: semantic + recency + memory_score + frequency
router.get('/items/search', async (req, res) => {
  const query = req.query.q;
  const user_id = getUserId(req);

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  const cleanQuery = sanitize(query, 500);
  const database = getDb();

  try {
    // Step 1: Generate embedding for the query
    let queryEmbedding;
    try {
      queryEmbedding = await generateEmbedding(cleanQuery);
    } catch (embedErr) {
      console.warn('[Hybrid Search] Embedding failed, falling back to keyword:', embedErr.message);
    }

    // Helper: normalize recency (0..1, 1 = today, 0 = 365+ days ago)
    const daysToRecency = (days) => Math.max(0, Math.min(1, 1 - (days / 365)));
    const now = Date.now();

    // Helper: normalize memory_score (0..100 → 0..1)
    const normalizeScore = (s) => Math.min(1, (s || 0) / 50);

    // Helper: normalize interaction frequency (capped at 20)
    const normalizeFreq = (c) => Math.min(1, (c || 0) / 20);

    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

    // ── Phase A: Vector + hybrid scoring ──────────────────────
    let results = [];

    if (queryEmbedding && Array.isArray(queryEmbedding)) {
      const embeddings = database.prepare(`
        SELECT ie.item_id, ie.embedding, i.title, i.summary, i.content, i.tags, i.url,
               i.created_at, i.memory_score, i.interaction_count, i.last_interacted_at
        FROM item_embeddings ie
        JOIN items i ON i.id = ie.item_id
        WHERE i.user_id = ?
      `).all(user_id);

      const scored = [];
      for (const row of embeddings) {
        const storedVec = parseEmbedding(row.embedding);
        if (!storedVec) continue;

        const sim = cosineSimilarity(queryEmbedding, storedVec);
        if (sim < 0.05) continue; // Hard floor — unrelated items

        const ageMs = now - new Date(row.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(row.memory_score);
        const frequency = normalizeFreq(row.interaction_count);

        // 40% semantic + 30% recency + 20% memory_score + 10% frequency
        const hybridScore = (0.40 * sim) + (0.30 * recency) + (0.20 * memScore) + (0.10 * frequency);

        scored.push({
          id: row.item_id,
          title: row.title || '',
          summary: row.summary || '',
          content: row.content ? row.content.slice(0, 300) : '',
          tags: row.tags || '',
          url: row.url || '',
          similarity: Math.round(sim * 1000) / 1000,
          recency: Math.round(recency * 1000) / 1000,
          memory_score: row.memory_score || 0,
          interaction_count: row.interaction_count || 0,
          score: Math.round(hybridScore * 1000) / 1000,
          created_at: row.created_at,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      results = scored.slice(0, 15);
    }

    // ── Phase B: Keyword fallback (also scored) ───────────────
    if (results.length < 3) {
      const pattern = `%${cleanQuery}%`;
      const keywordResults = database.prepare(`
        SELECT id, title, summary, content, tags, url, created_at,
               memory_score, interaction_count, last_interacted_at,
               CASE
                 WHEN LOWER(title) LIKE LOWER(?) THEN 1.0
                 WHEN LOWER(summary) LIKE LOWER(?) THEN 0.8
                 WHEN LOWER(content) LIKE LOWER(?) THEN 0.5
                 WHEN LOWER(tags) LIKE LOWER(?) THEN 0.7
                 ELSE 0.3
               END as kw_score
        FROM items
        WHERE user_id = ?
          AND (LOWER(title) LIKE LOWER(?) OR LOWER(summary) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))
        ORDER BY kw_score DESC
        LIMIT 15
      `).all(pattern, pattern, pattern, pattern, user_id, pattern, pattern, pattern, pattern);

      // De-duplicate against vector results
      const existingIds = new Set(results.map(r => r.id));
      const seenIds = new Set();

      for (const r of keywordResults) {
        if (existingIds.has(r.id) || seenIds.has(r.id)) continue;
        seenIds.add(r.id);

        const ageMs = now - new Date(r.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(r.memory_score);
        const freq = normalizeFreq(r.interaction_count);

        const hybridScore = (0.40 * (r.kw_score || 0.3))
                          + (0.30 * recency)
                          + (0.20 * memScore)
                          + (0.10 * freq);

        results.push({
          id: r.id,
          title: r.title || '',
          summary: r.summary || '',
          content: r.content ? r.content.slice(0, 300) : '',
          tags: r.tags || '',
          url: r.url || '',
          similarity: 0,
          recency: Math.round(recency * 1000) / 1000,
          memory_score: r.memory_score || 0,
          interaction_count: r.interaction_count || 0,
          score: Math.round(hybridScore * 1000) / 1000,
          created_at: r.created_at,
        });
      }
    }

    // Sort final results by hybrid score
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, 15);

    return res.json({
      results,
      count: results.length,
      query: cleanQuery,
      hybrid: true,
    });
  } catch (err) {
    console.error('[Hybrid Search Error]', err.message);
    return res.status(500).json({ error: 'Search failed.' });
  }
});

// ═════════════════════════════════════════════
// NEW: RAG ASK ENDPOINT
// ═════════════════════════════════════════════

// GET /api/ask — Answer a question using RAG over saved items
router.get('/ask', async (req, res) => {
  const query = req.query.q;
  const user_id = getUserId(req);

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Please provide a question via ?q=...' });
  }

  const cleanQuery = sanitize(query, 1000);
  const database = getDb();

  try {
    // Step 1: Search for relevant items (reuse vector search if available)
    let searchResults = [];
    try {
      const searchParam = new URLSearchParams({ q: cleanQuery });
      // We embed the query and search locally
      const queryEmbedding = await generateEmbedding(cleanQuery).catch(() => null);

      if (queryEmbedding && Array.isArray(queryEmbedding)) {
        const embeddings = database.prepare(`
          SELECT ie.item_id, ie.embedding, i.title, i.summary, i.content, i.url
          FROM item_embeddings ie
          JOIN items i ON i.id = ie.item_id
          WHERE i.user_id = ?
        `).all(user_id);

        const scored = [];
        for (const row of embeddings) {
          const storedVec = parseEmbedding(row.embedding);
          if (!storedVec) continue;
          const score = cosineSimilarity(queryEmbedding, storedVec);
          if (score > 0.15) {
            scored.push({ ...row, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        searchResults = scored.slice(0, 5);
      }

      // Fallback keyword search if vector search found nothing
      if (searchResults.length === 0) {
        const pattern = `%${cleanQuery}%`;
        searchResults = database.prepare(`
          SELECT id as item_id, title, summary, content, url FROM items
          WHERE user_id = ?
            AND (LOWER(title) LIKE LOWER(?) OR LOWER(summary) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))
          ORDER BY created_at DESC
          LIMIT 5
        `).all(user_id, pattern, pattern, pattern, pattern);
      }
    } catch (searchErr) {
      console.warn('[Ask] Search phase failed:', searchErr.message);
    }

    // Step 2: Build RAG prompt
    let ragPrompt;
    if (searchResults.length === 0) {
      // No context found — answer from general knowledge
      ragPrompt = `You are a helpful knowledge assistant. The user has asked a question but there are no saved items matching it yet.

Question: "${cleanQuery}"

Answer the question based on your general knowledge. Keep your answer concise (2-4 sentences). If you're not confident about the answer, say so.`;
    } else {
      const context = searchResults.map((r, i) =>
        `[${i + 1}] Title: ${r.title || 'Untitled'}\nSummary: ${r.summary || 'N/A'}\nURL: ${r.url || 'N/A'}`
      ).join('\n\n');

      ragPrompt = `You are a helpful knowledge assistant. Answer the user's question based ONLY on the context from their saved items below. If the context doesn't contain enough information to answer fully, say so — don't make things up.

Context from saved items:
${context}

Question: "${cleanQuery}"

Answer concisely (2-4 sentences). If helpful, reference which saved item(s) the answer comes from.`;
    }

    // Step 3: Generate answer via LLM
    const ai = getGenAI();
    if (!ai) {
      return res.json({
        answer: searchResults.length > 0
          ? `Found ${searchResults.length} relevant saved items. Enable AI (GEMINI_API_KEY) for generative answers.`
          : 'AI not configured. Set GEMINI_API_KEY in .env for AI-powered answers.',
        sources: searchResults.map(r => ({ title: r.title, url: r.url })),
        source_count: searchResults.length,
      });
    }

    const answer = await callGemini(ragPrompt);

    return res.json({
      answer: answer || 'Could not generate an answer.',
      sources: searchResults.map(r => ({
        title: r.title || 'Untitled',
        url: r.url || '',
        summary: r.summary || '',
        score: r.score || null,
      })),
      source_count: searchResults.length,
      query: cleanQuery,
    });
  } catch (err) {
    console.error('[Ask RAG Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate answer.' });
  }
});

// ═════════════════════════════════════════════
// NEW: AUTO-TAGGING ENDPOINT
// ═════════════════════════════════════════════

// POST /api/tag — Generate tags for provided text
router.post('/tag', async (req, res) => {
  const { text, max_tags } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide text (at least 5 chars) to extract tags from.' });
  }

  const cleanText = sanitize(text, 5000);

  try {
    const result = await generateTags(cleanText, { maxTags: parseInt(max_tags) || 5 });

    if (!result.success) {
      return res.status(502).json({ error: `Tagging failed: ${result.error}` });
    }

    return res.json({
      success: true,
      tags: result.tags,
      count: result.tags.length,
    });
  } catch (err) {
    console.error('[Tag Error]', err.message);
    return res.status(500).json({ error: 'Tagging service unavailable.' });
  }
});

// ═════════════════════════════════════════════
// CLIENT-SIDE ERROR LOGGING
// ═════════════════════════════════════════════

// POST /api/log — Accept client-side error reports for server-side logging
router.post('/log', (req, res) => {
  const { level, component, message, stack, data } = req.body;
  const user_id = getUserId(req);
  const ts = new Date().toISOString();

  const prefix = `[${ts}] [${level || 'INFO'}] [${component || 'client'}] (${user_id.slice(0, 20)}...)`;
  const stackStr = stack ? `\nStack: ${stack.slice(0, 500)}` : '';
  const dataStr = data ? ` ${JSON.stringify(data).slice(0, 500)}` : '';

  switch (level) {
    case 'ERROR':
      console.error(`${prefix} ${message}${dataStr}${stackStr}`);
      break;
    case 'WARN':
      console.warn(`${prefix} ${message}${dataStr}`);
      break;
    default:
      console.log(`${prefix} ${message}${dataStr}`);
  }

  // Persist to database for later review
  try {
    const database = getDb();
    database.prepare(`
      INSERT INTO error_log (user_id, level, component, message, stack, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      user_id,
      (level || 'INFO').slice(0, 10),
      (component || 'client').slice(0, 50),
      (message || '').slice(0, 500),
      (stack || '').slice(0, 2000),
      data ? JSON.stringify(data).slice(0, 2000) : null
    );
  } catch (_) { /* Log persistence is best-effort */ }

  return res.json({ success: true });
});

// GET /api/logs — Retrieve recent error logs (for admin/dashboard)
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const level = req.query.level || null;
  try {
    const database = getDb();
    let query = 'SELECT * FROM error_log';
    const params = [];
    if (level) {
      query += ' WHERE level = ?';
      params.push(level.toUpperCase());
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const logs = database.prepare(query).all(...params);
    return res.json({ logs: logs || [], total: logs.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load logs.' });
  }
});

module.exports = router;
