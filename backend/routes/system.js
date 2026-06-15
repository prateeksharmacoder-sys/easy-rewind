/**
 * easy-rewind — System Route Module
 *
 * System-level endpoints: health, session, users, research, push, export/import, settings, logging.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const {
  config,
  getDb,
  getGenAI,
  resetGenAI,
  callGemini,
  sanitize,
  sanitizeUserId,
  getUserId,
  normalizeDate,
  saveSettings,
} = require('./helpers');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// ─────────────────────────────────────────────
// GET /api/health — Server health check
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

// ─────────────────────────────────────────────
// POST /api/session — Create or resume a client session
// ─────────────────────────────────────────────
router.post('/session', (req, res) => {
  const { client_id, device, client_type } = req.body || {};
  const userId = config.profileUserId || 'anonymous';
  return res.json({
    user_id: userId,
    client_id: sanitize(client_id || '', 120),
    device: sanitize(device || '', 120),
    client_type: sanitize(client_type || '', 80),
    synced_at: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// POST /api/users/merge — Merge two user accounts
// ─────────────────────────────────────────────
router.post('/users/merge', (req, res) => {
  const database = getDb();
  const targetUserId = sanitizeUserId(req.body?.to_user_id || config.profileUserId);
  const sourceUserId = sanitizeUserId(req.body?.from_user_id);

  if (!sourceUserId || sourceUserId === targetUserId) {
    return res.json({ success: true, merged: false, user_id: targetUserId });
  }

  const tables = {
    bookmarks: ['user_id', 'url', 'title', 'topic', 'notes', 'remind_at', 'reminded', 'created_at'],
    notes: [
      'user_id',
      'content',
      'source_url',
      'source_title',
      'remind_at',
      'reminded',
      'reminder_note',
      'completed',
      'created_at',
    ],
    highlights: ['user_id', 'url', 'page_title', 'text', 'context', 'color', 'tags', 'note', 'created_at'],
    research_queue: [
      'user_id',
      'url',
      'title',
      'user_notes',
      'research_result',
      'status',
      'error_message',
      'remind_when_done',
      'created_at',
      'completed_at',
    ],
    reminders: [
      'user_id',
      'reminder_type',
      'reference_type',
      'reference_id',
      'title',
      'message',
      'remind_at',
      'reminded',
      'dismissed',
      'created_at',
      'repeat_interval_days',
      'repeat_count',
      'max_repeats',
      'next_review_at',
    ],
    search_log: ['user_id', 'query', 'found', 'created_at'],
  };

  const merged = {};
  try {
    for (const [table, columns] of Object.entries(tables)) {
      const rows = database.prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE user_id = ?`).all(sourceUserId);
      const insert = database.prepare(
        `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      const tx = database.transaction(rows => {
        for (const row of rows) {
          const values = columns.map(col => (col === 'user_id' ? targetUserId : row[col]));
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

// ═════════════════════════════════════════════
// RESEARCH ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/research — Queue a deep research
router.post('/research', async (req, res) => {
  const { url, title, user_notes, auto_process } = req.body;
  const user_id = getUserId(req);

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required.' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const database = getDb();

  try {
    const info = database
      .prepare(
        `
      INSERT INTO research_queue (url, title, user_notes, status, user_id)
      VALUES (?, ?, ?, 'pending', ?)
    `
      )
      .run(sanitize(url, 2000), sanitize(title || url, 500), sanitize(user_notes || '', 1000), user_id);

    const research = database.prepare('SELECT * FROM research_queue WHERE id = ?').get(info.lastInsertRowid);

    if (auto_process !== false) {
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
    database.prepare("UPDATE research_queue SET status = 'processing' WHERE id = ?").run(id);

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

    const ai = getGenAI();
    if (!ai) {
      database
        .prepare("UPDATE research_queue SET status = 'failed', error_message = 'AI not configured' WHERE id = ?")
        .run(id);
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

    database
      .prepare(
        `
      UPDATE research_queue SET status = 'done', research_result = ?, completed_at = (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z')
      WHERE id = ?
    `
      )
      .run(analysis, id);

    database
      .prepare(
        `
      INSERT INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at)
      VALUES (?, 'research_done', 'research', ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now', '+5 minutes') || 'Z'))
    `
      )
      .run(
        userId,
        id,
        `📖 Research ready: ${sanitize(title || 'Untitled', 100)}`,
        'Your AI deep research has been completed.'
      );

    console.log(`[Research] Completed for ID ${id}: "${title}"`);
  } catch (err) {
    console.error('[Research Process Error]', err.message);
    try {
      database
        .prepare("UPDATE research_queue SET status = 'failed', error_message = ? WHERE id = ?")
        .run(err.message, id);
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
    const research = database
      .prepare('SELECT * FROM research_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(user_id, limit, offset);

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
    const info = database
      .prepare(
        `
      INSERT INTO push_subscriptions (platform, subscription_json, device_name, last_active, user_id)
      VALUES (?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'), ?)
    `
      )
      .run(
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
    const research = database
      .prepare('SELECT * FROM research_queue WHERE user_id = ? ORDER BY created_at DESC')
      .all(uid);
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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="easy-rewind-export-${new Date().toISOString().slice(0, 10)}.json"`
    );
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
      return res
        .status(400)
        .json({ error: 'Invalid import data. Expected { data: { bookmarks, notes, highlights, ... } }' });
    }

    const imported = { bookmarks: 0, notes: 0, highlights: 0, research: 0, reminders: 0 };

    const insertBookmark = database.prepare(
      `INSERT OR IGNORE INTO bookmarks (user_id, url, title, topic, notes, remind_at, reminded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const b of data.bookmarks || []) {
      insertBookmark.run(
        uid,
        b.url,
        b.title,
        b.topic,
        b.notes || '',
        b.remind_at || null,
        b.reminded || 0,
        b.created_at
      );
      imported.bookmarks++;
    }

    const insertNote = database.prepare(
      `INSERT OR IGNORE INTO notes (user_id, content, source_url, source_title, remind_at, reminded, completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const n of data.notes || []) {
      insertNote.run(
        uid,
        n.content,
        n.source_url || null,
        n.source_title || null,
        n.remind_at || null,
        n.reminded || 0,
        n.completed || 0,
        n.created_at
      );
      imported.notes++;
    }

    const insertHighlight = database.prepare(
      `INSERT OR IGNORE INTO highlights (user_id, url, page_title, text, context, color, tags, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const h of data.highlights || []) {
      insertHighlight.run(
        uid,
        h.url,
        h.page_title || '',
        h.text,
        h.context || null,
        h.color || 'yellow',
        h.tags || '',
        h.note || '',
        h.created_at
      );
      imported.highlights++;
    }

    const insertResearch = database.prepare(
      `INSERT OR IGNORE INTO research_queue (user_id, url, title, user_notes, research_result, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.research || []) {
      insertResearch.run(
        uid,
        r.url,
        r.title || '',
        r.user_notes || null,
        r.research_result || null,
        r.status || 'pending',
        r.created_at
      );
      imported.research++;
    }

    const insertReminder = database.prepare(
      `INSERT OR IGNORE INTO reminders (user_id, reminder_type, reference_type, reference_id, title, message, remind_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.reminders || []) {
      insertReminder.run(
        uid,
        'imported',
        r.reference_type || null,
        r.reference_id || null,
        r.title,
        r.message || null,
        r.remind_at,
        r.created_at
      );
      imported.reminders++;
    }

    return res.json({ success: true, imported });
  } catch (err) {
    console.error('[Import Error]', err.message);
    return res.status(500).json({ error: 'Import failed.' });
  }
});

// ═════════════════════════════════════════════
// SETTINGS ENDPOINTS
// ═════════════════════════════════════════════

// GET /api/settings — Retrieve current runtime settings
router.get('/settings', (req, res) => {
  return res.json({
    ai_configured: !!getGenAI(),
    model: config.model,
    api_base_url: config.apiBaseUrl,
    summarization_backend: config.summarizationBackend,
    spaced_review_enabled: config.spacedReviewEnabled,
    review_interval_days: config.reviewIntervalDays,
    embed_provider: config.embedProvider,
    has_runtime_key: !!config.apiKey,
    has_env_key: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here',
    settings_file_exists: fs.existsSync(SETTINGS_PATH),
  });
});

// POST /api/settings — Update runtime settings — persists to disk
router.post('/settings', (req, res) => {
  const {
    gemini_api_key,
    ai_model,
    api_base_url,
    summarization_backend,
    spaced_review_enabled,
    review_interval_days,
    embed_provider,
  } = req.body;

  if (gemini_api_key !== undefined) {
    config.apiKey = gemini_api_key || null;
    resetGenAI();
  }

  if (ai_model !== undefined) {
    config.model = ai_model || 'gemini-2.5-flash';
  }

  if (api_base_url !== undefined) {
    config.apiBaseUrl = api_base_url.replace(/\/+$/, '') || 'http://localhost:5000';
  }

  if (summarization_backend !== undefined) {
    const allowed = ['auto', 'chrome', 'local', 'gemini', 'backend'];
    config.summarizationBackend = allowed.includes(summarization_backend) ? summarization_backend : 'auto';
  }

  if (spaced_review_enabled !== undefined) {
    config.spacedReviewEnabled = !!spaced_review_enabled;
  }

  if (review_interval_days !== undefined) {
    config.reviewIntervalDays = Math.max(1, parseInt(review_interval_days) || 3);
  }

  if (embed_provider !== undefined) {
    const allowed = ['auto', 'gemini', 'openai'];
    config.embedProvider = allowed.includes(embed_provider) ? embed_provider : 'auto';
  }

  saveSettings();

  console.log('[Settings] Runtime config updated:', {
    ai_configured: !!config.apiKey || !!process.env.GEMINI_API_KEY,
    model: config.model,
    summarization_backend: config.summarizationBackend,
    spaced_review_enabled: config.spacedReviewEnabled,
  });

  return res.json({
    success: true,
    ai_configured: !!getGenAI(),
    model: config.model,
    api_base_url: config.apiBaseUrl,
    summarization_backend: config.summarizationBackend,
    spaced_review_enabled: config.spacedReviewEnabled,
    review_interval_days: config.reviewIntervalDays,
  });
});

// ═════════════════════════════════════════════
// CLIENT-SIDE ERROR LOGGING
// ═════════════════════════════════════════════

// POST /api/log — Accept client-side error reports
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

  try {
    const database = getDb();
    database
      .prepare(
        `
      INSERT INTO error_log (user_id, level, component, message, stack, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        user_id,
        (level || 'INFO').slice(0, 10),
        (component || 'client').slice(0, 50),
        (message || '').slice(0, 500),
        (stack || '').slice(0, 2000),
        data ? JSON.stringify(data).slice(0, 2000) : null
      );
  } catch (_) {
    /* best-effort */
  }

  return res.json({ success: true });
});

// GET /api/logs — Retrieve recent error logs
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
