/**
 * easy-rewind — Weekly Digest Module
 *
 * Generates and serves weekly digests of saved content: bookmarks, notes,
 * highlights, flashcards, and quiz activity. Optionally emails the digest
 * if SMTP is configured.
 *
 * Endpoints (all under /api):
 *   GET  /digest           — list recent digests
 *   GET  /digest/:id       — get a specific digest
 *   POST /digest/generate  — generate a new digest for the past week
 *   POST /digest/:id/send  — send a digest via email (if SMTP configured)
 *   GET  /digest/settings  — get digest preferences
 *   POST /digest/settings  — update digest preferences
 */

const express = require('express');
const router = express.Router();

const { config, getDb, getUserId, isValidId, callGemini, getGenAI, saveSettings } = require('./helpers');

// ─────────────────────────────────────────────
// GET /api/digest — List recent digests
// ─────────────────────────────────────────────
router.get('/digest', (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();

  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const digests = database
      .prepare(
        `
      SELECT id, title, period_start, period_end, bookmark_count, note_count,
             highlight_count, flashcard_count, quiz_accuracy, sent_at, created_at
      FROM digests
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(user_id, limit, offset);

    const total = database
      .prepare(
        `
      SELECT COUNT(*) as count FROM digests WHERE user_id = ?
    `
      )
      .get(user_id);

    return res.json({
      digests,
      total: total?.count || 0,
      has_more: offset + limit < (total?.count || 0),
    });
  } catch (err) {
    console.error('[Digest List Error]', err.message);
    return res.status(500).json({ error: 'Failed to list digests.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/digest/:id — Get a specific digest
// ─────────────────────────────────────────────
router.get('/digest/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: 'Invalid digest ID.' });

  const user_id = getUserId(req);
  const database = getDb();

  try {
    const digest = database
      .prepare(
        `
      SELECT * FROM digests WHERE id = ? AND user_id = ?
    `
      )
      .get(id, user_id);

    if (!digest) return res.status(404).json({ error: 'Digest not found.' });

    // Parse JSON fields for the client
    try {
      digest.top_topics = JSON.parse(digest.top_topics || '[]');
      digest.top_items = JSON.parse(digest.top_items || '[]');
    } catch (_) {
      digest.top_topics = [];
      digest.top_items = [];
    }

    return res.json({ digest });
  } catch (err) {
    console.error('[Digest Get Error]', err.message);
    return res.status(500).json({ error: 'Failed to get digest.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/digest/generate — Generate a new digest
// ─────────────────────────────────────────────
router.post('/digest/generate', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  try {
    // Check if a digest already exists for this period
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Gather stats for the period
    const bookmarkCount =
      database
        .prepare(
          `
      SELECT COUNT(*) as count FROM bookmarks
      WHERE user_id = ? AND created_at >= ?
    `
        )
        .get(user_id, periodStart)?.count || 0;

    const noteCount =
      database
        .prepare(
          `
      SELECT COUNT(*) as count FROM notes
      WHERE user_id = ? AND created_at >= ?
    `
        )
        .get(user_id, periodStart)?.count || 0;

    const highlightCount =
      database
        .prepare(
          `
      SELECT COUNT(*) as count FROM highlights
      WHERE user_id = ? AND created_at >= ?
    `
        )
        .get(user_id, periodStart)?.count || 0;

    const flashcardCount =
      database
        .prepare(
          `
      SELECT COUNT(*) as count FROM flashcards
      WHERE user_id = ? AND created_at >= ?
    `
        )
        .get(user_id, periodStart)?.count || 0;

    const quizStats = database
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as correct
      FROM quiz_results
      WHERE user_id = ? AND quizzed_at >= ?
    `
      )
      .get(user_id, periodStart);
    const quizAccuracy =
      (quizStats?.total || 0) > 0 ? Math.round(((quizStats?.correct || 0) / quizStats.total) * 100) : 0;

    // Get top topics (most-used bookmark topics)
    const topTopics = database
      .prepare(
        `
      SELECT topic, COUNT(*) as count
      FROM bookmarks
      WHERE user_id = ? AND created_at >= ?
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 10
    `
      )
      .all(user_id, periodStart);

    // Get top items (highest memory_score from items created in period)
    const topItems = database
      .prepare(
        `
      SELECT id, title, url, ai_summary, tags, source_type, memory_score, created_at
      FROM items
      WHERE user_id = ? AND created_at >= ?
      ORDER BY memory_score DESC
      LIMIT 10
    `
      )
      .all(user_id, periodStart);

    // Build the digest title
    const periodLabel = days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : `${days}-Day`;
    const title = `${periodLabel} Digest — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Generate AI summary if content exists
    let summary = '';
    const totalItems = bookmarkCount + noteCount + highlightCount;
    if (totalItems > 0) {
      const ai = getGenAI();
      if (ai) {
        const topicsStr = topTopics.map(t => `${t.topic} (${t.count})`).join(', ');
        try {
          const prompt = `You are a personal knowledge assistant. Summarize this user's weekly learning digest in 2-3 engaging sentences.

Activity this week:
- ${bookmarkCount} bookmarks saved
- ${noteCount} notes taken
- ${highlightCount} highlights captured
- ${flashcardCount} flashcards created
- Quiz accuracy: ${quizAccuracy}%

Topics explored: ${topicsStr || 'various'}
Top saved items: ${
            topItems
              .slice(0, 5)
              .map(i => i.title)
              .filter(Boolean)
              .join(', ') || 'none'
          }

Write a friendly, encouraging summary that highlights what they've learned this week. Keep it to 2-3 sentences, don't overhype.`;

          summary = await callGemini(prompt);
          if (summary) summary = summary.slice(0, 1000);
        } catch (_) {
          // Fallback summary
          summary = `You saved ${bookmarkCount} bookmarks, took ${noteCount} notes, captured ${highlightCount} highlights, and created ${flashcardCount} flashcards. ${quizStats?.total > 0 ? `Quiz accuracy: ${quizAccuracy}%.` : ''}`;
        }
      } else {
        summary = `You saved ${bookmarkCount} bookmarks, took ${noteCount} notes, captured ${highlightCount} highlights, and created ${flashcardCount} flashcards. ${quizStats?.total > 0 ? `Quiz accuracy: ${quizAccuracy}%.` : ''}`;
      }
    }

    // Build top_topics and top_items as JSON strings
    const topTopicsJson = JSON.stringify(topTopics.map(t => ({ topic: t.topic, count: t.count })));
    const topItemsJson = JSON.stringify(
      topItems.map(i => ({
        id: i.id,
        title: i.title,
        url: i.url,
        tags: i.tags,
        source_type: i.source_type,
        memory_score: i.memory_score,
      }))
    );

    // Insert the digest
    const result = database
      .prepare(
        `
      INSERT INTO digests (user_id, title, summary, period_start, period_end,
        bookmark_count, note_count, highlight_count, flashcard_count, quiz_accuracy,
        top_topics, top_items)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        user_id,
        title,
        summary,
        periodStart,
        periodEnd,
        bookmarkCount,
        noteCount,
        highlightCount,
        flashcardCount,
        quizAccuracy,
        topTopicsJson,
        topItemsJson
      );

    const digest = database.prepare('SELECT * FROM digests WHERE id = ?').get(result.lastInsertRowid);

    return res.json({
      success: true,
      digest: {
        ...digest,
        top_topics: topTopics,
        top_items: topItems,
      },
    });
  } catch (err) {
    console.error('[Digest Generate Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate digest.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/digest/:id/send — Send digest via email (if SMTP configured)
// ─────────────────────────────────────────────
router.post('/digest/:id/send', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: 'Invalid digest ID.' });

  const user_id = getUserId(req);
  const database = getDb();

  try {
    const digest = database
      .prepare(
        `
      SELECT * FROM digests WHERE id = ? AND user_id = ?
    `
      )
      .get(id, user_id);

    if (!digest) return res.status(404).json({ error: 'Digest not found.' });
    if (digest.sent_at) return res.json({ message: 'Digest already sent.', sent_at: digest.sent_at });

    // Check if email sending is available
    let sent = false;
    try {
      const nodemailer = require('nodemailer');
      const smtpConfig = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      };
      const toEmail = process.env.DIGEST_EMAIL;

      if (smtpConfig.host && smtpConfig.auth.user && smtpConfig.auth.pass && toEmail) {
        const transporter = nodemailer.createTransport(smtpConfig);

        const topItems = JSON.parse(digest.top_items || '[]');
        const itemsHtml = topItems
          .map(
            i =>
              `<li><a href="${i.url || '#'}">${i.title || 'Untitled'}</a> ${i.tags ? `<span style="color:#888;">[${i.tags}]</span>` : ''}</li>`
          )
          .join('');

        const html = `
          <div style="font-family: Inter, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #a78bfa;">${digest.title}</h1>
            <p style="color: #ccc; font-size: 14px;">${digest.summary || ''}</p>
            <hr style="border-color: #333;" />
            <h2>Activity Overview</h2>
            <ul style="color: #ccc;">
              <li>Bookmarks: ${digest.bookmark_count}</li>
              <li>Notes: ${digest.note_count}</li>
              <li>Highlights: ${digest.highlight_count}</li>
              <li>Flashcards: ${digest.flashcard_count}</li>
              ${digest.quiz_accuracy > 0 ? `<li>Quiz Accuracy: ${digest.quiz_accuracy}%</li>` : ''}
            </ul>
            ${topItems.length ? `<h2>Top Saved Items</h2><ul>${itemsHtml}</ul>` : ''}
            <hr style="border-color: #333;" />
            <p style="color: #666; font-size: 12px;">Generated by easy-rewind Learning Assistant</p>
          </div>
        `;

        await transporter.sendMail({
          from: smtpConfig.auth.user,
          to: toEmail,
          subject: digest.title,
          html,
        });

        sent = true;
      } else {
        return res.json({
          message:
            'Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and DIGEST_EMAIL in .env to enable email delivery.',
          configurable: true,
        });
      }
    } catch (emailErr) {
      console.error('[Digest Send Error]', emailErr.message);
      return res.json({
        message: 'Email delivery failed. Check your SMTP configuration.',
        error: emailErr.message,
        configurable: true,
      });
    }

    if (sent) {
      database.prepare('UPDATE digests SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return res.json({ success: true, sent_at: new Date().toISOString() });
    }
  } catch (err) {
    console.error('[Digest Send Error]', err.message);
    return res.status(500).json({ error: 'Failed to send digest.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/digest/settings — Get digest preferences
// ─────────────────────────────────────────────
router.get('/digest/settings', (req, res) => {
  const defaults = {
    enabled: true,
    frequency: 'weekly',
    day_of_week: 0,
    hour: 9,
    include_bookmarks: true,
    include_notes: true,
    include_highlights: true,
    include_flashcards: true,
    include_quiz: true,
    include_ai_summary: true,
    send_email: false,
    last_digest_at: null,
  };

  const saved = config.digestPrefs || {};
  return res.json({ settings: { ...defaults, ...saved } });
});

// ─────────────────────────────────────────────
// POST /api/digest/settings — Update digest preferences
// ─────────────────────────────────────────────
router.post('/digest/settings', (req, res) => {
  const allowedKeys = [
    'enabled',
    'frequency',
    'day_of_week',
    'hour',
    'include_bookmarks',
    'include_notes',
    'include_highlights',
    'include_flashcards',
    'include_quiz',
    'include_ai_summary',
    'send_email',
  ];

  const prefs = { ...(config.digestPrefs || {}) };
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      prefs[key] = req.body[key];
    }
  }

  config.digestPrefs = prefs;
  saveSettings();

  return res.json({ success: true, settings: prefs });
});

module.exports = router;
