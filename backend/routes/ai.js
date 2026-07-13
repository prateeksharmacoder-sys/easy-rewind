/**
 * easy-rewind — AI Route Module (Neo4j)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

const { config, getDb, getGenAI, callGemini, sanitize, getUserId, summarizeText, generateTags, generateEmbedding, detectSourceType } = require('./helpers');

// POST /api/quick-lookup — AI definition for a tech term (cached)
router.post('/quick-lookup', async (req, res) => {
  const { term } = req.body;

  if (!term || typeof term !== 'string' || term.trim().length === 0) {
    return res.status(400).json({ error: 'Please provide a term to look up.' });
  }

  const cleanTerm = sanitize(term, 200);
  if (cleanTerm.length < 1) {
    return res.status(400).json({ error: 'Term is too short.' });
  }

  const database = getDb();
  const session = database.session();

  try {
    // Step 1: Check Cache
    const cached = await session.run(
      `MATCH (c:Cache) WHERE toLower(c.term) = toLower($term) RETURN c`,
      { term: cleanTerm }
    );

    if (cached.records.length > 0) {
      const c = cached.records[0].get('c').properties;
      try {
        await session.run(
          `CREATE (sl:SearchLog {id: randomUUID(), user_id: $userId, query: $query, found: 1, created_at: datetime()})`,
          { userId: getUserId(req), query: cleanTerm }
        );
      } catch (_) {}
      return res.json({
        term: c.term,
        definition: c.answer,
        source: 'cache',
        cached_at: c.created_at,
      });
    }

    // Step 2: Check AI
    if (!getGenAI()) {
      const mockDefinition = `"${cleanTerm}" is a tech term. To get AI-powered definitions, please add your GEMINI_API_KEY to the backend/.env file.`;
      return res.json({ term: cleanTerm, definition: mockDefinition, source: 'mock' });
    }

    console.log(`[AI Lookup] "${cleanTerm}"`);
    let definition = null;
    let suggestions = [];

    const { page_context, page_title, conversation } = req.body;
    let prompt;

    if (conversation && Array.isArray(conversation) && conversation.length > 0) {
      const history = conversation.slice(-4).map(ex => `User: ${ex.term || ex.question}\nAssistant: ${ex.definition || ex.answer}`).join('\n\n');
      prompt = `You are a helpful tech educator having a CONTINUING conversation with a learner.\n\nPrevious conversation:\n${history}\n\nNow the user says: "${cleanTerm}"\n\n${page_context && page_context.trim().length > 10 ? `\nCurrent page context (for reference): ${page_context.slice(0, 500)}` : ''}\n\nAnswer their latest question naturally — it may be a follow-up, a clarification, or a new term.\nBe crisp and beginner-friendly (2-4 sentences). Never use bullet points.\n\nAlso suggest 2 related tech terms they might want to learn next as a JSON array at the end:\n---SUGGESTIONS\n["term1", "term2"]`;
    } else if (page_context && page_context.trim().length > 10) {
      prompt = `You are a helpful tech educator. Define this tech term in exactly 2-3 sentences, relating it to the context where it appears.\n\nTerm: "${cleanTerm}"\nPage Title: ${page_title || 'Unknown'}\nPage Context: ${page_context.slice(0, 1000)}\n\nExplain what this term means in plain language and how it relates to the current topic. Never use bullet points. Always write in plain sentences.\n\nAlso suggest 2 related tech terms they might want to learn next as a JSON array at the end:\n---SUGGESTIONS\n["term1", "term2"]`;
    } else {
      prompt = `You are a helpful tech educator. Define this tech term in exactly 2-3 sentences. Be crisp, precise, and beginner-friendly. Never use bullet points. Always write in plain sentences. Term: "${cleanTerm}"\n\nAlso suggest 2 related tech terms they might want to learn next as a JSON array at the end:\n---SUGGESTIONS\n["term1", "term2"]`;
    }

    try {
      definition = await callGemini(prompt);
      if (definition) {
        const suggestionsMatch = definition.match(/---SUGGESTIONS\s*(\[[\s\S]*?\])\s*$/);
        if (suggestionsMatch) {
          try {
            suggestions = JSON.parse(suggestionsMatch[1]);
            definition = definition.replace(/---SUGGESTIONS\s*\[[\s\S]*?\]\s*$/, '').trim();
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error('[AI API Error]', err.message);
      const isAuthError = err.message.includes('API key not valid') || err.message.includes('403');
      if (isAuthError) return res.status(401).json({ error: 'Gemini API key is invalid.' });
      return res.status(500).json({ error: 'Gemini is currently unavailable. Try again.' });
    }

    // Cache and log
    try {
      await session.run(
        `CREATE (c:Cache {id: randomUUID(), term: $term, answer: $answer, created_at: datetime()})`,
        { term: cleanTerm, answer: definition }
      );
    } catch (_) {}
    try {
      await session.run(
        `CREATE (sl:SearchLog {id: randomUUID(), user_id: $userId, query: $query, found: 1, created_at: datetime()})`,
        { userId: getUserId(req), query: cleanTerm }
      );
    } catch (_) {}

    return res.json({ term: cleanTerm, definition, source: 'ai', suggestions });
  } catch (err) {
    console.error('[Quick Lookup Error]', err.message);
    return res.status(500).json({ error: 'Lookup failed.' });
  } finally {
    await session.close();
  }
});

// POST /api/page-summary — Generate AI summary of a page
router.post('/page-summary', async (req, res) => {
  const { url, title, description, text_content } = req.body;
  const textPieces = [
    title && typeof title === 'string' ? `Title: ${title}` : '',
    description && typeof description === 'string' ? `Description: ${description}` : '',
    text_content && typeof text_content === 'string' ? text_content : '',
  ].filter(Boolean).join('\n\n');

  if (!textPieces || textPieces.trim().length < 20) {
    return res.status(400).json({ error: 'Not enough page content to summarize.' });
  }

  if (!getGenAI()) {
    return res.json({
      summary: `**${title || 'Page'}**\n\nTo enable remote AI summaries, add your GEMINI_API_KEY to the backend .env file or configure it in the extension settings.`,
      source: 'stub',
      title: title || 'Page Summary',
      url: url || '',
    });
  }

  try {
    const prompt = `You are a reading assistant. Summarize the following webpage content in 3-4 clear paragraphs.\n\nPage Title: ${title || 'Unknown'}\nPage URL: ${url || 'Unknown'}\nMeta Description: ${description || 'N/A'}\n\nPage Content:\n${textPieces.slice(0, 12000)}\n\nProvide:\n1. **Brief Summary** — 2-3 sentences capturing the core topic\n2. **Key Points** — 3-5 bullet points of the most important takeaways\n3. **Who Is This For** — one sentence on the target audience\n\nUse plain markdown formatting, no extra commentary.`;
    const summary = await callGemini(prompt);
    return res.json({ summary, title: title || 'Page Summary', url: url || '', source: 'ai' });
  } catch (err) {
    console.error('[Page Summary Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate summary.' });
  }
});

// POST /api/summarize — AI text summarization
router.post('/summarize', async (req, res) => {
  const { text, max_sentences, style } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide at least 10 characters of text to summarize.' });
  }

  const cleanText = sanitize(text, 12000);

  try {
    const result = await summarizeText(cleanText, { maxSentences: parseInt(max_sentences) || 3, style: style || 'concise' });
    if (!result.success) {
      return res.status(502).json({ error: `Summarization failed: ${result.error}`, fallback: cleanText.slice(0, 500) });
    }
    return res.json({ success: true, summary: result.summary, source: 'ai', model: config.model, length: result.summary.length });
  } catch (err) {
    console.error('[Summarize Critical Error]', err.message);
    return res.status(500).json({ error: 'Summarization service unavailable.', fallback: cleanText.slice(0, 500) });
  }
});

// POST /api/tag — Auto-tag content
router.post('/tag', async (req, res) => {
  const { text, max_tags } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide text (at least 5 chars) to extract tags from.' });
  }

  const cleanText = sanitize(text, 5000);

  try {
    const result = await generateTags(cleanText, { maxTags: parseInt(max_tags) || 5 });
    if (!result.success) {
      return res.status(502).json({ error: `Tagging failed: ${result.error}` });
    }
    return res.json({ success: true, tags: result.tags, count: result.tags.length });
  } catch (err) {
    console.error('[Tag Error]', err.message);
    return res.status(500).json({ error: 'Tagging service unavailable.' });
  }
});

// POST /api/analyze-url — Fetch + AI analyze any URL, auto-save to items
router.post('/analyze-url', async (req, res) => {
  const { url, title } = req.body;
  const user_id = getUserId(req);

  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format.' }); }

  const database = getDb();
  const session = database.session();

  try {
    // Check if we already have an item for this URL
    const existingRes = await session.run(
      `MATCH (u:User {id: $userId})-[:HAS_ITEM]->(i:Item) WHERE i.url = $url AND i.ai_summary IS NOT NULL AND i.ai_summary <> '' RETURN i ORDER BY i.created_at DESC LIMIT 1`,
      { userId: user_id, url }
    );

    if (existingRes.records.length > 0) {
      const ei = existingRes.records[0].get('i').properties;
      return res.json({
        summary: ei.ai_summary,
        tags: (ei.tags || '').split(',').filter(Boolean),
        item_id: ei.id,
        cached: true,
      });
    }

    // Fetch page content
    let pageContent = '';
    let fetchError = null;
    try {
      const response = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; easy-rewind/1.0)' } });
      pageContent = response.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000);
    } catch (fetchErr) {
      fetchError = fetchErr.message;
    }

    if (!pageContent || pageContent.length < 50) {
      return res.json({ summary: null, error: fetchError ? `Could not fetch page: ${fetchError}` : 'Page has minimal readable content' });
    }

    const summaryResult = await summarizeText(pageContent, { maxSentences: 4, style: 'concise' });
    let summary = summaryResult.success ? summaryResult.summary : '';
    let tags = [];

    const tagResult = await generateTags(pageContent, { maxTags: 5 });
    if (tagResult.success) tags = tagResult.tags;

    if (!summary && getGenAI()) {
      try {
        const prompt = `Summarize the following webpage in 3-4 concise sentences. Focus on the main topic and key takeaways.\n\nPage Title: ${title || 'Unknown'}\nPage URL: ${url}\n\nPage Content:\n${pageContent.slice(0, 4000)}\n\nSummary:`;
        summary = await callGemini(prompt);
      } catch (_) {}
    }

    if (!summary) summary = pageContent.slice(0, 300);

    // Auto-save to items
    try {
      const sourceType = detectSourceType(url);
      const createRes = await session.run(
        `MERGE (u:User {id: $userId})
         CREATE (i:Item {
           id: randomUUID(),
           url: $url,
           title: $title,
           content: $content,
           ai_summary: $summary,
           tags: $tags,
           source_type: $sourceType,
           memory_score: 0.5,
           interaction_count: 0,
           created_at: datetime(),
           updated_at: datetime()
         })
         CREATE (u)-[:HAS_ITEM]->(i)
         RETURN i`,
        { userId: user_id, url: sanitize(url, 2000), title: sanitize(title || 'Saved Page', 500), content: pageContent.slice(0, 2000), summary, tags: tags.join(','), sourceType }
      );
      const itemId = createRes.records[0] ? createRes.records[0].get('i').properties.id : null;

      // Generate embedding asynchronously
      generateEmbedding(pageContent || title)
        .then(async vec => {
          if (vec && Array.isArray(vec) && itemId) {
            try {
              const s = database.session();
              await s.run(`MATCH (i:Item {id: $id}) SET i.embedding = $emb`, { id: itemId, emb: JSON.stringify(vec) });
              await s.close();
            } catch (_) {}
          }
        })
        .catch(() => {});

      return res.json({ summary, tags, item_id: itemId, source: 'generated' });
    } catch (itemErr) {
      console.warn('[Analyze-URL] Auto-save failed:', itemErr.message);
      return res.json({ summary, tags, source: 'generated' });
    }
  } catch (err) {
    console.error('[Analyze-URL Error]', err.message);
    return res.status(500).json({ error: 'Failed to analyze URL.' });
  } finally {
    await session.close();
  }
});

module.exports = router;
