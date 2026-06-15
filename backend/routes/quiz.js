/**
 * easy-rewind — Active Recall Quiz Module
 *
 * Spaced active recall: picks random bookmarks/items and quizzes the user
 * on what they've saved. Tracks accuracy, streak, and daily stats.
 *
 * Endpoints (all under /api):
 *   GET  /quiz/random  — random unquizzed bookmark or item
 *   POST /quiz/answer  — record correct/incorrect
 *   GET  /quiz/stats   — today's quiz stats
 */

const express = require('express');
const router = express.Router();

const { getDb, getUserId, sanitize, isValidId } = require('./helpers');

// ─────────────────────────────────────────────
// GET /api/quiz/random — Random item for recall
// ─────────────────────────────────────────────
router.get('/quiz/random', (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();

  try {
    // Pick a random bookmark that the user hasn't quizzed today
    const today = new Date().toISOString().slice(0, 10);

    // Try bookmarks first (more likely to have meaningful titles/topics)
    const bookmark = database
      .prepare(
        `
      SELECT b.id, b.url, b.title, b.topic, b.notes, b.created_at,
             COALESCE(q.correct, NULL) as last_result
      FROM bookmarks b
      LEFT JOIN quiz_results q ON q.item_id = b.id AND q.item_type = 'bookmark'
        AND date(q.quizzed_at) = ?
      WHERE b.user_id = ? AND b.title != ''
      ORDER BY RANDOM()
      LIMIT 1
    `
      )
      .get(today, user_id);

    if (bookmark) {
      // Return the title/topic as the prompt; hide notes/url until reveal
      return res.json({
        type: 'bookmark',
        item_id: bookmark.id,
        prompt: bookmark.title,
        hint: bookmark.topic,
        created_at: bookmark.created_at,
        has_been_quizzed_today: bookmark.last_result !== null,
        // Full details sent only on reveal (client asks separately)
        answer: {
          url: bookmark.url,
          notes: bookmark.notes || '',
          topic: bookmark.topic,
        },
      });
    }

    // Fall back to items (AI-summarized memories)
    const item = database
      .prepare(
        `
      SELECT i.id, i.title, i.tags, i.url, i.ai_summary, i.created_at,
             COALESCE(q.correct, NULL) as last_result
      FROM items i
      LEFT JOIN quiz_results q ON q.item_id = i.id AND q.item_type = 'item'
        AND date(q.quizzed_at) = ?
      WHERE i.user_id = ? AND i.title != ''
      ORDER BY RANDOM()
      LIMIT 1
    `
      )
      .get(today, user_id);

    if (item) {
      return res.json({
        type: 'item',
        item_id: item.id,
        prompt: item.title,
        hint: item.tags,
        created_at: item.created_at,
        has_been_quizzed_today: item.last_result !== null,
        answer: {
          url: item.url,
          summary: item.ai_summary || '',
          tags: item.tags || '',
        },
      });
    }

    // Nothing to quiz
    return res.json({
      type: null,
      item_id: null,
      prompt: null,
      hint: null,
      answer: null,
      message: 'No items to quiz. Save some bookmarks first!',
    });
  } catch (err) {
    console.error('[Quiz Random Error]', err.message);
    return res.status(500).json({ error: 'Failed to get quiz item.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/quiz/answer — Record a quiz result
// ─────────────────────────────────────────────
router.post('/quiz/answer', (req, res) => {
  const { item_id, item_type, correct, time_spent_ms } = req.body;
  const user_id = getUserId(req);

  if (!item_id || !item_type) {
    return res.status(400).json({ error: 'item_id and item_type are required.' });
  }

  if (typeof correct !== 'boolean') {
    return res.status(400).json({ error: 'correct must be a boolean.' });
  }

  const database = getDb();

  try {
    const now = new Date().toISOString();
    database
      .prepare(
        `
      INSERT INTO quiz_results (user_id, item_id, item_type, correct, time_spent_ms, quizzed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(user_id, item_id, item_type, correct ? 1 : 0, time_spent_ms || null, now);

    return res.json({ success: true, recorded_at: now });
  } catch (err) {
    console.error('[Quiz Answer Error]', err.message);
    return res.status(500).json({ error: 'Failed to record answer.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/quiz/stats — Today's quiz statistics
// ─────────────────────────────────────────────
router.get('/quiz/stats', (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();

  try {
    const today = new Date().toISOString().slice(0, 10);

    const row = database
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as correct_count,
        SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) as incorrect_count
      FROM quiz_results
      WHERE user_id = ? AND date(quizzed_at) = ?
    `
      )
      .get(user_id, today);

    // Calculate current streak (consecutive correct answers today)
    const recentResults = database
      .prepare(
        `
      SELECT correct FROM quiz_results
      WHERE user_id = ? AND date(quizzed_at) = ?
      ORDER BY quizzed_at DESC
    `
      )
      .all(user_id, today);

    let streak = 0;
    for (const r of recentResults) {
      if (r.correct === 1) streak++;
      else break;
    }

    const total = row?.total || 0;
    const correct = row?.correct_count || 0;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    return res.json({
      today: {
        total,
        correct,
        incorrect: row?.incorrect_count || 0,
        accuracy,
        streak,
      },
      all_time:
        database
          .prepare(
            `
        SELECT COUNT(*) as total FROM quiz_results WHERE user_id = ?
      `
          )
          .get(user_id)?.total || 0,
    });
  } catch (err) {
    console.error('[Quiz Stats Error]', err.message);
    return res.status(500).json({ error: 'Failed to get quiz stats.' });
  }
});

module.exports = router;
