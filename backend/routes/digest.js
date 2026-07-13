/**
 * easy-rewind — Weekly Digest Module (Neo4j)
 */

const express = require('express');
const router = express.Router();
const neo4j = require('neo4j-driver');

const { config, getDb, getUserId, callGemini, getGenAI, saveSettings } = require('./helpers');

// GET /api/digest — List recent digests
router.get('/digest', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const dataRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_DIGEST]->(d:Digest) RETURN d ORDER BY d.created_at DESC SKIP $skip LIMIT $limit`,
      { userId: user_id, skip: neo4j.int(offset), limit: neo4j.int(limit) }
    );
    const countRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_DIGEST]->(d:Digest) RETURN count(d) AS c`,
      { userId: user_id }
    );

    const digests = dataRes.records.map(r => r.get('d').properties);
    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;

    return res.json({ digests, total, has_more: offset + limit < total });
  } catch (err) {
    console.error('[Digest List Error]', err.message);
    return res.status(500).json({ error: 'Failed to list digests.' });
  } finally {
    await session.close();
  }
});

// GET /api/digest/:id — Get a specific digest
router.get('/digest/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_DIGEST]->(d:Digest {id: $id}) RETURN d`,
      { userId: user_id, id: String(id) }
    );

    if (result.records.length === 0) return res.status(404).json({ error: 'Digest not found.' });

    const digest = result.records[0].get('d').properties;
    try { digest.top_topics = JSON.parse(digest.top_topics || '[]'); } catch (_) { digest.top_topics = []; }
    try { digest.top_items = JSON.parse(digest.top_items || '[]'); } catch (_) { digest.top_items = []; }

    return res.json({ digest });
  } catch (err) {
    console.error('[Digest Get Error]', err.message);
    return res.status(500).json({ error: 'Failed to get digest.' });
  } finally {
    await session.close();
  }
});

// POST /api/digest/generate — Generate a new digest
router.post('/digest/generate', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  try {
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const bmRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_BOOKMARK]->(b:Bookmark) WHERE b.created_at >= datetime($since) RETURN count(b) AS c`, { uid: user_id, since: periodStart });
    const noteRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_NOTE]->(n:Note) WHERE n.created_at >= datetime($since) RETURN count(n) AS c`, { uid: user_id, since: periodStart });
    const hlRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) WHERE h.created_at >= datetime($since) RETURN count(h) AS c`, { uid: user_id, since: periodStart });
    const fcRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_FLASHCARD]->(f:Flashcard) WHERE f.created_at >= datetime($since) RETURN count(f) AS c`, { uid: user_id, since: periodStart });
    const quizRes = await session.run(
      `MATCH (u:User {id: $uid})-[:HAS_QUIZ_RESULT]->(q:QuizResult) WHERE q.quizzed_at >= datetime($since)
       RETURN count(q) AS total, sum(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct`,
      { uid: user_id, since: periodStart }
    );
    const topicsRes = await session.run(
      `MATCH (u:User {id: $uid})-[:HAS_BOOKMARK]->(b:Bookmark) WHERE b.created_at >= datetime($since) AND b.topic IS NOT NULL
       RETURN b.topic AS topic, count(b) AS c ORDER BY c DESC LIMIT 10`,
      { uid: user_id, since: periodStart }
    );
    const topItemsRes = await session.run(
      `MATCH (u:User {id: $uid})-[:HAS_ITEM]->(i:Item) WHERE i.created_at >= datetime($since)
       RETURN i ORDER BY i.memory_score DESC LIMIT 10`,
      { uid: user_id, since: periodStart }
    );

    const bookmarkCount = bmRes.records[0] ? bmRes.records[0].get('c').toNumber() : 0;
    const noteCount = noteRes.records[0] ? noteRes.records[0].get('c').toNumber() : 0;
    const highlightCount = hlRes.records[0] ? hlRes.records[0].get('c').toNumber() : 0;
    const flashcardCount = fcRes.records[0] ? fcRes.records[0].get('c').toNumber() : 0;

    const quizRow = quizRes.records[0];
    const quizTotal = quizRow ? quizRow.get('total').toNumber() : 0;
    const quizCorrect = quizRow ? quizRow.get('correct').toNumber() : 0;
    const quizAccuracy = quizTotal > 0 ? Math.round((quizCorrect / quizTotal) * 100) : 0;

    const topTopics = topicsRes.records.map(r => ({ topic: r.get('topic'), count: r.get('c').toNumber() }));
    const topItems = topItemsRes.records.map(r => r.get('i').properties);

    const periodLabel = days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : `${days}-Day`;
    const title = `${periodLabel} Digest — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    let summary = '';
    const totalItems = bookmarkCount + noteCount + highlightCount;
    if (totalItems > 0) {
      const ai = getGenAI();
      if (ai) {
        const topicsStr = topTopics.map(t => `${t.topic} (${t.count})`).join(', ');
        try {
          const prompt = `You are a personal knowledge assistant. Summarize this user's weekly learning digest in 2-3 engaging sentences.\n\nActivity this week:\n- ${bookmarkCount} bookmarks saved\n- ${noteCount} notes taken\n- ${highlightCount} highlights captured\n- ${flashcardCount} flashcards created\n- Quiz accuracy: ${quizAccuracy}%\n\nTopics explored: ${topicsStr || 'various'}\nTop saved items: ${topItems.slice(0, 5).map(i => i.title).filter(Boolean).join(', ') || 'none'}\n\nWrite a friendly, encouraging summary that highlights what they've learned this week. Keep it to 2-3 sentences, don't overhype.`;
          summary = await callGemini(prompt);
          if (summary) summary = summary.slice(0, 1000);
        } catch (_) {
          summary = `You saved ${bookmarkCount} bookmarks, took ${noteCount} notes, captured ${highlightCount} highlights, and created ${flashcardCount} flashcards. ${quizTotal > 0 ? `Quiz accuracy: ${quizAccuracy}%.` : ''}`;
        }
      } else {
        summary = `You saved ${bookmarkCount} bookmarks, took ${noteCount} notes, captured ${highlightCount} highlights, and created ${flashcardCount} flashcards. ${quizTotal > 0 ? `Quiz accuracy: ${quizAccuracy}%.` : ''}`;
      }
    }

    const topTopicsJson = JSON.stringify(topTopics);
    const topItemsJson = JSON.stringify(topItems.map(i => ({ id: i.id, title: i.title, url: i.url, tags: i.tags, source_type: i.source_type, memory_score: i.memory_score })));

    const createRes = await session.run(
      `MERGE (u:User {id: $userId})
       CREATE (d:Digest {
         id: randomUUID(),
         title: $title,
         summary: $summary,
         period_start: datetime($periodStart),
         period_end: datetime($periodEnd),
         bookmark_count: $bookmarkCount,
         note_count: $noteCount,
         highlight_count: $highlightCount,
         flashcard_count: $flashcardCount,
         quiz_accuracy: $quizAccuracy,
         top_topics: $topTopics,
         top_items: $topItems,
         created_at: datetime()
       })
       CREATE (u)-[:HAS_DIGEST]->(d)
       RETURN d`,
      {
        userId: user_id, title, summary,
        periodStart, periodEnd,
        bookmarkCount: neo4j.int(bookmarkCount), noteCount: neo4j.int(noteCount),
        highlightCount: neo4j.int(highlightCount), flashcardCount: neo4j.int(flashcardCount),
        quizAccuracy: neo4j.int(quizAccuracy),
        topTopics: topTopicsJson, topItems: topItemsJson
      }
    );

    const digest = createRes.records[0] ? createRes.records[0].get('d').properties : null;

    return res.json({ success: true, digest: { ...digest, top_topics: topTopics, top_items: topItems } });
  } catch (err) {
    console.error('[Digest Generate Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate digest.' });
  } finally {
    await session.close();
  }
});

// POST /api/digest/:id/send — Send digest via email
router.post('/digest/:id/send', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_DIGEST]->(d:Digest {id: $id}) RETURN d`,
      { userId: user_id, id: String(id) }
    );

    if (result.records.length === 0) return res.status(404).json({ error: 'Digest not found.' });

    const digest = result.records[0].get('d').properties;
    if (digest.sent_at) return res.json({ message: 'Digest already sent.', sent_at: digest.sent_at });

    let sent = false;
    try {
      const nodemailer = require('nodemailer');
      const smtpConfig = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      };
      const toEmail = process.env.DIGEST_EMAIL;

      if (smtpConfig.host && smtpConfig.auth.user && smtpConfig.auth.pass && toEmail) {
        const transporter = nodemailer.createTransport(smtpConfig);
        const topItems = JSON.parse(digest.top_items || '[]');
        const itemsHtml = topItems.map(i => `<li><a href="${i.url || '#'}">${i.title || 'Untitled'}</a> ${i.tags ? `<span style="color:#888;">[${i.tags}]</span>` : ''}</li>`).join('');
        const html = `<div style="font-family: Inter, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;"><h1 style="color: #a78bfa;">${digest.title}</h1><p style="color: #ccc; font-size: 14px;">${digest.summary || ''}</p><hr style="border-color: #333;" /><h2>Activity Overview</h2><ul style="color: #ccc;"><li>Bookmarks: ${digest.bookmark_count}</li><li>Notes: ${digest.note_count}</li><li>Highlights: ${digest.highlight_count}</li><li>Flashcards: ${digest.flashcard_count}</li>${digest.quiz_accuracy > 0 ? `<li>Quiz Accuracy: ${digest.quiz_accuracy}%</li>` : ''}</ul>${topItems.length ? `<h2>Top Saved Items</h2><ul>${itemsHtml}</ul>` : ''}<hr style="border-color: #333;" /><p style="color: #666; font-size: 12px;">Generated by easy-rewind Learning Assistant</p></div>`;
        await transporter.sendMail({ from: smtpConfig.auth.user, to: toEmail, subject: digest.title, html });
        sent = true;
      } else {
        return res.json({ message: 'Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and DIGEST_EMAIL in .env to enable email delivery.', configurable: true });
      }
    } catch (emailErr) {
      console.error('[Digest Send Error]', emailErr.message);
      return res.json({ message: 'Email delivery failed. Check your SMTP configuration.', error: emailErr.message, configurable: true });
    }

    if (sent) {
      const sentAt = new Date().toISOString();
      await session.run(`MATCH (d:Digest {id: $id}) SET d.sent_at = datetime($sentAt)`, { id: String(id), sentAt });
      return res.json({ success: true, sent_at: sentAt });
    }
  } catch (err) {
    console.error('[Digest Send Error]', err.message);
    return res.status(500).json({ error: 'Failed to send digest.' });
  } finally {
    await session.close();
  }
});

// GET /api/digest/settings
router.get('/digest/settings', (req, res) => {
  const defaults = {
    enabled: true, frequency: 'weekly', day_of_week: 0, hour: 9,
    include_bookmarks: true, include_notes: true, include_highlights: true,
    include_flashcards: true, include_quiz: true, include_ai_summary: true,
    send_email: false, last_digest_at: null,
  };
  return res.json({ settings: { ...defaults, ...(config.digestPrefs || {}) } });
});

// POST /api/digest/settings
router.post('/digest/settings', (req, res) => {
  const allowedKeys = ['enabled', 'frequency', 'day_of_week', 'hour', 'include_bookmarks', 'include_notes', 'include_highlights', 'include_flashcards', 'include_quiz', 'include_ai_summary', 'send_email'];
  const prefs = { ...(config.digestPrefs || {}) };
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) prefs[key] = req.body[key];
  }
  config.digestPrefs = prefs;
  saveSettings();
  return res.json({ success: true, settings: prefs });
});

module.exports = router;
