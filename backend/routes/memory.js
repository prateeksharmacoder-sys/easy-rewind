/**
 * easy-rewind — Memory Route Module
 *
 * Items, highlights, connections, knowledge-graph, vector search, RAG ask, review-digest.
 */

const express = require('express');
const router = express.Router();

const {
  getDb,
  getUserId,
  sanitize,
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

const neo4j = require('neo4j-driver');

// ═════════════════════════════════════════════
// HIGHLIGHTS ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/highlights — Save a highlight
router.post('/highlights', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    const { url, page_title, text, context, color, tags, note } = req.body;
    if (!url || !text) return res.status(400).json({ error: 'url and text are required' });

    const cleanText = sanitize(text, 2000);

    try {
      // Check for duplicate
      const dupCheck = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight {url: $url, text: $text}) RETURN h`,
        { uid, url, text: cleanText }
      );
      if (dupCheck.records.length > 0) {
        const hl = dupCheck.records[0].get('h').properties;
        return res.json({ highlight: hl, duplicate: true });
      }

      const result = await session.run(
        `
        MERGE (u:User {id: $uid})
        CREATE (h:Highlight {
          id: randomUUID(),
          url: $url,
          page_title: $page_title,
          text: $text,
          context: $context,
          color: $color,
          tags: $tags,
          note: $note,
          created_at: datetime()
        })
        CREATE (u)-[:HAS_HIGHLIGHT]->(h)
        RETURN h
        `,
        {
          uid,
          url: sanitize(url, 2048),
          page_title: sanitize(page_title || '', 500),
          text: cleanText,
          context: sanitize(context || '', 3000),
          color: color || 'yellow',
          tags: sanitize(tags || '', 500),
          note: sanitize(note || '', 1000)
        }
      );

      const highlight = result.records[0] ? result.records[0].get('h').properties : null;
      return res.json({ highlight });
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error('[Highlights Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to save highlight.', detail: err.message });
  }
});

// GET /api/highlights — List highlights (optional ?url= filter)
router.get('/highlights', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    const url = req.query.url;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE u.id = $uid';
      const params = { uid, limit: neo4j.int(limit), skip: neo4j.int(offset) };

      if (url) {
        whereClause += ' AND h.url = $url';
        params.url = sanitize(url, 2048);
      }

      const countQ = `MATCH (u:User)-[:HAS_HIGHLIGHT]->(h:Highlight) ${whereClause} RETURN count(h) AS c`;
      const dataQ = `MATCH (u:User)-[:HAS_HIGHLIGHT]->(h:Highlight) ${whereClause} RETURN h ORDER BY h.created_at DESC SKIP $skip LIMIT $limit`;

      const cRes = await session.run(countQ, params);
      const dRes = await session.run(dataQ, params);
      const total = cRes.records[0] ? cRes.records[0].get('c').toNumber() : 0;
      const highlights = dRes.records.map(r => r.get('h').properties);

      return res.json({ highlights, total, page, limit });
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error('[Highlights List Error]', err.message);
    return res.status(500).json({ error: 'Failed to load highlights.' });
  }
});

// GET /api/highlights/stats — Get highlight count per page
router.get('/highlights/stats', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    try {
      const totalRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) RETURN count(h) AS c`, { uid });
      const perPageRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) RETURN h.url AS url, h.page_title AS page_title, count(h) AS count ORDER BY count DESC LIMIT 10`, { uid });
      const colorsRes = await session.run(`MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) RETURN h.color AS color, count(h) AS count ORDER BY count DESC`, { uid });
      const total = totalRes.records[0] ? totalRes.records[0].get('c').toNumber() : 0;
      const perPage = perPageRes.records.map(r => ({ url: r.get('url'), page_title: r.get('page_title'), count: r.get('count').toNumber() }));
      const colors = colorsRes.records.map(r => ({ color: r.get('color'), count: r.get('count').toNumber() }));
      return res.json({ total, perPage, colors });
    } finally {
      await session.close();
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// DELETE /api/highlights/:id — Delete a highlight
router.delete('/highlights/:id', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'Invalid highlight ID' });

    try {
      const result = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight {id: $id}) DETACH DELETE h RETURN count(h) AS deleted`,
        { uid, id: String(id) }
      );
      const deleted = result.records[0] ? result.records[0].get('deleted').toNumber() : 0;
      if (deleted === 0) return res.status(404).json({ error: 'Highlight not found' });
      return res.json({ success: true });
    } finally {
      await session.close();
    }
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
  const session = database.session();

  try {
    const sourceType = detectSourceType(cleanUrl);

    const createRes = await session.run(
      `
      MERGE (u:User {id: $userId})
      CREATE (i:Item {
        id: randomUUID(),
        url: $url,
        title: $title,
        content: $content,
        source_type: $sourceType,
        ai_summary: '',
        tags: '',
        embedding: null,
        memory_score: 0.5,
        interaction_count: 0,
        created_at: datetime(),
        updated_at: datetime()
      })
      CREATE (u)-[:HAS_ITEM]->(i)
      RETURN i
      `,
      { userId: user_id, url: cleanUrl, title: cleanTitle, content: cleanContent, sourceType }
    );

    const itemProps = createRes.records[0].get('i').properties;
    const itemId = itemProps.id;

    let summary = '';
    let tags = [];
    let embedding = null;

    const summaryPromise = skip_summary
      ? Promise.resolve('')
      : summarizeText(cleanContent || cleanTitle)
          .then(r => { summary = r.success ? r.summary : ''; })
          .catch(err => { console.warn('[Items] Summary failed:', err.message); });

    const embeddingPromise = skip_embedding
      ? Promise.resolve()
      : generateEmbedding(cleanContent || cleanTitle)
          .then(vec => { embedding = vec; })
          .catch(err => { console.warn('[Items] Embedding failed:', err.message); });

    await Promise.all([summaryPromise, embeddingPromise]);

    await session.run(
      `MATCH (i:Item {id: $itemId}) SET i.ai_summary = $summary, i.updated_at = datetime(), i.embedding = $embedding`,
      {
        itemId,
        summary: summary || '',
        embedding: (embedding && Array.isArray(embedding)) ? JSON.stringify(embedding) : null
      }
    );

    if (!skip_tags) {
      try {
        const tagResult = await generateTags(summary || cleanContent || cleanTitle);
        if (tagResult.success && tagResult.tags.length > 0) {
          tags = tagResult.tags;
          await storeItemTags(database, itemId, tags, user_id);
        }
      } catch (tagErr) {
        console.warn('[Items] Auto-tagging failed:', tagErr.message);
      }
    }

    const finalRes = await session.run(`MATCH (i:Item {id: $itemId}) RETURN i`, { itemId });
    const item = finalRes.records[0] ? finalRes.records[0].get('i').properties : itemProps;

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
  } finally {
    await session.close();
  }
});

// GET /api/items — List items with optional ?since= param for sync
router.get('/items', async (req, res) => {
  const user_id = getUserId(req);
  const since = req.query.since || null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const database = getDb();
  const session = database.session();

  try {
    let query, params;
    if (since) {
      const sinceDate = normalizeDate(since);
      if (!sinceDate) return res.status(400).json({ error: 'Invalid since timestamp. Use ISO 8601 format.' });
      query = `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.updated_at >= datetime($since) RETURN i ORDER BY i.updated_at ASC SKIP $skip LIMIT $limit`;
      params = { userId: user_id, since: sinceDate, limit: neo4j.int(limit), skip: neo4j.int(offset) };
    } else {
      query = `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) RETURN i ORDER BY i.created_at DESC SKIP $skip LIMIT $limit`;
      params = { userId: user_id, limit: neo4j.int(limit), skip: neo4j.int(offset) };
    }

    const dataRes = await session.run(query, params);
    const countRes = await session.run(`MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) RETURN count(i) AS c`, { userId: user_id });

    const items = dataRes.records.map(r => r.get('i').properties);
    const total = countRes.records[0] ? countRes.records[0].get('c').toNumber() : 0;

    return res.json({ items: items || [], total, since: since || null });
  } catch (err) {
    console.error('[Items List Error]', err.message);
    return res.status(500).json({ error: 'Failed to load items.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/items/:id — Delete an item and its embeddings/tags
router.delete('/items/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const checkRes = await session.run(`MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) RETURN i`, { userId: user_id, id: String(id) });
    if (checkRes.records.length === 0) return res.status(404).json({ error: 'Item not found.' });

    await session.run(`MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) DETACH DELETE i`, { userId: user_id, id: String(id) });
    return res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    console.error('[Items Delete Error]', err.message);
    return res.status(500).json({ error: 'Failed to delete item.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// ITEM INTERACTION (Memory Score)
// ═════════════════════════════════════════════

// PATCH /api/items/:id/interact — Record interaction, bumps memory_score
router.patch('/items/:id/interact', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const action = req.body.action || 'view';
  const database = getDb();
  const session = database.session();

  try {
    const itemRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) RETURN i`,
      { userId: user_id, id: String(id) }
    );
    if (itemRes.records.length === 0) return res.status(404).json({ error: 'Item not found.' });

    const item = itemRes.records[0].get('i').properties;
    const actionPoints = { view: 0.2, click: 0.5, search: 1.0, review: 2.0, link: 0.3 };
    const increment = actionPoints[action] || 0.2;
    const newScore = Math.min((parseFloat(item.memory_score) || 0) + increment, 100);
    const newCount = (parseInt(item.interaction_count) || 0) + 1;

    await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id})
       SET i.memory_score = $score, i.interaction_count = $count, i.last_interaction = datetime(), i.updated_at = datetime()`,
      { userId: user_id, id: String(id), score: newScore, count: neo4j.int(newCount) }
    );

    return res.json({
      success: true,
      item_id: id,
      memory_score: newScore,
      interaction_count: newCount,
      action,
    });
  } catch (err) {
    console.error('[Interact Error]', err.message);
    return res.status(500).json({ error: 'Failed to record interaction.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// RELATED ITEMS
// ═════════════════════════════════════════════

// GET /api/items/:id/related — Find semantically related items via embedding cosine similarity
router.get('/items/:id/related', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const database = getDb();
  const session = database.session();

  try {
    // Get source item embedding
    const srcRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) RETURN i.embedding AS emb, i.tags AS tags`,
      { userId: user_id, id: String(id) }
    );
    if (srcRes.records.length === 0) return res.status(404).json({ error: 'Item not found.' });

    const srcEmb = srcRes.records[0].get('emb');
    const srcTags = srcRes.records[0].get('tags') || '';

    if (!srcEmb) {
      // Fall back to tag-based similarity
      const tagList = srcTags.split(',').filter(Boolean).map(t => t.trim());
      if (tagList.length === 0) return res.json({ related: [], count: 0 });

      const tagRes = await session.run(
        `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
         WHERE i.id <> $id AND any(tag IN $tags WHERE toLower(i.tags) CONTAINS toLower(tag))
         RETURN i ORDER BY i.memory_score DESC, i.created_at DESC LIMIT $limit`,
        { userId: user_id, id: String(id), tags: tagList, limit: neo4j.int(limit) }
      );
      const related = tagRes.records.map(r => r.get('i').properties);
      return res.json({ related, count: related.length, method: 'tag' });
    }

    const sourceVec = parseEmbedding(srcEmb);
    if (!sourceVec) return res.json({ related: [], count: 0 });

    const allRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.id <> $id AND i.embedding IS NOT NULL RETURN i`,
      { userId: user_id, id: String(id) }
    );

    const scored = [];
    for (const r of allRes.records) {
      const item = r.get('i').properties;
      const vec = parseEmbedding(item.embedding);
      if (!vec) continue;
      const sim = cosineSimilarity(sourceVec, vec);
      if (sim < 0.1) continue;
      scored.push({ ...item, similarity: Math.round(sim * 1000) / 1000 });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    const related = scored.slice(0, limit);
    return res.json({ related, count: related.length, method: 'embedding' });
  } catch (err) {
    console.error('[Related Items Error]', err.message);
    return res.status(500).json({ error: 'Failed to find related items.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// KNOWLEDGE GRAPH ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/items/:id/connect — Create a connection between two items
router.post('/items/:id/connect', async (req, res) => {
  const sourceId = req.params.id;
  const { target_id, relationship, confidence } = req.body;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  if (!target_id) return res.status(400).json({ error: 'target_id is required.' });
  if (sourceId === String(target_id)) return res.status(400).json({ error: 'Cannot connect an item to itself.' });

  try {
    const rel = sanitize(relationship || 'related', 50);
    const conf = Math.max(0, Math.min(1, parseFloat(confidence) || 0.5));

    const srcCheck = await session.run(`MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) RETURN i`, { userId: user_id, id: String(sourceId) });
    const tgtCheck = await session.run(`MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item {id: $id}) RETURN i`, { userId: user_id, id: String(target_id) });
    if (srcCheck.records.length === 0) return res.status(404).json({ error: 'Source item not found.' });
    if (tgtCheck.records.length === 0) return res.status(404).json({ error: 'Target item not found.' });

    await session.run(
      `
      MATCH (a:Item {id: $srcId}), (b:Item {id: $tgtId})
      MERGE (a)-[r:CONNECTED_TO {relationship: $rel}]->(b)
      SET r.confidence = $conf, r.source = 'manual', r.created_at = coalesce(r.created_at, datetime())
      MERGE (b)-[r2:CONNECTED_TO {relationship: $rel}]->(a)
      SET r2.confidence = $conf, r2.source = 'manual', r2.created_at = coalesce(r2.created_at, datetime())
      `,
      { srcId: String(sourceId), tgtId: String(target_id), rel, conf }
    );

    return res.json({ success: true, connection: { source_item_id: sourceId, target_item_id: String(target_id), relationship: rel, confidence: conf } });
  } catch (err) {
    console.error('[Connect Error]', err.message);
    return res.status(500).json({ error: 'Failed to create connection.' });
  } finally {
    await session.close();
  }
});

// GET /api/items/:id/connections — Get all connections for an item
router.get('/items/:id/connections', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const result = await session.run(
      `
      MATCH (src:Item {id: $id})-[r:CONNECTED_TO]->(tgt:Item)
      MATCH (u:User {id: $userId})-[:HAS_ITEM]->(src)
      RETURN r, tgt, 'outgoing' AS direction
      UNION
      MATCH (tgt:Item)-[r:CONNECTED_TO]->(src:Item {id: $id})
      MATCH (u:User {id: $userId})-[:HAS_ITEM]->(src)
      RETURN r, tgt, 'incoming' AS direction
      `,
      { id: String(id), userId: user_id }
    );

    const seen = new Set();
    const allConnections = [];
    for (const rec of result.records) {
      const tgt = rec.get('tgt').properties;
      const r = rec.get('r').properties;
      const direction = rec.get('direction');
      const key = `${direction}-${tgt.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allConnections.push({
        connected_item_id: tgt.id,
        title: tgt.title || '',
        url: tgt.url || '',
        summary: tgt.ai_summary || '',
        source_type: tgt.source_type || 'web',
        memory_score: tgt.memory_score || 0,
        relationship: r.relationship || 'related',
        confidence: r.confidence || 0.5,
        direction,
        source: r.source || 'manual',
        created_at: r.created_at
      });
    }

    return res.json({ connections: allConnections, count: allConnections.length });
  } catch (err) {
    console.error('[Get Connections Error]', err.message);
    return res.status(500).json({ error: 'Failed to get connections.' });
  } finally {
    await session.close();
  }
});

// POST /api/connections/discover — Auto-discover connections between items using AI
router.post('/connections/discover', async (req, res) => {
  const user_id = getUserId(req);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const database = getDb();
  const session = database.session();

  try {
    const unconnectedRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
       OPTIONAL MATCH (i)-[r:CONNECTED_TO]-()
       WITH i, count(r) AS connCount
       WHERE connCount < 2
       RETURN i ORDER BY i.memory_score DESC, i.created_at DESC LIMIT $limit`,
      { userId: user_id, limit: neo4j.int(limit) }
    );

    const unconnectedItems = unconnectedRes.records.map(r => r.get('i').properties);

    if (unconnectedItems.length < 2) {
      return res.json({ discovered: 0, message: 'Not enough unconnected items to discover connections.' });
    }

    const pairs = [];
    const seenPairs = new Set();

    for (let i = 0; i < unconnectedItems.length; i++) {
      const a = unconnectedItems[i];
      const aTags = (a.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

      for (let j = i + 1; j < unconnectedItems.length; j++) {
        const b = unconnectedItems[j];
        const pairKey = `${a.id < b.id ? a.id : b.id}-${a.id < b.id ? b.id : a.id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        // Check if connection already exists
        const existRes = await session.run(
          `MATCH (a:Item {id: $aId})-[r:CONNECTED_TO]-(b:Item {id: $bId}) RETURN r LIMIT 1`,
          { aId: a.id, bId: b.id }
        );
        if (existRes.records.length > 0) continue;

        const bTags = (b.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        const sharedTags = aTags.filter(t => bTags.includes(t)).length;
        const tagScore = sharedTags / Math.max(aTags.length, bTags.length, 1);
        const memoryScore = ((parseFloat(a.memory_score) || 0) + (parseFloat(b.memory_score) || 0)) / 200;
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
Summary A: "${(pair.a.ai_summary || pair.a.content || '').slice(0, 300)}"
Tags A: ${pair.a.tags || 'none'}

Item B: "${pair.b.title || 'Untitled'}"
Summary B: "${(pair.b.ai_summary || pair.b.content || '').slice(0, 300)}"
Tags B: ${pair.b.tags || 'none'}

Choose ONE relationship from: "related", "prerequisite", "extension", "contrast", "application", "part_of", "example", "reference"
Respond with just the relationship word, nothing else.`;

          const result = await callGemini(prompt);
          const valid = ['related', 'prerequisite', 'extension', 'contrast', 'application', 'part_of', 'example', 'reference'];
          if (valid.includes(result?.trim().toLowerCase())) relationship = result.trim().toLowerCase();
        } catch (_) {}
      }

      try {
        await session.run(
          `MATCH (a:Item {id: $aId}), (b:Item {id: $bId})
           MERGE (a)-[r:CONNECTED_TO {relationship: $rel}]->(b)
           ON CREATE SET r.confidence = $conf, r.source = 'auto', r.created_at = datetime()
           MERGE (b)-[r2:CONNECTED_TO {relationship: $rel}]->(a)
           ON CREATE SET r2.confidence = $conf, r2.source = 'auto', r2.created_at = datetime()`,
          { aId: pair.a.id, bId: pair.b.id, rel: relationship, conf: Math.round(confidence * 100) / 100 }
        );
        discovered++;
      } catch (_) {}
    }

    return res.json({ discovered, candidates_considered: pairs.length, message: `Discovered ${discovered} new connections between your memories.` });
  } catch (err) {
    console.error('[Discover Connections Error]', err.message);
    return res.status(500).json({ error: 'Failed to discover connections.' });
  } finally {
    await session.close();
  }
});

// DELETE /api/connections/:id — Remove a connection
router.delete('/connections/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();
  try {
    await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(a:Item)-[r:CONNECTED_TO {id: $id}]->(b:Item) DELETE r`,
      { userId: user_id, id: String(id) }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete connection.' });
  } finally {
    await session.close();
  }
});

// GET /api/knowledge-graph — Full graph data for dashboard visualization
router.get('/knowledge-graph', async (req, res) => {
  const user_id = getUserId(req);
  const database = getDb();
  const session = database.session();

  try {
    const nodesRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) RETURN i ORDER BY i.memory_score DESC`,
      { userId: user_id }
    );
    const edgesRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(a:Item)-[r:CONNECTED_TO]->(b:Item) RETURN a.id AS src, b.id AS tgt, r.relationship AS rel, r.confidence AS conf, r.source AS source`,
      { userId: user_id }
    );

    const nodes = nodesRes.records.map(r => r.get('i').properties);
    const edges = edgesRes.records.map(r => ({
      source_item_id: r.get('src'),
      target_item_id: r.get('tgt'),
      relationship: r.get('rel'),
      confidence: r.get('conf'),
      source: r.get('source')
    }));

    return res.json({
      nodes: nodes || [],
      edges: edges || [],
      stats: { node_count: nodes.length, edge_count: edges.length },
    });
  } catch (err) {
    console.error('[Knowledge Graph Error]', err.message);
    return res.status(500).json({ error: 'Failed to load knowledge graph.' });
  } finally {
    await session.close();
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
  const session = database.session();

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
      const embRes = await session.run(
        `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.embedding IS NOT NULL RETURN i`,
        { userId: user_id }
      );

      const sourceTypeBoost = type => {
        const boosts = { youtube: 1.0, github: 1.05, blog: 1.1, docs: 1.08, news: 0.95, web: 1.0 };
        return boosts[type] || 1.0;
      };

      const scored = [];
      for (const rec of embRes.records) {
        const row = rec.get('i').properties;
        const storedVec = parseEmbedding(row.embedding);
        if (!storedVec) continue;

        const sim = cosineSimilarity(queryEmbedding, storedVec);
        if (sim < 0.05) continue;

        const ageMs = now - new Date(row.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(parseFloat(row.memory_score) || 0);
        const frequency = normalizeFreq(parseInt(row.interaction_count) || 0);
        const srcBoost = sourceTypeBoost(row.source_type);
        const hybridScore = (0.4 * sim + 0.3 * recency + 0.2 * memScore + 0.1 * frequency) * srcBoost;

        scored.push({
          id: row.id,
          title: row.title || '',
          summary: row.ai_summary || '',
          content: row.content ? row.content.slice(0, 300) : '',
          tags: row.tags || '',
          url: row.url || '',
          source_type: row.source_type || 'web',
          similarity: Math.round(sim * 1000) / 1000,
          recency: Math.round(recency * 1000) / 1000,
          memory_score: parseFloat(row.memory_score) || 0,
          interaction_count: parseInt(row.interaction_count) || 0,
          score: Math.round(hybridScore * 1000) / 1000,
          created_at: row.created_at,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      results = scored.slice(0, 15);
    }

    if (results.length < 3) {
      const sourceTypeBoost = type => {
        const boosts = { youtube: 1.0, github: 1.05, blog: 1.1, docs: 1.08, news: 0.95, web: 1.0 };
        return boosts[type] || 1.0;
      };

      const kwRes = await session.run(
        `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
         WHERE toLower(i.title) CONTAINS toLower($q) OR toLower(i.ai_summary) CONTAINS toLower($q)
               OR toLower(i.content) CONTAINS toLower($q) OR toLower(i.tags) CONTAINS toLower($q)
         RETURN i,
                CASE WHEN toLower(i.title) CONTAINS toLower($q) THEN 1.0
                     WHEN toLower(i.tags) CONTAINS toLower($q) THEN 0.7
                     WHEN toLower(i.ai_summary) CONTAINS toLower($q) THEN 0.8
                     ELSE 0.5 END AS kw_score
         ORDER BY kw_score DESC LIMIT 15`,
        { userId: user_id, q: cleanQuery }
      );

      const existingIds = new Set(results.map(r => r.id));
      for (const rec of kwRes.records) {
        const r = rec.get('i').properties;
        if (existingIds.has(r.id)) continue;
        const kwScore = rec.get('kw_score');
        const ageMs = now - new Date(r.created_at).getTime();
        const recency = daysToRecency(ageMs / (24 * 60 * 60 * 1000));
        const memScore = normalizeScore(parseFloat(r.memory_score) || 0);
        const freq = normalizeFreq(parseInt(r.interaction_count) || 0);
        const srcBoost = sourceTypeBoost(r.source_type);
        const hybridScore = (0.4 * (kwScore || 0.3) + 0.3 * recency + 0.2 * memScore + 0.1 * freq) * srcBoost;

        results.push({
          id: r.id, title: r.title || '', summary: r.ai_summary || '',
          content: r.content ? r.content.slice(0, 300) : '', tags: r.tags || '',
          url: r.url || '', source_type: r.source_type || 'web',
          similarity: 0, recency: Math.round(recency * 1000) / 1000,
          memory_score: parseFloat(r.memory_score) || 0, interaction_count: parseInt(r.interaction_count) || 0,
          score: Math.round(hybridScore * 1000) / 1000, created_at: r.created_at,
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
  } finally {
    await session.close();
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
  const session = database.session();

  try {
    let searchResults = [];
    try {
      const queryEmbedding = await generateEmbedding(cleanQuery).catch(() => null);

      if (queryEmbedding && Array.isArray(queryEmbedding)) {
        const embRes = await session.run(
          `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.embedding IS NOT NULL RETURN i`,
          { userId: user_id }
        );
        const scored = [];
        for (const rec of embRes.records) {
          const row = rec.get('i').properties;
          const storedVec = parseEmbedding(row.embedding);
          if (!storedVec) continue;
          const score = cosineSimilarity(queryEmbedding, storedVec);
          if (score > 0.15) scored.push({ ...row, score });
        }
        scored.sort((a, b) => b.score - a.score);
        searchResults = scored.slice(0, 5);
      }

      if (searchResults.length === 0) {
        const kwRes = await session.run(
          `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item)
           WHERE toLower(i.title) CONTAINS toLower($q) OR toLower(i.ai_summary) CONTAINS toLower($q)
                 OR toLower(i.content) CONTAINS toLower($q) OR toLower(i.tags) CONTAINS toLower($q)
           RETURN i ORDER BY i.created_at DESC LIMIT 5`,
          { userId: user_id, q: cleanQuery }
        );
        searchResults = kwRes.records.map(r => r.get('i').properties);
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
        .map((r, i) => `[${i + 1}] Title: ${r.title || 'Untitled'}\nSummary: ${r.ai_summary || r.summary || 'N/A'}\nURL: ${r.url || 'N/A'}`)
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
        answer: searchResults.length > 0
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
        summary: r.ai_summary || r.summary || '',
        score: r.score || null,
      })),
      source_count: searchResults.length,
      query: cleanQuery,
    });
  } catch (err) {
    console.error('[Ask RAG Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate answer.' });
  } finally {
    await session.close();
  }
});

// ═════════════════════════════════════════════
// REVIEW DIGEST
// ═════════════════════════════════════════════

// GET /api/review-digest — Generate a review digest of recent items
router.get('/review-digest', async (req, res) => {
  try {
    const database = getDb();
    const session = database.session();
    const uid = getUserId(req);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const recentLimit = neo4j.int(Math.min(parseInt(req.query.limit) || 20, 50));
    const now = new Date().toISOString();

    try {
      const bmRes = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_BOOKMARK]->(b:Bookmark) WHERE b.created_at >= datetime($since) RETURN b ORDER BY b.created_at DESC LIMIT $limit`,
        { uid, since, limit: recentLimit }
      );
      const notesRes = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_NOTE]->(n:Note) WHERE n.created_at >= datetime($since) AND coalesce(n.completed, 0) = 0 RETURN n ORDER BY n.created_at DESC LIMIT $limit`,
        { uid, since, limit: recentLimit }
      );
      const hlRes = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_HIGHLIGHT]->(h:Highlight) WHERE h.created_at >= datetime($since) RETURN h ORDER BY h.created_at DESC LIMIT $limit`,
        { uid, since, limit: recentLimit }
      );
      const remRes = await session.run(
        `MATCH (u:User {id: $uid})-[:HAS_REMINDER]->(r:Reminder) WHERE coalesce(r.reminded, 0) = 0 AND coalesce(r.dismissed, 0) = 0 AND r.remind_at <= datetime($now) RETURN r ORDER BY r.remind_at ASC LIMIT $limit`,
        { uid, now, limit: recentLimit }
      );

      const bookmarks = bmRes.records.map(r => r.get('b').properties);
      const notes = notesRes.records.map(r => r.get('n').properties);
      const highlights = hlRes.records.map(r => r.get('h').properties);
      const dueReminders = remRes.records.map(r => r.get('r').properties);

      const reviewItems = [
        ...bookmarks.map(item => ({ type: 'bookmark', title: item.title || item.topic, detail: item.topic, url: item.url, created_at: item.created_at })),
        ...notes.map(item => ({ type: 'note', title: item.source_title || 'Note', detail: (item.content || '').slice(0, 160), url: item.source_url || '', created_at: item.created_at })),
        ...highlights.map(item => ({ type: 'highlight', title: item.page_title || 'Highlight', detail: (item.text || '').slice(0, 160), url: item.url, color: item.color, created_at: item.created_at })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, parseInt(req.query.limit) || 20);

      return res.json({
        days,
        generated_at: new Date().toISOString(),
        stats: { bookmarks: bookmarks.length, notes: notes.length, highlights: highlights.length, due_reminders: dueReminders.length },
        due_reminders: dueReminders,
        review_items: reviewItems,
      });
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error('[Review Digest Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate review digest.' });
  }
});

module.exports = router;
