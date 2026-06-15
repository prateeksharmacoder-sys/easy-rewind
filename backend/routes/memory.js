/**
 * easy-rewind — Memory Route Module
 *
 * Items, highlights, connections, knowledge-graph, vector search, RAG ask, review-digest.
 */

const express = require('express');
const router = express.Router();

const {
  config,
  getDb,
  getUserId,
  sanitize,
  isValidId,
  normalizeDate,
  generateEmbedding,
  cosineSimilarity,
  parseEmbedding,
  summarizeText,
  generateTags,
  storeItemTags,
  detectSourceType,
  callGemini,
  getGenAI,
} = require('./helpers');

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
    const existing = database
      .prepare('SELECT id FROM highlights WHERE user_id = ? AND url = ? AND text = ?')
      .get(uid, url, cleanText);
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
    const highlights = database
      .prepare(`SELECT * FROM highlights ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

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
    const perPage = database
      .prepare(
        `SELECT url, page_title, COUNT(*) as count FROM highlights WHERE user_id = ? GROUP BY url ORDER BY count DESC LIMIT 10`
      )
      .all(uid);
    const colors = database
      .prepare(`SELECT color, COUNT(*) as count FROM highlights WHERE user_id = ? GROUP BY color ORDER BY count DESC`)
      .all(uid);
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
// ITEMS ENDPOINTS (Unified Save + Sync)
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
    const sourceType = detectSourceType(cleanUrl);

    const info = database
      .prepare(
        `
      INSERT INTO items (user_id, url, title, content, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'), (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z'))
    `
      )
      .run(user_id, cleanUrl, cleanTitle, cleanContent, sourceType);
    const itemId = info.lastInsertRowid;

    let summary = '';
    let tags = [];
    let embedding = null;

    const summaryPromise = skip_summary
      ? Promise.resolve('')
      : summarizeText(cleanContent || cleanTitle)
          .then(r => {
            summary = r.success ? r.summary : '';
          })
          .catch(err => {
            console.warn('[Items] Summary failed:', err.message);
          });

    const embeddingPromise = skip_embedding
      ? Promise.resolve()
      : generateEmbedding(cleanContent || cleanTitle)
          .then(vec => {
            embedding = vec;
          })
          .catch(err => {
            console.warn('[Items] Embedding failed:', err.message);
          });

    await Promise.all([summaryPromise, embeddingPromise]);

    database
      .prepare("UPDATE items SET summary = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%S', 'now') || 'Z') WHERE id = ?")
      .run(summary || '', itemId);

    if (embedding && Array.isArray(embedding)) {
      try {
        database
          .prepare(
            `
          INSERT OR REPLACE INTO item_embeddings (item_id, embedding, model)
          VALUES (?, ?, ?)
        `
          )
          .run(itemId, JSON.stringify(embedding), config.apiKey?.startsWith('sk-') ? 'openai' : 'gemini');
      } catch (embedErr) {
        console.warn('[Items] Embedding storage failed:', embedErr.message);
      }
    }

    if (!skip_tags) {
      try {
        const tagResult = await generateTags(summary || cleanContent || cleanTitle);
        if (tagResult.success && tagResult.tags.length > 0) {
          tags = tagResult.tags;
          storeItemTags(database, itemId, tags, user_id);
        }
      } catch (tagErr) {
        console.warn('[Items] Auto-tagging failed:', tagErr.message);
      }
    }

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
    return res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    console.error('[Items Delete Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete item.' });
  }
});

// ═════════════════════════════════════════════
// ITEM INTERACTION (Memory Score)
// ═════════════════════════════════════════════

// PATCH /api/items/:id/interact — Record interaction, bumps memory_score
router.patch('/items/:id/interact', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const action = req.body.action || 'view';
  const database = getDb();

  try {
    const item = database
      .prepare('SELECT id, memory_score, interaction_count FROM items WHERE id = ? AND user_id = ?')
      .get(id, user_id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    const actionPoints = {
      view: 0.2,
      click: 0.5,
      search: 1.0,
      review: 2.0,
      link: 0.3,
    };
    const increment = actionPoints[action] || 0.2;
    const newScore = Math.min((item.memory_score || 0) + increment, 100);
    const newCount = (item.interaction_count || 0) + 1;
    const now = new Date().toISOString();

    database
      .prepare(
        `
      UPDATE items
      SET memory_score = ?, interaction_count = ?, last_interacted_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `
      )
      .run(newScore, newCount, now, now, id, user_id);

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
// RELATED ITEMS
// ═════════════════════════════════════════════

// GET /api/items/:id/related — Find semantically related items via embedding cosine similarity
router.get('/items/:id/related', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const database = getDb();

  try {
    const sourceEmbedding = database
      .prepare(
        `
      SELECT ie.embedding FROM item_embeddings ie
      JOIN items i ON i.id = ie.item_id
      WHERE ie.item_id = ? AND i.user_id = ?
    `
      )
      .get(id, user_id);

    if (!sourceEmbedding) {
      const sourceTags = database.prepare('SELECT tags FROM items WHERE id = ? AND user_id = ?').get(id, user_id);
      if (!sourceTags) return res.status(404).json({ error: 'Item not found.' });

      const tagList = (sourceTags.tags || '')
        .split(',')
        .filter(Boolean)
        .map(t => t.trim());
      if (tagList.length === 0) return res.json({ related: [], count: 0 });

      const placeholders = tagList.map(() => 'LOWER(tags) LIKE ?').join(' OR ');
      const params = tagList.flatMap(t => [`%${t.toLowerCase()}%`]);
      const related = database
        .prepare(
          `
        SELECT i.id, i.title, i.summary, i.url, i.tags, i.source_type, i.created_at,
               i.memory_score
        FROM items i
        WHERE i.user_id = ? AND i.id != ?
          AND (${placeholders})
        ORDER BY i.memory_score DESC, i.created_at DESC
        LIMIT ?
      `
        )
        .all(user_id, id, ...params, limit);

      return res.json({ related: related || [], count: related?.length || 0, method: 'tag' });
    }

    const sourceVec = parseEmbedding(sourceEmbedding.embedding);
    if (!sourceVec) return res.json({ related: [], count: 0 });

    const allEmbeddings = database
      .prepare(
        `
      SELECT ie.item_id, ie.embedding, i.title, i.summary, i.url, i.tags, i.source_type,
             i.created_at, i.memory_score
      FROM item_embeddings ie
      JOIN items i ON i.id = ie.item_id
      WHERE i.user_id = ? AND ie.item_id != ?
    `
      )
      .all(user_id, id);

    const scored = [];
    for (const row of allEmbeddings) {
      const vec = parseEmbedding(row.embedding);
      if (!vec) continue;
      const sim = cosineSimilarity(sourceVec, vec);
      if (sim < 0.1) continue;
      scored.push({
        id: row.item_id,
        title: row.title || '',
        summary: row.summary || '',
        url: row.url || '',
        tags: row.tags || '',
        source_type: row.source_type || 'web',
        similarity: Math.round(sim * 1000) / 1000,
        memory_score: row.memory_score || 0,
        created_at: row.created_at,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const related = scored.slice(0, limit);

    return res.json({ related, count: related.length, method: 'embedding' });
  } catch (err) {
    console.error('[Related Items Error]', err.message);
    return res.status(500).json({ error: 'Failed to find related items.' });
  }
});

// ═════════════════════════════════════════════
// KNOWLEDGE GRAPH ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/items/:id/connect — Create a connection between two items
router.post('/items/:id/connect', (req, res) => {
  const sourceId = parseInt(req.params.id);
  const { target_id, relationship, confidence } = req.body;
  const user_id = getUserId(req);
  const database = getDb();

  if (!target_id) return res.status(400).json({ error: 'target_id is required.' });
  if (sourceId === target_id) return res.status(400).json({ error: 'Cannot connect an item to itself.' });

  try {
    const source = database.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(sourceId, user_id);
    const target = database.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(target_id, user_id);
    if (!source) return res.status(404).json({ error: 'Source item not found.' });
    if (!target) return res.status(404).json({ error: 'Target item not found.' });

    const rel = sanitize(relationship || 'related', 50);
    const conf = Math.max(0, Math.min(1, parseFloat(confidence) || 0.5));

    database
      .prepare(
        `
      INSERT OR REPLACE INTO memory_connections (user_id, source_item_id, target_item_id, relationship, confidence, source)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `
      )
      .run(user_id, sourceId, target_id, rel, conf);

    database
      .prepare(
        `
      INSERT OR IGNORE INTO memory_connections (user_id, source_item_id, target_item_id, relationship, confidence, source)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `
      )
      .run(user_id, target_id, sourceId, rel, conf);

    const connection = database
      .prepare(
        `
      SELECT * FROM memory_connections WHERE source_item_id = ? AND target_item_id = ? AND relationship = ?
    `
      )
      .get(sourceId, target_id, rel);

    return res.json({ success: true, connection });
  } catch (err) {
    console.error('[Connect Error]', err.message);
    return res.status(500).json({ error: 'Failed to create connection.' });
  }
});

// GET /api/items/:id/connections — Get all connections for an item
router.get('/items/:id/connections', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();

  try {
    const outgoing = database
      .prepare(
        `
      SELECT mc.*, i.title as target_title, i.url as target_url, i.ai_summary as target_summary,
             i.source_type as target_source_type, i.memory_score as target_memory_score
      FROM memory_connections mc
      JOIN items i ON i.id = mc.target_item_id
      WHERE mc.source_item_id = ? AND mc.user_id = ?
      ORDER BY mc.confidence DESC, mc.created_at DESC
    `
      )
      .all(id, user_id);

    const incoming = database
      .prepare(
        `
      SELECT mc.*, i.title as source_title, i.url as source_url, i.ai_summary as source_summary,
             i.source_type as source_source_type, i.memory_score as source_memory_score
      FROM memory_connections mc
      JOIN items i ON i.id = mc.source_item_id
      WHERE mc.target_item_id = ? AND mc.user_id = ?
      ORDER BY mc.confidence DESC, mc.created_at DESC
    `
      )
      .all(id, user_id);

    const seen = new Set();
    const allConnections = [];

    for (const c of outgoing) {
      const key = `out-${c.target_item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allConnections.push({
        id: c.id,
        connected_item_id: c.target_item_id,
        title: c.target_title,
        url: c.target_url,
        summary: c.target_summary,
        source_type: c.target_source_type,
        memory_score: c.target_memory_score,
        relationship: c.relationship,
        confidence: c.confidence,
        direction: 'outgoing',
        source: c.source,
        created_at: c.created_at,
      });
    }

    for (const c of incoming) {
      const key = `in-${c.source_item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allConnections.push({
        id: c.id,
        connected_item_id: c.source_item_id,
        title: c.source_title,
        url: c.source_url,
        summary: c.source_summary,
        source_type: c.source_source_type,
        memory_score: c.source_memory_score,
        relationship: c.relationship,
        confidence: c.confidence,
        direction: 'incoming',
        source: c.source,
        created_at: c.created_at,
      });
    }

    return res.json({ connections: allConnections, count: allConnections.length });
  } catch (err) {
    console.error('[Get Connections Error]', err.message);
    return res.status(500).json({ error: 'Failed to get connections.' });
  }
});

// POST /api/connections/discover — Auto-discover connections between items using AI
router.post('/connections/discover', async (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const database = getDb();

  try {
    const unconnectedItems = database
      .prepare(
        `
      SELECT * FROM (
        SELECT i.id, i.title, i.ai_summary as summary, i.content, i.url, i.tags, i.source_type, i.memory_score, i.created_at,
               (SELECT COUNT(DISTINCT CASE WHEN mc.source_item_id = i.id THEN mc.target_item_id ELSE mc.source_item_id END)
                FROM memory_connections mc
                WHERE mc.source_item_id = i.id OR mc.target_item_id = i.id) as conn_count
        FROM items i
        WHERE i.user_id = ?
      ) sub
      WHERE conn_count < 2
      ORDER BY sub.memory_score DESC, sub.created_at DESC
      LIMIT ?
    `
      )
      .all(user_id, limit);

    if (unconnectedItems.length < 2) {
      return res.json({ discovered: 0, message: 'Not enough unconnected items to discover connections.' });
    }

    const pairs = [];
    const seenPairs = new Set();

    for (let i = 0; i < unconnectedItems.length; i++) {
      const a = unconnectedItems[i];
      const aTags = (a.tags || '')
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);

      for (let j = i + 1; j < unconnectedItems.length; j++) {
        const b = unconnectedItems[j];
        const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const existing = database
          .prepare(
            `
          SELECT id FROM memory_connections
          WHERE ((source_item_id = ? AND target_item_id = ?) OR (source_item_id = ? AND target_item_id = ?))
            AND user_id = ?
        `
          )
          .get(a.id, b.id, b.id, a.id, user_id);
        if (existing) continue;

        const bTags = (b.tags || '')
          .split(',')
          .map(t => t.trim().toLowerCase())
          .filter(Boolean);
        const sharedTags = aTags.filter(t => bTags.includes(t)).length;
        const tagScore = sharedTags / Math.max(aTags.length, bTags.length);
        const memoryScore = ((a.memory_score || 0) + (b.memory_score || 0)) / 200;
        const combinedScore = tagScore * 0.6 + memoryScore * 0.4;

        if (combinedScore > 0.1 || sharedTags > 0) {
          pairs.push({ a, b, score: combinedScore, sharedTags });
        }
      }
    }

    pairs.sort((x, y) => y.score - x.score);
    const topPairs = pairs.slice(0, 20);

    let discovered = 0;
    const ai = getGenAI();

    for (const pair of topPairs) {
      let relationship = 'related';
      let confidence = pair.score;

      if (ai && pair.score > 0.15) {
        try {
          const prompt = `You are a knowledge graph curator. Given two saved items from a user's knowledge base, determine the relationship between them.

Item A: "${pair.a.title || 'Untitled'}"
Summary A: "${(pair.a.summary || pair.a.content || '').slice(0, 300)}"
Tags A: ${pair.a.tags || 'none'}

Item B: "${pair.b.title || 'Untitled'}"
Summary B: "${(pair.b.summary || pair.b.content || '').slice(0, 300)}"
Tags B: ${pair.b.tags || 'none'}

Choose ONE relationship from: "related", "prerequisite", "extension", "contrast", "application", "part_of", "example", "reference"
Respond with just the relationship word, nothing else.`;

          const result = await callGemini(prompt);
          const validRelationships = [
            'related',
            'prerequisite',
            'extension',
            'contrast',
            'application',
            'part_of',
            'example',
            'reference',
          ];
          if (validRelationships.includes(result?.trim().toLowerCase())) {
            relationship = result.trim().toLowerCase();
          }
        } catch (_) {}
      }

      try {
        database
          .prepare(
            `
          INSERT OR IGNORE INTO memory_connections (user_id, source_item_id, target_item_id, relationship, confidence, source)
          VALUES (?, ?, ?, ?, ?, 'auto')
        `
          )
          .run(user_id, pair.a.id, pair.b.id, relationship, Math.round(confidence * 100) / 100);

        database
          .prepare(
            `
          INSERT OR IGNORE INTO memory_connections (user_id, source_item_id, target_item_id, relationship, confidence, source)
          VALUES (?, ?, ?, ?, ?, 'auto')
        `
          )
          .run(user_id, pair.b.id, pair.a.id, relationship, Math.round(confidence * 100) / 100);

        discovered++;
      } catch (_) {}
    }

    return res.json({
      discovered,
      candidates_considered: pairs.length,
      message: `Discovered ${discovered} new connections between your memories.`,
    });
  } catch (err) {
    console.error('[Discover Connections Error]', err.message);
    return res.status(500).json({ error: 'Failed to discover connections.' });
  }
});

// DELETE /api/connections/:id — Remove a connection
router.delete('/connections/:id', (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();

  try {
    database.prepare('DELETE FROM memory_connections WHERE id = ? AND user_id = ?').run(id, user_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete connection.' });
  }
});

// GET /api/knowledge-graph — Full graph data for dashboard visualization
router.get('/knowledge-graph', (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();

  try {
    const nodes = database
      .prepare(
        `
      SELECT id, title, url, tags, source_type, memory_score, interaction_count, created_at
      FROM items WHERE user_id = ?
      ORDER BY memory_score DESC
    `
      )
      .all(user_id);

    const edges = database
      .prepare(
        `
      SELECT id, source_item_id, target_item_id, relationship, confidence, source
      FROM memory_connections WHERE user_id = ?
      ORDER BY confidence DESC
    `
      )
      .all(user_id);

    return res.json({
      nodes: nodes || [],
      edges: edges || [],
      stats: {
        node_count: nodes?.length || 0,
        edge_count: edges?.length || 0,
      },
    });
  } catch (err) {
    console.error('[Knowledge Graph Error]', err.message);
    return res.status(500).json({ error: 'Failed to load knowledge graph.' });
  }
});

// ═════════════════════════════════════════════
// VECTOR SEARCH
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
    let queryEmbedding;
    try {
      queryEmbedding = await generateEmbedding(cleanQuery);
    } catch (embedErr) {
      console.warn('[Hybrid Search] Embedding failed, falling back to keyword:', embedErr.message);
    }

    const daysToRecency = days => Math.max(0, Math.min(1, 1 - days / 365));
    const now = Date.now();
    const normalizeScore = s => Math.min(1, (s || 0) / 50);
    const normalizeFreq = c => Math.min(1, (c || 0) / 20);

    let results = [];

    if (queryEmbedding && Array.isArray(queryEmbedding)) {
      const embeddings = database
        .prepare(
          `
        SELECT ie.item_id, ie.embedding, i.title, i.summary, i.content, i.tags, i.url,
               i.source_type, i.created_at, i.memory_score, i.interaction_count, i.last_interacted_at
        FROM item_embeddings ie
        JOIN items i ON i.id = ie.item_id
        WHERE i.user_id = ?
      `
        )
        .all(user_id);

      const sourceTypeBoost = type => {
        const boosts = { youtube: 1.0, github: 1.05, blog: 1.1, docs: 1.08, news: 0.95, web: 1.0 };
        return boosts[type] || 1.0;
      };

      const scored = [];
      for (const row of embeddings) {
        const storedVec = parseEmbedding(row.embedding);
        if (!storedVec) continue;

        const sim = cosineSimilarity(queryEmbedding, storedVec);
        if (sim < 0.05) continue;

        const ageMs = now - new Date(row.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(row.memory_score);
        const frequency = normalizeFreq(row.interaction_count);
        const srcBoost = sourceTypeBoost(row.source_type);

        const hybridScore = (0.4 * sim + 0.3 * recency + 0.2 * memScore + 0.1 * frequency) * srcBoost;

        scored.push({
          id: row.item_id,
          title: row.title || '',
          summary: row.summary || '',
          content: row.content ? row.content.slice(0, 300) : '',
          tags: row.tags || '',
          url: row.url || '',
          source_type: row.source_type || 'web',
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

    if (results.length < 3) {
      const pattern = `%${cleanQuery}%`;
      const sourceTypeBoost = type => {
        const boosts = { youtube: 1.0, github: 1.05, blog: 1.1, docs: 1.08, news: 0.95, web: 1.0 };
        return boosts[type] || 1.0;
      };

      const keywordResults = database
        .prepare(
          `
        SELECT id, title, summary, content, tags, url, source_type, created_at,
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
      `
        )
        .all(pattern, pattern, pattern, pattern, user_id, pattern, pattern, pattern, pattern);

      const existingIds = new Set(results.map(r => r.id));
      const seenIds = new Set();

      for (const r of keywordResults) {
        if (existingIds.has(r.id) || seenIds.has(r.id)) continue;
        seenIds.add(r.id);

        const ageMs = now - new Date(r.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(r.memory_score);
        const freq = normalizeFreq(r.interaction_count);
        const srcBoost = sourceTypeBoost(r.source_type);

        const hybridScore = (0.4 * (r.kw_score || 0.3) + 0.3 * recency + 0.2 * memScore + 0.1 * freq) * srcBoost;

        results.push({
          id: r.id,
          title: r.title || '',
          summary: r.summary || '',
          content: r.content ? r.content.slice(0, 300) : '',
          tags: r.tags || '',
          url: r.url || '',
          source_type: r.source_type || 'web',
          similarity: 0,
          recency: Math.round(recency * 1000) / 1000,
          memory_score: r.memory_score || 0,
          interaction_count: r.interaction_count || 0,
          score: Math.round(hybridScore * 1000) / 1000,
          created_at: r.created_at,
        });
      }
    }

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
// RAG ASK ENDPOINT
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
    let searchResults = [];
    try {
      const queryEmbedding = await generateEmbedding(cleanQuery).catch(() => null);

      if (queryEmbedding && Array.isArray(queryEmbedding)) {
        const embeddings = database
          .prepare(
            `
          SELECT ie.item_id, ie.embedding, i.title, i.summary, i.content, i.url
          FROM item_embeddings ie
          JOIN items i ON i.id = ie.item_id
          WHERE i.user_id = ?
        `
          )
          .all(user_id);

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

      if (searchResults.length === 0) {
        const pattern = `%${cleanQuery}%`;
        searchResults = database
          .prepare(
            `
          SELECT id as item_id, title, summary, content, url FROM items
          WHERE user_id = ?
            AND (LOWER(title) LIKE LOWER(?) OR LOWER(summary) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))
          ORDER BY created_at DESC
          LIMIT 5
        `
          )
          .all(user_id, pattern, pattern, pattern, pattern);
      }
    } catch (searchErr) {
      console.warn('[Ask] Search phase failed:', searchErr.message);
    }

    let ragPrompt;
    if (searchResults.length === 0) {
      ragPrompt = `You are a helpful knowledge assistant. The user has asked a question but there are no saved items matching it yet.

Question: "${cleanQuery}"

Answer the question based on your general knowledge. Keep your answer concise (2-4 sentences). If you're not confident about the answer, say so.`;
    } else {
      const context = searchResults
        .map(
          (r, i) => `[${i + 1}] Title: ${r.title || 'Untitled'}\nSummary: ${r.summary || 'N/A'}\nURL: ${r.url || 'N/A'}`
        )
        .join('\n\n');

      ragPrompt = `You are a helpful knowledge assistant. Answer the user's question based ONLY on the context from their saved items below. If the context doesn't contain enough information to answer fully, say so — don't make things up.

Context from saved items:
${context}

Question: "${cleanQuery}"

Answer concisely (2-4 sentences). If helpful, reference which saved item(s) the answer comes from.`;
    }

    const ai = getGenAI();
    if (!ai) {
      return res.json({
        answer:
          searchResults.length > 0
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
// REVIEW DIGEST
// ═════════════════════════════════════════════

// GET /api/review-digest — Generate a review digest of recent items
router.get('/review-digest', (req, res) => {
  try {
    const database = getDb();
    const uid = getUserId(req);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const recentLimit = Math.min(parseInt(req.query.limit) || 20, 50);

    const bookmarks = database
      .prepare(
        `
      SELECT id, url, title, topic, notes, created_at
      FROM bookmarks
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `
      )
      .all(uid, since, recentLimit);
    const notes = database
      .prepare(
        `
      SELECT id, content, source_url, source_title, created_at
      FROM notes
      WHERE user_id = ? AND created_at >= ? AND completed = 0
      ORDER BY created_at DESC LIMIT ?
    `
      )
      .all(uid, since, recentLimit);
    const highlights = database
      .prepare(
        `
      SELECT id, url, page_title, text, color, created_at
      FROM highlights
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `
      )
      .all(uid, since, recentLimit);
    const dueReminders = database
      .prepare(
        `
      SELECT id, reminder_type, reference_type, title, message, remind_at
      FROM reminders
      WHERE user_id = ? AND reminded = 0 AND dismissed = 0 AND remind_at <= ?
      ORDER BY remind_at ASC LIMIT ?
    `
      )
      .all(uid, new Date().toISOString(), recentLimit);

    const reviewItems = [
      ...bookmarks.map(item => ({
        type: 'bookmark',
        title: item.title || item.topic,
        detail: item.topic,
        url: item.url,
        created_at: item.created_at,
      })),
      ...notes.map(item => ({
        type: 'note',
        title: item.source_title || 'Note',
        detail: item.content.slice(0, 160),
        url: item.source_url || '',
        created_at: item.created_at,
      })),
      ...highlights.map(item => ({
        type: 'highlight',
        title: item.page_title || 'Highlight',
        detail: item.text.slice(0, 160),
        url: item.url,
        color: item.color,
        created_at: item.created_at,
      })),
    ]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, recentLimit);

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

module.exports = router;
