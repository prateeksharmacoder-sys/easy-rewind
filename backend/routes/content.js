/**
 * easy-rewind — Content Route Module
 *
 * Core CRUD for bookmarks, notes, reminders, and search.
 */

const express = require('express');
const router = express.Router();

const {
  getDb,
  getUserId,
  sanitize,
  isValidId,
  normalizeDate,
  createReminder,
  scheduleNextReview,
  calculateNextReview,
  sendPushNotification,
} = require('./helpers');

// ─────────────────────────────────────────────
// POST /api/bookmark — Save a bookmark
// ─────────────────────────────────────────────
router.post('/bookmark', (req, res) => {
  const { url, title, topic, notes, remind_at, remind_in_minutes, repeat_interval_days, max_repeats } = req.body;
  const user_id = getUserId(req);

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required.' });
  }
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    return res.status(400).json({ error: 'Topic label is required.' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    const minutes = parseInt(remind_in_minutes);
    if (isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'remind_in_minutes must be a positive number.' });
    }
    remindAt = new Date(Date.now() + minutes * 60000).toISOString();
  }

  const database = getDb();

  try {
    const info = database
      .prepare(
        `
      INSERT INTO bookmarks (url, title, topic, notes, remind_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        sanitize(url, 2000),
        sanitize(title || url, 500),
        sanitize(topic, 200),
        sanitize(notes || '', 1000),
        remindAt,
        user_id
      );

    const bookmark = database.prepare('SELECT * FROM bookmarks WHERE id = ?').get(info.lastInsertRowid);

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
// GET /api/bookmarks — List bookmarks
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
      case 'oldest':
        orderClause = 'ORDER BY created_at ASC';
        break;
      case 'alphabetical':
        orderClause = 'ORDER BY title ASC';
        break;
      case 'topic':
        orderClause = 'ORDER BY topic ASC';
        break;
      default:
        orderClause = 'ORDER BY created_at DESC';
    }

    const total = database.prepare(`SELECT COUNT(*) as count FROM bookmarks ${whereClause}`).get(...params).count;
    const bookmarks = database
      .prepare(`SELECT * FROM bookmarks ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    const uniqueTopics = database
      .prepare('SELECT COUNT(DISTINCT LOWER(topic)) as count FROM bookmarks WHERE user_id = ?')
      .get(user_id).count;

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
// GET /api/search — Search bookmarks and notes
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
    const results = database
      .prepare(
        `
      SELECT * FROM bookmarks
      WHERE user_id = ?
        AND (LOWER(topic) LIKE LOWER(?) OR LOWER(title) LIKE LOWER(?) OR LOWER(url) LIKE LOWER(?) OR LOWER(notes) LIKE LOWER(?))
      ORDER BY created_at DESC
      LIMIT 50
    `
      )
      .all(user_id, pattern, pattern, pattern, pattern);

    const noteResults = database
      .prepare(
        `
      SELECT * FROM notes
      WHERE user_id = ?
        AND (LOWER(content) LIKE LOWER(?) OR LOWER(source_title) LIKE LOWER(?) OR LOWER(source_url) LIKE LOWER(?))
      ORDER BY created_at DESC
      LIMIT 20
    `
      )
      .all(user_id, pattern, pattern, pattern);

    try {
      database
        .prepare('INSERT INTO search_log (user_id, query, found) VALUES (?, ?, ?)')
        .run(user_id, cleanQuery, results.length > 0 || noteResults.length > 0 ? 1 : 0);
    } catch (_) {}

    return res.json({
      results: results || [],
      notes: noteResults || [],
      count: results?.length || 0,
      notes_count: noteResults?.length || 0,
      query: cleanQuery,
    });
  } catch (err) {
    console.error('[Search Error]', err.message);
    return res.status(500).json({ error: 'Search failed.' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/bookmark/:id — Delete a bookmark
// ─────────────────────────────────────────────
router.delete('/bookmark/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid bookmark ID is required.' });

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
// NOTES ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/notes — Create a quick note
router.post('/notes', (req, res) => {
  const {
    content,
    source_url,
    source_title,
    remind_at,
    remind_in_minutes,
    reminder_note,
    repeat_interval_days,
    max_repeats,
  } = req.body;
  const user_id = getUserId(req);

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Note content is required.' });
  }

  const cleanContent = sanitize(content, 2000);
  if (cleanContent.length < 1) {
    return res.status(400).json({ error: 'Note is too short.' });
  }

  const database = getDb();

  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    const minutes = parseInt(remind_in_minutes);
    if (isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'remind_in_minutes must be a positive number.' });
    }
    remindAt = new Date(Date.now() + minutes * 60000).toISOString();
  }

  try {
    const info = database
      .prepare(
        `
      INSERT INTO notes (user_id, content, source_url, source_title, remind_at, reminder_note)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        user_id,
        cleanContent,
        sanitize(source_url || '', 2000),
        sanitize(source_title || '', 500),
        remindAt,
        sanitize(reminder_note || '', 500)
      );

    const note = database.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);

    if (remindAt && note) {
      try {
        createReminder(database, user_id, {
          reminder_type: 'note_action',
          reference_type: 'note',
          reference_id: note.id,
          title: '📝 ' + sanitize(reminder_note || cleanContent, 100),
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

    const total = database.prepare('SELECT COUNT(*) as count FROM notes ' + whereClause).get(...params).count;
    const notes = database
      .prepare('SELECT * FROM notes ' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(...params, limit, offset);

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

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid note ID is required.' });

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

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid note ID is required.' });

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
  const {
    title,
    message,
    remind_at,
    remind_in_minutes,
    reminder_type,
    reference_type,
    reference_id,
    repeat_interval_days,
    max_repeats,
  } = req.body;
  const user_id = getUserId(req);

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Reminder title is required.' });
  }

  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    const minutes = parseInt(remind_in_minutes);
    if (isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'remind_in_minutes must be a positive number.' });
    }
    remindAt = new Date(Date.now() + minutes * 60000).toISOString();
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
      query = 'SELECT * FROM reminders WHERE user_id = ? AND remind_at <= ? AND reminded = 0 AND dismissed = 0 LIMIT ?';
      params = [user_id, new Date().toISOString(), limit];
    } else {
      query = 'SELECT * FROM reminders WHERE user_id = ? AND dismissed = 0 ORDER BY remind_at ASC LIMIT ?';
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

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid reminder ID is required.' });

  const database = getDb();

  try {
    const sets = [];
    const params = [];
    if (reminded !== undefined) {
      sets.push('reminded = ?');
      params.push(reminded ? 1 : 0);
    }
    if (dismissed !== undefined) {
      sets.push('dismissed = ?');
      params.push(dismissed ? 1 : 0);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    database
      .prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...params, id, user_id);

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

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid reminder ID is required.' });

  const database = getDb();

  try {
    database.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(id, user_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete reminder.' });
  }
});

// ═════════════════════════════════════════════
// CHECK REMINDERS (internal, called periodically)
// ═════════════════════════════════════════════

// POST /api/check-reminders
router.post('/check-reminders', (req, res) => {
  const database = getDb();

  try {
    const now = new Date().toISOString();

    const dueReminders = database
      .prepare(
        `
      SELECT * FROM reminders
      WHERE remind_at <= ?
        AND reminded = 0
        AND dismissed = 0
      LIMIT 50
    `
      )
      .all(now);

    if (!dueReminders || dueReminders.length === 0) {
      return res.json({ processed: 0 });
    }

    const ids = dueReminders.map(r => r.id);

    const updateStmt = database.prepare('UPDATE reminders SET reminded = 1 WHERE id = ?');
    const markReminded = database.transaction(ids => {
      for (const id of ids) {
        updateStmt.run(id);
      }
    });
    markReminded(ids);

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
// FLASHCARDS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/flashcards — Create a flashcard
router.post('/flashcards', (req, res) => {
  const { term, definition, source, source_id, source_url } = req.body;
  const user_id = getUserId(req);

  if (!term || typeof term !== 'string' || term.trim().length === 0) {
    return res.status(400).json({ error: 'Flashcard term is required.' });
  }
  if (!definition || typeof definition !== 'string' || definition.trim().length === 0) {
    return res.status(400).json({ error: 'Flashcard definition is required.' });
  }

  const database = getDb();

  try {
    const info = database
      .prepare(
        `
      INSERT INTO flashcards (user_id, term, definition, source, source_id, source_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        user_id,
        sanitize(term, 500),
        sanitize(definition, 5000),
        sanitize(source || 'manual', 50),
        isValidId(source_id) ? parseInt(source_id) : null,
        sanitize(source_url || '', 2000)
      );

    const flashcard = database.prepare('SELECT * FROM flashcards WHERE id = ?').get(info.lastInsertRowid);
    return res.json({ success: true, flashcard });
  } catch (err) {
    console.error('[Flashcard Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to create flashcard.' });
  }
});

// GET /api/flashcards — List flashcards
router.get('/flashcards', (req, res) => {
  const user_id = getUserId(req);
  const due = req.query.due === 'true';
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const source = req.query.source || null;

  const database = getDb();

  try {
    let whereClause = 'WHERE user_id = ?';
    const params = [user_id];

    if (due) {
      whereClause += ' AND next_review_at <= ?';
      params.push(new Date().toISOString());
    }

    if (source) {
      whereClause += ' AND source = ?';
      params.push(source);
    }

    const total = database.prepare(`SELECT COUNT(*) as count FROM flashcards ${whereClause}`).get(...params).count;
    const flashcards = database
      .prepare(`SELECT * FROM flashcards ${whereClause} ORDER BY next_review_at ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    // Count total due across all flashcards for this user
    const dueCount = database
      .prepare('SELECT COUNT(*) as count FROM flashcards WHERE user_id = ? AND next_review_at <= ?')
      .get(user_id, new Date().toISOString()).count;

    return res.json({
      flashcards: flashcards || [],
      total,
      due_count: dueCount,
    });
  } catch (err) {
    console.error('[Get Flashcards Error]', err.message);
    return res.status(500).json({ error: 'Failed to load flashcards.' });
  }
});

// PATCH /api/flashcards/:id/review — Review a card (SM-2)
router.patch('/flashcards/:id/review', (req, res) => {
  const { id } = req.params;
  const { quality } = req.body;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid flashcard ID is required.' });

  const q = parseInt(quality);
  if (isNaN(q) || q < 0 || q > 5) {
    return res.status(400).json({ error: 'Review quality must be an integer between 0 and 5.' });
  }

  const database = getDb();

  try {
    const card = database.prepare('SELECT * FROM flashcards WHERE id = ? AND user_id = ?').get(id, user_id);
    if (!card) return res.status(404).json({ error: 'Flashcard not found.' });

    const result = calculateNextReview(q, card);

    database
      .prepare(
        `
      UPDATE flashcards
      SET ease_factor = ?, interval_days = ?, repetitions = ?,
          next_review_at = ?, last_reviewed_at = ?
      WHERE id = ? AND user_id = ?
    `
      )
      .run(
        result.ease_factor,
        result.interval_days,
        result.repetitions,
        result.next_review_at,
        new Date().toISOString(),
        id,
        user_id
      );

    const updated = database.prepare('SELECT * FROM flashcards WHERE id = ?').get(id);
    return res.json({ success: true, flashcard: updated, review: result });
  } catch (err) {
    console.error('[Review Flashcard Error]', err.message);
    return res.status(500).json({ error: 'Failed to review flashcard.' });
  }
});

// DELETE /api/flashcards/:id — Delete a flashcard
router.delete('/flashcards/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid flashcard ID is required.' });

  const database = getDb();

  try {
    database.prepare('DELETE FROM flashcards WHERE id = ? AND user_id = ?').run(id, user_id);
    return res.json({ success: true, message: 'Flashcard deleted.' });
  } catch (err) {
    console.error('[Delete Flashcard Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete flashcard.' });
  }
});

// POST /api/flashcards/generate — Auto-generate flashcards from existing content
router.post('/flashcards/generate', (req, res) => {
  const { source_type, source_ids } = req.body; // source_type: 'bookmark' | 'item' | 'search_log'
  const user_id = getUserId(req);

  const database = getDb();

  try {
    let inserted = 0;

    if (source_type === 'bookmark' || !source_type) {
      let bookmarks;
      if (source_ids && Array.isArray(source_ids) && source_ids.length > 0) {
        const placeholders = source_ids.map(() => '?').join(',');
        bookmarks = database
          .prepare(`SELECT * FROM bookmarks WHERE user_id = ? AND id IN (${placeholders})`)
          .all(user_id, ...source_ids);
      } else {
        // Take top 20 bookmarks that don't already have a flashcard
        bookmarks = database
          .prepare(
            `
          SELECT b.* FROM bookmarks b
          WHERE b.user_id = ?
            AND b.topic != ''
            AND b.id NOT IN (SELECT source_id FROM flashcards WHERE user_id = ? AND source = 'bookmark')
          ORDER BY b.created_at DESC LIMIT 20
        `
          )
          .all(user_id, user_id);
      }

      const insertStmt = database.prepare(`
        INSERT OR IGNORE INTO flashcards (user_id, term, definition, source, source_id, source_url)
        VALUES (?, ?, ?, 'bookmark', ?, ?)
      `);

      for (const bm of bookmarks) {
        const result = insertStmt.run(
          user_id,
          sanitize(bm.title || bm.topic, 500),
          sanitize(bm.notes || bm.topic || 'Bookmarked page', 5000),
          bm.id,
          sanitize(bm.url || '', 2000)
        );
        if (result.changes > 0) inserted++;
      }
    }

    if (source_type === 'item' || !source_type) {
      let items;
      if (source_ids && Array.isArray(source_ids) && source_ids.length > 0) {
        const placeholders = source_ids.map(() => '?').join(',');
        items = database
          .prepare(`SELECT * FROM items WHERE user_id = ? AND id IN (${placeholders})`)
          .all(user_id, ...source_ids);
      } else {
        items = database
          .prepare(
            `
          SELECT i.* FROM items i
          WHERE i.user_id = ?
            AND i.id NOT IN (SELECT source_id FROM flashcards WHERE user_id = ? AND source = 'item')
          ORDER BY i.created_at DESC LIMIT 20
        `
          )
          .all(user_id, user_id);
      }

      const insertStmt = database.prepare(`
        INSERT OR IGNORE INTO flashcards (user_id, term, definition, source, source_id, source_url)
        VALUES (?, ?, ?, 'item', ?, ?)
      `);

      for (const item of items) {
        const term = item.tags
          ? item.tags
              .split(',')
              .map(t => t.trim())
              .filter(Boolean)
              .slice(0, 3)
              .join(', ')
          : item.title || 'Saved item';
        const definition = item.ai_summary || item.content?.slice(0, 300) || 'Saved item';
        const result = insertStmt.run(
          user_id,
          sanitize(term, 500),
          sanitize(definition, 5000),
          item.id,
          sanitize(item.url || '', 2000)
        );
        if (result.changes > 0) inserted++;
      }
    }

    return res.json({ success: true, inserted });
  } catch (err) {
    console.error('[Generate Flashcards Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate flashcards.' });
  }
});

module.exports = router;
