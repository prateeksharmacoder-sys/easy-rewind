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

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// Load persisted settings from disk
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.apiKey) runtimeApiKey = saved.apiKey;
      if (saved.model) runtimeModel = saved.model;
      console.log(`[Settings] Loaded: model=${runtimeModel}, has_key=!!${!!runtimeApiKey}`);
    }
  } catch (err) {
    console.warn('[Settings] Could not load settings file:', err.message);
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
// ENDPOINT 1: GET /api/health
// ─────────────────────────────────────────────
router.get('/health', (req, res) => {
  const database = getDb();
  const dbOk = database && database.open;
  res.json({
    status: 'ok',
    service: 'easy-rewind Learning Assistant API',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    storage: 'sqlite',
    storage_ready: dbOk,
    ai_configured: !!getGenAI(),
  });
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
  const { url, title, topic, notes, remind_at, remind_in_minutes } = req.body;
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

  // Calculate remind_at if remind_in_minutes is provided
  let remindAt = remind_at || null;
  if (remind_in_minutes && !remindAt) {
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
        database.prepare(`
          INSERT INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at)
          VALUES (?, 'bookmark_review', 'bookmark', ?, ?, ?, ?)
        `).run(
          user_id,
          bookmark.id,
          `Review: ${sanitize(topic, 100)}`,
          `Time to review your bookmark about ${sanitize(topic, 100)}`,
          remindAt
        );
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
  const { content, source_url, source_title, remind_at, remind_in_minutes, reminder_note } = req.body;
  const user_id = getUserId(req);

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Note content is required.' });
  }

  const cleanContent = sanitize(content, 2000);
  if (cleanContent.length < 1) {
    return res.status(400).json({ error: 'Note is too short.' });
  }

  // Calculate remind_at
  let remindAt = remind_at || null;
  if (remind_in_minutes && !remindAt) {
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
        database.prepare(`
          INSERT INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at)
          VALUES (?, 'note_action', 'note', ?, ?, ?, ?)
        `).run(
          user_id,
          note.id,
          '📝 ' + (sanitize(reminder_note || cleanContent, 100)),
          cleanContent.slice(0, 200),
          remindAt
        );
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
  const { title, message, remind_at, remind_in_minutes, reminder_type, reference_type, reference_id } = req.body;
  const user_id = getUserId(req);

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Reminder title is required.' });
  }

  // Calculate remind_at
  let remindAt = remind_at || null;
  if (remind_in_minutes && !remindAt) {
    remindAt = new Date(Date.now() + parseInt(remind_in_minutes) * 60000).toISOString();
  }

  if (!remindAt) {
    return res.status(400).json({ error: 'Either remind_at or remind_in_minutes is required.' });
  }

  const database = getDb();

  try {
    const info = database.prepare(`
      INSERT INTO reminders (title, message, remind_at, reminder_type, reference_type, reference_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitize(title, 200),
      sanitize(message || '', 500),
      remindAt,
      sanitize(reminder_type || 'custom', 50),
      reference_type || null,
      reference_id || null,
      user_id
    );

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

    // Group by user and log push notifications
    const byUser = {};
    for (const reminder of dueReminders) {
      if (!byUser[reminder.user_id]) byUser[reminder.user_id] = [];
      byUser[reminder.user_id].push(reminder);
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

  if (!text_content || typeof text_content !== 'string' || text_content.trim().length < 20) {
    return res.status(400).json({ error: 'Not enough page content to summarize.' });
  }

  // Check AI availability
  if (!getGenAI()) {
    return res.json({
      summary: `**${title || 'Page'}**\n\nTo enable AI summaries, add your GEMINI_API_KEY to the backend .env file or configure it in the extension settings.`,
      source: 'stub',
    });
  }

  try {
    const prompt = `You are a reading assistant. Summarize the following webpage content in 3-4 clear paragraphs.

Page Title: ${title || 'Unknown'}
Page URL: ${url || 'Unknown'}
Meta Description: ${description || 'N/A'}

Page Content:
${text_content.slice(0, 6000)}

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
    has_runtime_key: !!runtimeApiKey,
    has_env_key: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here',
    settings_file_exists: fs.existsSync(SETTINGS_PATH),
  });
});

// POST /api/settings — Update runtime settings (API key, AI model) — persists to disk
router.post('/settings', (req, res) => {
  const { gemini_api_key, ai_model } = req.body;

  if (gemini_api_key !== undefined) {
    runtimeApiKey = gemini_api_key || null;
    resetGenAI();
  }

  if (ai_model !== undefined) {
    runtimeModel = ai_model || 'gemini-2.5-flash';
  }

  // Persist to disk so it survives server restarts
  saveSettings();

  console.log('[Settings] Runtime config updated:', {
    ai_configured: !!runtimeApiKey || !!process.env.GEMINI_API_KEY,
    model: runtimeModel,
  });

  return res.json({
    success: true,
    ai_configured: !!getGenAI(),
    model: runtimeModel,
  });
});

module.exports = router;
