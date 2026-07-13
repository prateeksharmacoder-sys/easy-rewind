/**
 * easy-rewind — Content Route Module
 *
 * Core CRUD for bookmarks, notes, reminders, and search.
 */

const express = require('express');
const router = express.Router();
const neo4j = require('neo4j-driver');

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
router.post('/bookmark', async (req, res) => {
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
  const session = database.session();

  try {
    const result = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (b:Bookmark {
        id: randomUUID(),
        url: $url,
        title: $title,
        topic: $topic,
        notes: $notes,
        remind_at: $remindAt,
        reminded: 0,
        created_at: datetime()
      })
      CREATE (u)-[:HAS_BOOKMARK]->(b)
      RETURN b
      `,
      {
        userId: user_id,
        url: sanitize(url, 2000),
        title: sanitize(title || url, 500),
        topic: sanitize(topic, 200),
        notes: sanitize(notes || '', 1000),
        remindAt: remindAt ? remindAt : null
      }
    );

    const bookmark = result.records[0] ? result.records[0].get('b').properties : null;

    if (remindAt && bookmark) {
      try {
        await createReminder(database, user_id, {
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
  } finally {
    await session.close();
  }
});

// ─────────────────────────────────────────────
// GET /api/bookmarks — List bookmarks
// ─────────────────────────────────────────────
router.get('/bookmarks', async (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const sort = req.query.sort || 'newest';
  const topic = req.query.topic || null;

  const database = getDb();
  const session = database.session();

  try {
    let whereClause = 'WHERE u.id = $userId';
    const params = { userId: user_id, limit: neo4j.int(limit), skip: neo4j.int(offset) };

    if (topic) {
      whereClause += ' AND toLower(b.topic) CONTAINS toLower($topic)';
      params.topic = topic;
    }

    let orderClause;
    switch (sort) {
      case 'oldest': orderClause = 'ORDER BY b.created_at ASC'; break;
      case 'alphabetical': orderClause = 'ORDER BY b.title ASC'; break;
      case 'topic': orderClause = 'ORDER BY b.topic ASC'; break;
      default: orderClause = 'ORDER BY b.created_at DESC';
    }

    const countQuery = `MATCH (u:User)-[:HAS_BOOKMARK]->(b:Bookmark) ${whereClause} RETURN count(b) AS c`;
    const dataQuery = `MATCH (u:User)-[:HAS_BOOKMARK]->(b:Bookmark) ${whereClause} RETURN b ${orderClause} SKIP $skip LIMIT $limit`;
    const topicCountQuery = `MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark) RETURN count(DISTINCT toLower(b.topic)) AS c`;

    const countRes = await session.run(countQuery, params);
    const dataRes = await session.run(dataQuery, params);
    const topicCountRes = await session.run(topicCountQuery, { userId: user_id });

    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;
    const bookmarks = dataRes.records.map(r => r.get('b').properties);
    const uniqueTopics = topicCountRes.records[0] ? topicCountRes.records[0].get('c').toNumber() : 0;

    return res.json({
      bookmarks: bookmarks,
      total,
      stats: { total_bookmarks: total, unique_topics: uniqueTopics },
    });
  } catch (err) {
    console.error('[Get Bookmarks Error]', err.message);
    return res.status(500).json({ error: 'Failed to load bookmarks.' });
  } finally {
    await session.close();
  }
});

// ─────────────────────────────────────────────
// GET /api/search — Search bookmarks and notes
// ─────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const query = req.query.q;
  const user_id = getUserId(req);

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  const cleanQuery = sanitize(query, 200);
  const database = getDb();
  const session = database.session();

  try {
    const bookmarkQuery = `
      MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark)
      WHERE toLower(b.topic) CONTAINS toLower($q)
         OR toLower(b.title) CONTAINS toLower($q)
         OR toLower(b.url) CONTAINS toLower($q)
         OR toLower(b.notes) CONTAINS toLower($q)
      RETURN b ORDER BY b.created_at DESC LIMIT 50
    `;
    
    const noteQuery = `
      MATCH (u:User {id: $userId})-[:HAS_NOTE]->(n:Note)
      WHERE toLower(n.content) CONTAINS toLower($q)
         OR toLower(n.source_title) CONTAINS toLower($q)
         OR toLower(n.source_url) CONTAINS toLower($q)
      RETURN n ORDER BY n.created_at DESC LIMIT 20
    `;

    const bRes = await session.run(bookmarkQuery, { userId: user_id, q: cleanQuery });
    const nRes = await session.run(noteQuery, { userId: user_id, q: cleanQuery });

    const results = bRes.records.map(r => r.get('b').properties);
    const noteResults = nRes.records.map(r => r.get('n').properties);

    try {
      await session.run(
        `CREATE (s:SearchLog {
          id: randomUUID(),
          query: $query,
          found: $found,
          created_at: datetime()
        })
        WITH s
        MATCH (u:User {id: $userId})
        CREATE (u)-[:SEARCHED]->(s)`,
        {
          userId: user_id,
          query: cleanQuery,
          found: (results.length > 0 || noteResults.length > 0) ? 1 : 0
        }
      );
    } catch (_) {}

    return res.json({
      results: results || [],
      notes: noteResults || [],
      count: results.length,
      notes_count: noteResults.length,
      query: cleanQuery,
    });
  } catch (err) {
    console.error('[Search Error]', err.message);
    return res.status(500).json({ error: 'Search failed.' });
  } finally {
    await session.close();
  }
});

// ─────────────────────────────────────────────
// DELETE /api/bookmark/:id — Delete a bookmark
// ─────────────────────────────────────────────
router.delete('/bookmark/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid bookmark ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark {id: $id})
      DETACH DELETE b
    `, { userId: user_id, id: String(id) });
    
    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder {reference_type: 'bookmark', reference_id: $id})
      DETACH DELETE r
    `, { userId: user_id, id: String(id) });

    return res.json({ success: true, message: 'Bookmark deleted.' });
  } catch (err) {
    console.error('[Delete Bookmark Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete bookmark.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// NOTES ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/notes — Create a quick note
router.post('/notes', async (req, res) => {
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

  let remindAt = normalizeDate(remind_at);
  if (remind_in_minutes !== undefined && remind_in_minutes !== '' && !remindAt) {
    const minutes = parseInt(remind_in_minutes);
    if (isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'remind_in_minutes must be a positive number.' });
    }
    remindAt = new Date(Date.now() + minutes * 60000).toISOString();
  }

  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (n:Note {
        id: randomUUID(),
        content: $content,
        source_url: $source_url,
        source_title: $source_title,
        remind_at: $remindAt,
        reminder_note: $reminder_note,
        completed: 0,
        reminded: 0,
        created_at: datetime()
      })
      CREATE (u)-[:HAS_NOTE]->(n)
      RETURN n
      `,
      {
        userId: user_id,
        content: cleanContent,
        source_url: sanitize(source_url || '', 2000),
        source_title: sanitize(source_title || '', 500),
        remindAt: remindAt ? remindAt : null,
        reminder_note: sanitize(reminder_note || '', 500)
      }
    );

    const note = result.records[0] ? result.records[0].get('n').properties : null;

    if (remindAt && note) {
      try {
        await createReminder(database, user_id, {
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
  } finally {
    await session.close();
  }
});

// GET /api/notes — List notes
router.get('/notes', async (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const showCompleted = req.query.completed === 'true';

  const database = getDb();
  const session = database.session();

  try {
    let whereClause = 'WHERE u.id = $userId';
    const params = { userId: user_id, limit: neo4j.int(limit), skip: neo4j.int(offset) };

    if (!showCompleted) {
      whereClause += ' AND (n.completed = 0 OR n.completed IS NULL)';
    }

    const countQuery = `MATCH (u:User)-[:HAS_NOTE]->(n:Note) ${whereClause} RETURN count(n) AS c`;
    const dataQuery = `MATCH (u:User)-[:HAS_NOTE]->(n:Note) ${whereClause} RETURN n ORDER BY n.created_at DESC SKIP $skip LIMIT $limit`;

    const countRes = await session.run(countQuery, params);
    const dataRes = await session.run(dataQuery, params);

    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;
    const notes = dataRes.records.map(r => r.get('n').properties);

    return res.json({ notes: notes || [], total });
  } catch (err) {
    console.error('[Get Notes Error]', err.message);
    return res.status(500).json({ error: 'Failed to load notes.' });
  } finally {
    await session.close();
  }
});

// PATCH /api/notes/:id/toggle — Toggle note completed status
router.patch('/notes/:id/toggle', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid note ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_NOTE]->(n:Note {id: $id})
      SET n.completed = CASE WHEN coalesce(n.completed, 0) = 0 THEN 1 ELSE 0 END
      RETURN n.completed AS completed
    `, { userId: user_id, id: String(id) });

    if (result.records.length === 0) return res.status(404).json({ error: 'Note not found.' });

    const newCompleted = result.records[0].get('completed');

    return res.json({ success: true, completed: !!newCompleted });
  } catch (err) {
    console.error('[Toggle Note Error]', err.message);
    return res.status(500).json({ error: 'Failed to update note.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/notes/:id
router.delete('/notes/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid note ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_NOTE]->(n:Note {id: $id})
      DETACH DELETE n
    `, { userId: user_id, id: String(id) });

    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder {reference_type: 'note', reference_id: $id})
      DETACH DELETE r
    `, { userId: user_id, id: String(id) });

    return res.json({ success: true, message: 'Note deleted.' });
  } catch (err) {
    console.error('[Delete Note Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete note.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// REMINDERS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/reminders — Schedule a reminder
router.post('/reminders', async (req, res) => {
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
    const reminder = await createReminder(database, user_id, {
      title,
      message,
      remind_at: remindAt,
      reminder_type,
      reference_type,
      reference_id,
      repeat_interval_days,
      max_repeats,
    });

    return res.json({ success: true, reminder });
  } catch (err) {
    console.error('[Reminder Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to create reminder.' });
  }
});

router.get('/reminders', async (req, res) => {
  const user_id = getUserId(req);
  const due = req.query.due === 'true';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const database = getDb();
  const session = database.session();

  try {
    let query, params;

    if (due) {
      query = `
        MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder)
        WHERE r.remind_at <= datetime($now) AND coalesce(r.reminded, 0) = 0 AND coalesce(r.dismissed, 0) = 0
        RETURN r LIMIT $limit
      `;
      params = { userId: user_id, now: new Date().toISOString(), limit: neo4j.int(limit) };
    } else {
      query = `
        MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder)
        WHERE coalesce(r.dismissed, 0) = 0
        RETURN r ORDER BY r.remind_at ASC LIMIT $limit
      `;
      params = { userId: user_id, limit: neo4j.int(limit) };
    }

    const result = await session.run(query, params);
    const reminders = result.records.map(rec => rec.get('r').properties);

    return res.json({ reminders: reminders || [], total: reminders.length });
  } catch (err) {
    console.error('[Get Reminders Error]', err.message);
    return res.status(500).json({ error: 'Failed to load reminders.' });
  } finally {
    await session.close();
  }
});

router.patch('/reminders/:id', async (req, res) => {
  const { id } = req.params;
  const { reminded, dismissed, remind_at } = req.body;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid reminder ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    const sets = [];
    const params = { id: String(id), userId: user_id };

    if (reminded !== undefined) {
      sets.push('r.reminded = $reminded');
      params.reminded = reminded ? 1 : 0;
    }
    if (dismissed !== undefined) {
      sets.push('r.dismissed = $dismissed');
      params.dismissed = dismissed ? 1 : 0;
    }
    if (remind_at !== undefined) {
      const normalized = normalizeDate(remind_at);
      if (normalized) {
        sets.push('r.remind_at = datetime($remind_at)');
        params.remind_at = normalized;
        sets.push('r.reminded = 0');
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder {id: $id})
      SET ${sets.join(', ')}
    `, params);

    return res.json({ success: true });
  } catch (err) {
    console.error('[Update Reminder Error]', err.message);
    return res.status(500).json({ error: 'Failed to update reminder.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/reminders/:id
router.delete('/reminders/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid reminder ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_REMINDER]->(r:Reminder {id: $id})
      DETACH DELETE r
    `, { userId: user_id, id: String(id) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete reminder.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// CHECK REMINDERS (internal, called periodically)
// ═════════════════════════════════════════════

// POST /api/check-reminders
router.post('/check-reminders', async (req, res) => {
  const database = getDb();
  const session = database.session();

  try {
    const now = new Date().toISOString();

    const result = await session.run(
      `
      MATCH (u:User)-[:HAS_REMINDER]->(r:Reminder)
      WHERE r.remind_at <= datetime($now)
        AND coalesce(r.reminded, 0) = 0
        AND coalesce(r.dismissed, 0) = 0
      RETURN r, u.id AS userId
      LIMIT 50
      `,
      { now }
    );

    const dueReminders = result.records.map(rec => ({
      ...rec.get('r').properties,
      user_id: rec.get('userId')
    }));

    if (!dueReminders || dueReminders.length === 0) {
      return res.json({ processed: 0 });
    }

    const ids = dueReminders.map(r => r.id);

    await session.run(
      `
      MATCH (r:Reminder)
      WHERE r.id IN $ids
      SET r.reminded = 1
      `,
      { ids }
    );

    const byUser = {};
    for (const reminder of dueReminders) {
      if (!byUser[reminder.user_id]) byUser[reminder.user_id] = [];
      byUser[reminder.user_id].push(reminder);
      await scheduleNextReview(database, reminder);
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
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// FLASHCARDS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/flashcards — Create a flashcard
router.post('/flashcards', async (req, res) => {
  const { term, definition, source, source_id, source_url } = req.body;
  const user_id = getUserId(req);

  if (!term || typeof term !== 'string' || term.trim().length === 0) {
    return res.status(400).json({ error: 'Flashcard term is required.' });
  }
  if (!definition || typeof definition !== 'string' || definition.trim().length === 0) {
    return res.status(400).json({ error: 'Flashcard definition is required.' });
  }

  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (f:Flashcard {
        id: randomUUID(),
        term: $term,
        definition: $definition,
        source: $source,
        source_id: $source_id,
        source_url: $source_url,
        ease_factor: 2.5,
        interval_days: 0,
        repetitions: 0,
        next_review_at: datetime(),
        created_at: datetime()
      })
      CREATE (u)-[:HAS_FLASHCARD]->(f)
      RETURN f
      `,
      {
        userId: user_id,
        term: sanitize(term, 500),
        definition: sanitize(definition, 5000),
        source: sanitize(source || 'manual', 50),
        source_id: isValidId(source_id) ? String(source_id) : null,
        source_url: sanitize(source_url || '', 2000)
      }
    );

    const flashcard = result.records[0] ? result.records[0].get('f').properties : null;
    return res.json({ success: true, flashcard });
  } catch (err) {
    console.error('[Flashcard Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to create flashcard.' });
  } finally {
    await session.close();
  }
});

// GET /api/flashcards — List flashcards
router.get('/flashcards', async (req, res) => {
  const user_id = getUserId(req);
  const due = req.query.due === 'true';
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const source = req.query.source || null;

  const database = getDb();
  const session = database.session();

  try {
    let whereClause = 'WHERE u.id = $userId';
    const params = { userId: user_id, limit: neo4j.int(limit), skip: neo4j.int(offset) };

    if (due) {
      whereClause += ' AND f.next_review_at <= datetime($now)';
      params.now = new Date().toISOString();
    }

    if (source) {
      whereClause += ' AND f.source = $source';
      params.source = source;
    }

    const countQuery = `MATCH (u:User)-[:HAS_FLASHCARD]->(f:Flashcard) ${whereClause} RETURN count(f) AS c`;
    const dataQuery = `MATCH (u:User)-[:HAS_FLASHCARD]->(f:Flashcard) ${whereClause} RETURN f ORDER BY f.next_review_at ASC SKIP $skip LIMIT $limit`;
    const dueCountQuery = `MATCH (u:User {id: $userId})-[:HAS_FLASHCARD]->(f:Flashcard) WHERE f.next_review_at <= datetime($dueNow) RETURN count(f) AS c`;

    const countRes = await session.run(countQuery, params);
    const dataRes = await session.run(dataQuery, params);
    const dueCountRes = await session.run(dueCountQuery, { userId: user_id, dueNow: new Date().toISOString() });

    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;
    const flashcards = dataRes.records.map(r => r.get('f').properties);
    const dueCount = dueCountRes.records[0] ? dueCountRes.records[0].get('c').toNumber() : 0;

    return res.json({
      flashcards: flashcards || [],
      total,
      due_count: dueCount,
    });
  } catch (err) {
    console.error('[Get Flashcards Error]', err.message);
    return res.status(500).json({ error: 'Failed to load flashcards.' });
  } finally {
    await session.close();
  }
});

// PATCH /api/flashcards/:id/review — Review a card (SM-2)
router.patch('/flashcards/:id/review', async (req, res) => {
  const { id } = req.params;
  const { quality } = req.body;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid flashcard ID is required.' });

  const q = parseInt(quality);
  if (isNaN(q) || q < 0 || q > 5) {
    return res.status(400).json({ error: 'Review quality must be an integer between 0 and 5.' });
  }

  const database = getDb();
  const session = database.session();

  try {
    const getRes = await session.run(`MATCH (u:User {id: $userId})-[:HAS_FLASHCARD]->(f:Flashcard {id: $id}) RETURN f`, { userId: user_id, id: String(id) });
    if (getRes.records.length === 0) return res.status(404).json({ error: 'Flashcard not found.' });

    const card = getRes.records[0].get('f').properties;
    const result = calculateNextReview(q, card);

    const updateRes = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_FLASHCARD]->(f:Flashcard {id: $id})
      SET f.ease_factor = $ease,
          f.interval_days = $interval,
          f.repetitions = $reps,
          f.next_review_at = datetime($nextReview),
          f.last_reviewed_at = datetime($now)
      RETURN f
      `,
      {
        userId: user_id,
        id: String(id),
        ease: result.ease_factor,
        interval: result.interval_days,
        reps: result.repetitions,
        nextReview: result.next_review_at,
        now: new Date().toISOString()
      }
    );

    const updated = updateRes.records[0].get('f').properties;
    return res.json({ success: true, flashcard: updated, review: result });
  } catch (err) {
    console.error('[Review Flashcard Error]', err.message);
    return res.status(500).json({ error: 'Failed to review flashcard.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/flashcards/:id — Delete a flashcard
router.delete('/flashcards/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  if (!isValidId(id)) return res.status(400).json({ error: 'Valid flashcard ID is required.' });

  const database = getDb();
  const session = database.session();

  try {
    await session.run(`
      MATCH (u:User {id: $userId})-[:HAS_FLASHCARD]->(f:Flashcard {id: $id})
      DETACH DELETE f
    `, { userId: user_id, id: String(id) });
    return res.json({ success: true, message: 'Flashcard deleted.' });
  } catch (err) {
    console.error('[Delete Flashcard Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete flashcard.' });
  } finally {
    await session.close();
  }
});

router.post('/flashcards/generate', async (req, res) => {
  const { source_type, source_ids } = req.body;
  const user_id = getUserId(req);

  const database = getDb();
  const session = database.session();

  try {
    let inserted = 0;

    if (source_type === 'bookmark' || !source_type) {
      let bookmarks = [];
      if (source_ids && Array.isArray(source_ids) && source_ids.length > 0) {
        const result = await session.run(
          `MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark) WHERE b.id IN $sourceIds RETURN b`,
          { userId: user_id, sourceIds: source_ids.map(String) }
        );
        bookmarks = result.records.map(r => r.get('b').properties);
      } else {
        const result = await session.run(
          `
          MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark)
          WHERE coalesce(b.topic, '') <> ''
            AND NOT EXISTS { MATCH (u)-[:HAS_FLASHCARD]->(f:Flashcard {source: 'bookmark', source_id: b.id}) }
          RETURN b ORDER BY b.created_at DESC LIMIT 20
          `,
          { userId: user_id }
        );
        bookmarks = result.records.map(r => r.get('b').properties);
      }

      for (const bm of bookmarks) {
        const res = await session.run(
          `
          MATCH (u:User {id: $userId})
          MERGE (f:Flashcard {source: 'bookmark', source_id: $sourceId, user_id: $userId})
          ON CREATE SET
            f.id = randomUUID(),
            f.term = $term,
            f.definition = $definition,
            f.source_url = $sourceUrl,
            f.ease_factor = 2.5,
            f.interval_days = 0,
            f.repetitions = 0,
            f.next_review_at = datetime(),
            f.created_at = datetime()
          WITH f, u
          MATCH (f) WHERE f.created_at = datetime() OR f.created_at IS NOT NULL
          MERGE (u)-[:HAS_FLASHCARD]->(f)
          RETURN f
          `,
          {
            userId: user_id,
            term: sanitize(bm.title || bm.topic, 500),
            definition: sanitize(bm.notes || bm.topic || 'Bookmarked page', 5000),
            sourceId: String(bm.id),
            sourceUrl: sanitize(bm.url || '', 2000)
          }
        );
        if (res.records.length > 0) inserted++;
      }
    }

    if (source_type === 'item' || !source_type) {
      let items = [];
      if (source_ids && Array.isArray(source_ids) && source_ids.length > 0) {
        const result = await session.run(
          `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.id IN $sourceIds RETURN i`,
          { userId: user_id, sourceIds: source_ids.map(String) }
        );
        items = result.records.map(r => r.get('i').properties);
      } else {
        const result = await session.run(
          `
          MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
          WHERE NOT EXISTS { MATCH (u)-[:HAS_FLASHCARD]->(f:Flashcard {source: 'item', source_id: i.id}) }
          RETURN i ORDER BY i.created_at DESC LIMIT 20
          `,
          { userId: user_id }
        );
        items = result.records.map(r => r.get('i').properties);
      }

      for (const item of items) {
        const term = item.tags
          ? item.tags
              .split(',')
              .map(t => t.trim())
              .filter(Boolean)
              .slice(0, 3)
              .join(', ')
          : item.title || 'Saved item';
        const definition = item.ai_summary || (item.content ? item.content.slice(0, 300) : 'Saved item');
        
        const res = await session.run(
          `
          MATCH (u:User {id: $userId})
          MERGE (f:Flashcard {source: 'item', source_id: $sourceId, user_id: $userId})
          ON CREATE SET
            f.id = randomUUID(),
            f.term = $term,
            f.definition = $definition,
            f.source_url = $sourceUrl,
            f.ease_factor = 2.5,
            f.interval_days = 0,
            f.repetitions = 0,
            f.next_review_at = datetime(),
            f.created_at = datetime()
          WITH f, u
          MATCH (f) WHERE f.created_at = datetime() OR f.created_at IS NOT NULL
          MERGE (u)-[:HAS_FLASHCARD]->(f)
          RETURN f
          `,
          {
            userId: user_id,
            term: sanitize(term, 500),
            definition: sanitize(definition, 5000),
            sourceId: String(item.id),
            sourceUrl: sanitize(item.url || '', 2000)
          }
        );
        if (res.records.length > 0) inserted++;
      }
    }

    return res.json({ success: true, inserted });
  } catch (err) {
    console.error('[Generate Flashcards Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate flashcards.' });
  } finally {
    await session.close();
  }
});

module.exports = router;
