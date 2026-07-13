/**
 * easy-rewind — Active Recall Quiz Module (Neo4j)
 */

const express = require('express');
const router = express.Router();
const { getDb, getUserId } = require('./helpers');

// GET /api/quiz/random — Random item for recall
router.get('/quiz/random', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Try bookmarks first
    const bmRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_BOOKMARK]->(b:Bookmark)
       WHERE b.title IS NOT NULL AND b.title <> ''
       OPTIONAL MATCH (u)-[:HAS_QUIZ_RESULT]->(q:QuizResult {item_id: b.id, item_type: 'bookmark'})
         WHERE substring(toString(q.quizzed_at), 0, 10) = $today
       RETURN b, q.correct AS last_result
       ORDER BY rand() LIMIT 1`,
      { userId: user_id, today }
    );

    if (bmRes.records.length > 0) {
      const bookmark = bmRes.records[0].get('b').properties;
      const lastResult = bmRes.records[0].get('last_result');
      return res.json({
        type: 'bookmark',
        item_id: bookmark.id,
        prompt: bookmark.title,
        hint: bookmark.topic,
        created_at: bookmark.created_at,
        has_been_quizzed_today: lastResult !== null,
        answer: { url: bookmark.url, notes: bookmark.notes || '', topic: bookmark.topic },
      });
    }

    // Fall back to items
    const itemRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
       WHERE i.title IS NOT NULL AND i.title <> ''
       OPTIONAL MATCH (u)-[:HAS_QUIZ_RESULT]->(q:QuizResult {item_id: i.id, item_type: 'item'})
         WHERE substring(toString(q.quizzed_at), 0, 10) = $today
       RETURN i, q.correct AS last_result
       ORDER BY rand() LIMIT 1`,
      { userId: user_id, today }
    );

    if (itemRes.records.length > 0) {
      const item = itemRes.records[0].get('i').properties;
      const lastResult = itemRes.records[0].get('last_result');
      return res.json({
        type: 'item',
        item_id: item.id,
        prompt: item.title,
        hint: item.tags,
        created_at: item.created_at,
        has_been_quizzed_today: lastResult !== null,
        answer: { url: item.url, summary: item.ai_summary || '', tags: item.tags || '' },
      });
    }

    return res.json({
      type: null, item_id: null, prompt: null, hint: null, answer: null,
      message: 'No items to quiz. Save some bookmarks first!',
    });
  } catch (err) {
    console.error('[Quiz Random Error]', err.message);
    return res.status(500).json({ error: 'Failed to get quiz item.' });
  } finally {
    await session.close();
  }
});

// POST /api/quiz/answer — Record a quiz result
router.post('/quiz/answer', async (req, res) => {
  const { item_id, item_type, correct, time_spent_ms } = req.body;
  const user_id = getUserId(req);

  if (!item_id || !item_type) {
    return res.status(400).json({ error: 'item_id and item_type are required.' });
  }
  if (typeof correct !== 'boolean') {
    return res.status(400).json({ error: 'correct must be a boolean.' });
  }

  const database = getDb();
  const session = database.session();

  try {
    const now = new Date().toISOString();
    await session.run(
      `MERGE (u:User {id: $userId})
       CREATE (q:QuizResult {
         id: randomUUID(),
         item_id: $itemId,
         item_type: $itemType,
         correct: $correct,
         time_spent_ms: $timeSpent,
         quizzed_at: datetime()
       })
       CREATE (u)-[:HAS_QUIZ_RESULT]->(q)`,
      {
        userId: user_id,
        itemId: String(item_id),
        itemType: item_type,
        correct: correct ? 1 : 0,
        timeSpent: time_spent_ms || null
      }
    );
    return res.json({ success: true, recorded_at: now });
  } catch (err) {
    console.error('[Quiz Answer Error]', err.message);
    return res.status(500).json({ error: 'Failed to record answer.' });
  } finally {
    await session.close();
  }
});

// GET /api/quiz/stats — Today's quiz statistics
router.get('/quiz/stats', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const today = new Date().toISOString().slice(0, 10);

    const todayRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_QUIZ_RESULT]->(q:QuizResult)
       WHERE substring(toString(q.quizzed_at), 0, 10) = $today
       RETURN count(q) AS total,
              sum(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct_count,
              sum(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS incorrect_count`,
      { userId: user_id, today }
    );
    const allTimeRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_QUIZ_RESULT]->(q:QuizResult) RETURN count(q) AS total`,
      { userId: user_id }
    );
    const recentRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_QUIZ_RESULT]->(q:QuizResult)
       WHERE substring(toString(q.quizzed_at), 0, 10) = $today
       RETURN q.correct AS correct ORDER BY q.quizzed_at DESC`,
      { userId: user_id, today }
    );

    const row = todayRes.records[0];
    const total = row ? row.get('total').toNumber() : 0;
    const correct = row ? row.get('correct_count').toNumber() : 0;
    const incorrect = row ? row.get('incorrect_count').toNumber() : 0;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    let streak = 0;
    for (const r of recentRes.records) {
      if (r.get('correct') === 1) streak++;
      else break;
    }

    const allTime = allTimeRes.records[0] ? allTimeRes.records[0].get('total').toNumber() : 0;

    return res.json({
      today: { total, correct, incorrect, accuracy, streak },
      all_time: allTime,
    });
  } catch (err) {
    console.error('[Quiz Stats Error]', err.message);
    return res.status(500).json({ error: 'Failed to get quiz stats.' });
  } finally {
    await session.close();
  }
});

module.exports = router;
