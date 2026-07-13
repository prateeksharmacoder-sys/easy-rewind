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
  saveSettings,
} = require('./helpers');

const neo4j = require('neo4j-driver');
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// ─────────────────────────────────────────────
// GET /api/health — Server health check
// ─────────────────────────────────────────────
router.get('/health', async (req, res) => {
  const database = getDb();
  let dbOk = false;
  try {
    const session = database.session();
    await session.run('RETURN 1');
    await session.close();
    dbOk = true;
  } catch (_) {}
  res.json({
    status: 'ok',
    service: 'easy-rewind Learning Assistant API',
    timestamp: new Date().toISOString(),
    version: '2.0.1',
    storage: 'neo4j',
    storage_ready: dbOk,
    ai_configured: !!getGenAI(),
  });
});

// ─────────────────────────────────────────────
// POST /api/session — Create or resume a client session
// ─────────────────────────────────────────────
router.post('/session', async (req, res) => {
  const { client_id, device, client_type } = req.body || {};
  const userId = config.profileUserId || 'anonymous';

  // Migrate any data saved under 'anonymous' to canonical user ID
  if (userId !== 'anonymous') {
    try {
      const database = getDb();
      const session = database.session();
      try {
        const labels = ['Bookmark', 'Item', 'Note', 'Reminder', 'Highlight', 'ResearchQueue', 'SearchLog'];
        for (const label of labels) {
          await session.run(
            `MATCH (old:User {id: 'anonymous'})-[r]->(n:${label})
             MERGE (u:User {id: $userId})
             CREATE (u)-[r2]->(n)
             DELETE r`,
            { userId }
          );
        }
      } finally {
        await session.close();
      }
    } catch (_) {}
  }

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
router.post('/users/merge', async (req, res) => {
  const database = getDb();
  const session = database.session();
  const targetUserId = sanitizeUserId(req.body?.to_user_id || config.profileUserId);
  const sourceUserId = sanitizeUserId(req.body?.from_user_id);

  if (!sourceUserId || sourceUserId === targetUserId) {
    return res.json({ success: true, merged: false, user_id: targetUserId });
  }

  try {
    const labels = ['Bookmark', 'Item', 'Note', 'Reminder', 'Highlight', 'ResearchQueue', 'SearchLog'];
    const merged = {};
    const relNames = { Bookmark: 'HAS_BOOKMARK', Item: 'HAS_ITEM', Note: 'HAS_NOTE', Reminder: 'HAS_REMINDER', Highlight: 'HAS_HIGHLIGHT', ResearchQueue: 'HAS_RESEARCH', SearchLog: 'HAS_SEARCH_LOG' };

    for (const label of labels) {
      const rel = relNames[label];
      const countRes = await session.run(
        `MATCH (src:User {id: $src})-[:${rel}]->(n:${label}) RETURN count(n) AS c`,
        { src: sourceUserId }
      );
      const count = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;
      if (count > 0) {
        await session.run(
          `MATCH (src:User {id: $src})-[r:${rel}]->(n:${label})
           MERGE (tgt:User {id: $tgt})
           MERGE (tgt)-[:${rel}]->(n)
           DELETE r`,
          { src: sourceUserId, tgt: targetUserId }
        );
      }
      merged[label.toLowerCase()] = count;
    }

    return res.json({ success: true, merged: true, user_id: targetUserId, merged_counts: merged });
  } catch (err) {
    console.error('[Merge Users Error]', err.message);
    return res.status(500).json({ error: 'Failed to merge users.' });
  } finally {
    await session.close();
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
  const session = database.session();

  try {
    const result = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (r:ResearchQueue {
        id: randomUUID(),
        url: $url,
        title: $title,
        user_notes: $userNotes,
        status: 'pending',
        created_at: datetime()
      })
      CREATE (u)-[:HAS_RESEARCH]->(r)
      RETURN r
      `,
      { userId: user_id, url: sanitize(url, 2000), title: sanitize(title || url, 500), userNotes: sanitize(user_notes || '', 1000) }
    );

    const research = result.records[0] ? result.records[0].get('r').properties : null;

    if (auto_process !== false && research) {
      processResearch(research.id, url, title, user_notes, user_id, database).catch(err => {
        console.warn('[Research Process Error]', err.message);
      });
    }

    return res.json({ success: true, research });
  } catch (err) {
    console.error('[Research Queue Error]', err.message);
    return res.status(500).json({ error: 'Failed to queue research.' });
  } finally {
    await session.close();
  }
});

async function processResearch(id, url, title, userNotes, userId, database) {
  const session = database.session();
  try {
    await session.run(`MATCH (r:ResearchQueue {id: $id}) SET r.status = 'processing'`, { id });

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
      await session.run(`MATCH (r:ResearchQueue {id: $id}) SET r.status = 'failed', r.error_message = 'AI not configured'`, { id });
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

    await session.run(
      `MATCH (r:ResearchQueue {id: $id}) SET r.status = 'done', r.research_result = $result, r.completed_at = datetime()`,
      { id, result: analysis }
    );

    // Also upsert to items for future AI summary access
    try {
      const existingRes = await session.run(
        `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {url: $url}) RETURN i`,
        { userId, url: sanitize(url, 2000) }
      );
      if (existingRes.records.length > 0) {
        const existingId = existingRes.records[0].get('i').properties.id;
        await session.run(`MATCH (i:Item {id: $id}) SET i.ai_summary = $summary, i.updated_at = datetime()`, { id: existingId, summary: analysis });
        console.log('[Research] Updated item', existingId, 'with AI summary');
      } else {
        await session.run(
          `
          MERGE (u:User {id: $userId})
          CREATE (i:Item {
            id: randomUUID(),
            url: $url,
            title: $title,
            content: $content,
            ai_summary: $summary,
            tags: '',
            source_type: 'web',
            memory_score: 1.0,
            interaction_count: 0,
            created_at: datetime(),
            updated_at: datetime()
          })
          CREATE (u)-[:HAS_ITEM]->(i)
          `,
          { userId, url: sanitize(url, 2000), title: sanitize(title || url, 500), content: (pageContent || '').slice(0, 2000), summary: analysis }
        );
        console.log('[Research] Created item with AI summary');
      }
    } catch (itemErr) {
      console.warn('[Research] Failed to save to items:', itemErr.message);
    }

    // Create reminder
    await session.run(
      `
      MATCH (u:User {id: $userId})
      CREATE (rem:Reminder {
        id: randomUUID(),
        reminder_type: 'research_done',
        reference_type: 'research',
        reference_id: $refId,
        title: $title,
        message: 'Your AI deep research has been completed.',
        remind_at: datetime() + duration({minutes: 5}),
        reminded: 0,
        dismissed: 0,
        created_at: datetime()
      })
      CREATE (u)-[:HAS_REMINDER]->(rem)
      `,
      { userId, refId: id, title: `📖 Research ready: ${sanitize(title || 'Untitled', 100)}` }
    );

    console.log(`[Research] Completed for ID ${id}: "${title}"`);
  } catch (err) {
    console.error('[Research Process Error]', err.message);
    try {
      await session.run(`MATCH (r:ResearchQueue {id: $id}) SET r.status = 'failed', r.error_message = $msg`, { id, msg: err.message });
    } catch (_) {}
  } finally {
    await session.close();
  }
}

// GET /api/research — Get research results
router.get('/research', async (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const database = getDb();
  const session = database.session();

  try {
    const countRes = await session.run(`MATCH (u:User {id: $userId})-[:HAS_RESEARCH]->(r:ResearchQueue) RETURN count(r) AS c`, { userId: user_id });
    const dataRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_RESEARCH]->(r:ResearchQueue) RETURN r ORDER BY r.created_at DESC SKIP $skip LIMIT $limit`,
      { userId: user_id, skip: neo4j.int(offset), limit: neo4j.int(limit) }
    );

    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;
    const research = dataRes.records.map(r => r.get('r').properties);

    return res.json({ research: research || [], total });
  } catch (err) {
    console.error('[Get Research Error]', err.message);
    return res.status(500).json({ error: 'Failed to load research.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// PAGE FETCH PROXY (for popup summarize fallback)
// ═════════════════════════════════════════════

// GET /api/fetch-page-content — Fetch a page and return its text content
router.get('/fetch-page-content', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL parameter is required.' });
  }
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; easy-rewind/1.0)' },
    });
    const html = response.data;
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return res.json({ url, content: text.slice(0, 8000) });
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch page: ${err.message}` });
  }
});

// ═════════════════════════════════════════════
// PUSH SUBSCRIPTION ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/push-subscribe — Register a device for push notifications
router.post('/push-subscribe', async (req, res) => {
  const { platform, subscription_json, device_name } = req.body;
  const user_id = getUserId(req);

  if (!platform || !subscription_json) {
    return res.status(400).json({ error: 'Platform and subscription_json are required.' });
  }

  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (ps:PushSubscription {
        id: randomUUID(),
        platform: $platform,
        subscription_json: $subscriptionJson,
        device_name: $deviceName,
        last_active: datetime(),
        created_at: datetime()
      })
      CREATE (u)-[:HAS_PUSH_SUBSCRIPTION]->(ps)
      RETURN ps
      `,
      {
        userId: user_id,
        platform: sanitize(platform, 20),
        subscriptionJson: typeof subscription_json === 'string' ? subscription_json : JSON.stringify(subscription_json),
        deviceName: sanitize(device_name || '', 100)
      }
    );

    const subscription = result.records[0] ? result.records[0].get('ps').properties : null;
    return res.json({ success: true, subscription });
  } catch (err) {
    console.error('[Push Subscribe Error]', err.message);
    return res.status(500).json({ error: 'Failed to register device.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/push-subscribe/:id — Unsubscribe
router.delete('/push-subscribe/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);

  const database = getDb();
  const session = database.session();

  try {
    await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_PUSH_SUBSCRIPTION]->(ps:PushSubscription {id: $id}) DETACH DELETE ps`,
      { userId: user_id, id: String(id) }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to unsubscribe.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// EXPORT / IMPORT ENDPOINTS
// ═════════════════════════════════════════════

// GET /api/export — Export all user data as JSON
router.get('/export', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);

    try {
      const bmRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_BOOKMARK]->(b:Bookmark) RETURN b ORDER BY b.created_at DESC`, { uid });
      const notesRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_NOTE]->(n:Note) RETURN n ORDER BY n.created_at DESC`, { uid });
      const hlRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) RETURN h ORDER BY h.created_at DESC`, { uid });
      const resRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_RESEARCH]->(r:ResearchQueue) RETURN r ORDER BY r.created_at DESC`, { uid });
      const remRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_REMINDER]->(r:Reminder) RETURN r ORDER BY r.created_at DESC`, { uid });

      const bookmarks = bmRes.records.map(r => r.get('b').properties);
      const notes = notesRes.records.map(r => r.get('n').properties);
      const highlights = hlRes.records.map(r => r.get('h').properties);
      const research = resRes.records.map(r => r.get('r').properties);
      const reminders = remRes.records.map(r => r.get('r').properties);

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
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error('[Export Error]', err.message);
    return res.status(500).json({ error: 'Export failed.' });
  }
});

// POST /api/import — Import data from JSON export
router.post('/import', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid import data. Expected { data: { bookmarks, notes, highlights, ... } }' });
    }

    const imported = { bookmarks: 0, notes: 0, highlights: 0, research: 0, reminders: 0 };

    try {
      for (const b of data.bookmarks || []) {
        await session.run(
          `MERGE (u:User {id: $uid})
           MERGE (bk:Bookmark {url: $url, user_id: $uid})
           ON CREATE SET bk.id = randomUUID(), bk.title = $title, bk.topic = $topic, bk.notes = $notes, bk.remind_at = $remindAt, bk.reminded = $reminded, bk.created_at = coalesce(datetime($createdAt), datetime())
           MERGE (u)-[:HAS_BOOKMARK]->(bk)`,
          { uid, url: b.url, title: b.title || '', topic: b.topic || '', notes: b.notes || '', remindAt: b.remind_at || null, reminded: b.reminded || 0, createdAt: b.created_at }
        );
        imported.bookmarks++;
      }

      for (const n of data.notes || []) {
        await session.run(
          `MERGE (u:User {id: $uid})
           CREATE (nt:Note {id: randomUUID(), content: $content, source_url: $sourceUrl, source_title: $sourceTitle, remind_at: $remindAt, reminded: $reminded, completed: $completed, created_at: coalesce(datetime($createdAt), datetime())})
           CREATE (u)-[:HAS_NOTE]->(nt)`,
          { uid, content: n.content || '', sourceUrl: n.source_url || null, sourceTitle: n.source_title || null, remindAt: n.remind_at || null, reminded: n.reminded || 0, completed: n.completed || 0, createdAt: n.created_at }
        );
        imported.notes++;
      }

      for (const h of data.highlights || []) {
        await session.run(
          `MERGE (u:User {id: $uid})
           CREATE (hl:Highlight {id: randomUUID(), url: $url, page_title: $pageTitle, text: $text, context: $context, color: $color, tags: $tags, note: $note, created_at: coalesce(datetime($createdAt), datetime())})
           CREATE (u)-[:HAS_HIGHLIGHT]->(hl)`,
          { uid, url: h.url || '', pageTitle: h.page_title || '', text: h.text || '', context: h.context || null, color: h.color || 'yellow', tags: h.tags || '', note: h.note || '', createdAt: h.created_at }
        );
        imported.highlights++;
      }

      for (const r of data.research || []) {
        await session.run(
          `MERGE (u:User {id: $uid})
           CREATE (rq:ResearchQueue {id: randomUUID(), url: $url, title: $title, user_notes: $userNotes, research_result: $result, status: $status, created_at: coalesce(datetime($createdAt), datetime())})
           CREATE (u)-[:HAS_RESEARCH]->(rq)`,
          { uid, url: r.url || '', title: r.title || '', userNotes: r.user_notes || null, result: r.research_result || null, status: r.status || 'pending', createdAt: r.created_at }
        );
        imported.research++;
      }

      for (const r of data.reminders || []) {
        await session.run(
          `MERGE (u:User {id: $uid})
           CREATE (rm:Reminder {id: randomUUID(), reminder_type: 'imported', reference_type: $refType, reference_id: $refId, title: $title, message: $message, remind_at: $remindAt, reminded: 0, dismissed: 0, created_at: coalesce(datetime($createdAt), datetime())})
           CREATE (u)-[:HAS_REMINDER]->(rm)`,
          { uid, refType: r.reference_type || null, refId: r.reference_id || null, title: r.title || '', message: r.message || null, remindAt: r.remind_at || null, createdAt: r.created_at }
        );
        imported.reminders++;
      }

      return res.json({ success: true, imported });
    } finally {
      await session.close();
    }
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
    // Only update the key when a valid value is provided — never clear it
    // with null/empty (prevents overwrite from extension init)
    if (gemini_api_key && gemini_api_key !== 'your_gemini_api_key_here') {
      config.apiKey = gemini_api_key;
    }
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
router.post('/log', async (req, res) => {
  const { level, component, message, stack, data } = req.body;
  const user_id = getUserId(req);
  const ts = new Date().toISOString();

  const prefix = `[${ts}] [${level || 'INFO'}] [${component || 'client'}] (${user_id.slice(0, 20)}...)`;
  const stackStr = stack ? `\nStack: ${stack.slice(0, 500)}` : '';
  const dataStr = data ? ` ${JSON.stringify(data).slice(0, 500)}` : '';

  switch (level) {
    case 'ERROR': console.error(`${prefix} ${message}${dataStr}${stackStr}`); break;
    case 'WARN': console.warn(`${prefix} ${message}${dataStr}`); break;
    default: console.log(`${prefix} ${message}${dataStr}`);
  }

  try {
    const database = getDb();
    const session = database.session();
    try {
      await session.run(
        `CREATE (e:ErrorLog {
          id: randomUUID(),
          user_id: $userId,
          level: $level,
          component: $component,
          message: $message,
          stack: $stack,
          metadata: $metadata,
          created_at: datetime()
        })`,
        {
          userId: user_id,
          level: (level || 'INFO').slice(0, 10),
          component: (component || 'client').slice(0, 50),
          message: (message || '').slice(0, 500),
          stack: (stack || '').slice(0, 2000),
          metadata: data ? JSON.stringify(data).slice(0, 2000) : null
        }
      );
    } finally {
      await session.close();
    }
  } catch (_) { /* best-effort */ }

  return res.json({ success: true });
});

// GET /api/logs — Retrieve recent error logs
router.get('/logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const level = req.query.level || null;
  try {
    const database = getDb();
    const session = database.session();
    try {
      let whereClause = '';
      const params = { limit: neo4j.int(limit) };
      if (level) {
        whereClause = 'WHERE e.level = $level';
        params.level = level.toUpperCase();
      }
      const result = await session.run(
        `MATCH (e:ErrorLog) ${whereClause} RETURN e ORDER BY e.created_at DESC LIMIT $limit`,
        params
      );
      const logs = result.records.map(r => r.get('e').properties);
      return res.json({ logs: logs || [], total: logs.length });
    } finally {
      await session.close();
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load logs.' });
  }
});

module.exports = router;
