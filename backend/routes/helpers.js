/**
 * easy-rewind Learning Assistant — Shared Helpers
 *
 * Extracted from api.js for modularity. All utility functions, runtime config,
 * AI helpers, and database operations that are shared across route modules.
 */

const path = require('path');
const fs = require('fs');
const neo4j = require('neo4j-driver');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ─────────────────────────────────────────────
// Runtime Configuration (mutable — changes visible to all importers)
// ─────────────────────────────────────────────
const config = {
  apiKey: process.env.GEMINI_API_KEY || null,
  model: 'gemini-2.5-flash',
  apiBaseUrl: 'http://localhost:5000',
  summarizationBackend: 'auto',
  spacedReviewEnabled: true,
  reviewIntervalDays: 3,
  profileUserId: null,
  embedProvider: 'auto',
};

let db = null; // This will hold the Neo4j driver
let genAI = null;

// ─────────────────────────────────────────────
// Neo4j Database Setup
// ─────────────────────────────────────────────
function getDb() {
  if (db) return db;

  const uri = process.env.NEO4J_URI || 'neo4j://localhost:7687';
  const user = process.env.NEO4J_USERNAME || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || 'password';

  try {
    db = neo4j.driver(uri, neo4j.auth.basic(user, password));
    console.log(`[DB] Neo4j Driver initialized for ${uri}`);

    // Create constraints and indexes asynchronously
    const session = db.session();
    
    const constraints = [
      'CREATE CONSTRAINT IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
      'CREATE CONSTRAINT IF NOT EXISTS FOR (c:Cache) REQUIRE c.term IS UNIQUE',
      'CREATE INDEX IF NOT EXISTS FOR (b:Bookmark) ON (b.created_at)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Note) ON (n.created_at)',
      'CREATE INDEX IF NOT EXISTS FOR (r:Reminder) ON (r.remind_at)',
      'CREATE INDEX IF NOT EXISTS FOR (i:Item) ON (i.url)',
      'CREATE INDEX IF NOT EXISTS FOR (h:Highlight) ON (h.url)'
    ];

    const runConstraints = async () => {
      try {
        for (const query of constraints) {
          await session.run(query);
        }
        console.log('[DB] Neo4j Constraints & Indexes verified.');
      } catch (err) {
        console.warn('[DB] Could not create constraints:', err.message);
      } finally {
        await session.close();
      }
    };
    
    runConstraints();

  } catch (err) {
    console.error('[DB] Failed to initialize Neo4j:', err);
  }

  return db;
}

// ─────────────────────────────────────────────
// Settings (persisted to settings.json)
// ─────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(raw);
      const savedKey = saved.apiKey || saved.gemini_api_key;
      // Only override with saved key if it's not the placeholder AND not empty
      if (savedKey && savedKey !== 'your_gemini_api_key_here') {
        config.apiKey = savedKey;
      }
      if (saved.apiBaseUrl || saved.api_base_url)
        config.apiBaseUrl = saved.apiBaseUrl || saved.api_base_url || 'http://localhost:5000';
      if (saved.summarizationBackend || saved.summarization_backend)
        config.summarizationBackend = saved.summarizationBackend || saved.summarization_backend || 'auto';
      if (saved.spacedReviewEnabled !== undefined) config.spacedReviewEnabled = saved.spacedReviewEnabled;
      if (saved.reviewIntervalDays) config.reviewIntervalDays = parseInt(saved.reviewIntervalDays) || 3;
      if (saved.embedProvider) config.embedProvider = saved.embedProvider || 'auto';
      if (saved.model || saved.ai_model) {
        const model = saved.model || saved.ai_model;
        const deprecatedModels = ['gemini-1.5-pro', 'gemini-1.0-pro'];
        config.model = deprecatedModels.includes(model) ? 'gemini-2.5-flash' : model || 'gemini-2.5-flash';
      }
      if (saved.digestPrefs) config.digestPrefs = saved.digestPrefs;
      if (saved.profileUserId) config.profileUserId = saved.profileUserId;
      if (!config.profileUserId) {
        config.profileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        saveSettings();
      }
      console.log(
        `[Settings] Loaded: model=${config.model}, summarization=${config.summarizationBackend}, has_key=!!${!!config.apiKey}`
      );
    } else {
      config.profileUserId = 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      saveSettings();
    }
  } catch (err) {
    console.warn('[Settings] Could not load settings file:', err.message);
    config.profileUserId =
      config.profileUserId || 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

function saveSettings() {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      SETTINGS_PATH,
      JSON.stringify(
        {
          apiKey: config.apiKey || '',
          model: config.model,
          apiBaseUrl: config.apiBaseUrl,
          summarizationBackend: config.summarizationBackend,
          spacedReviewEnabled: !!config.spacedReviewEnabled,
          reviewIntervalDays: config.reviewIntervalDays,
          profileUserId: config.profileUserId,
          embedProvider: config.embedProvider,
          digestPrefs: config.digestPrefs || null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn('[Settings] Could not save settings file:', err.message);
  }
}

// Load settings on module init
loadSettings();

// ─────────────────────────────────────────────
// Gemini AI Client
// ─────────────────────────────────────────────
function getGenAI() {
  const aiKey = config.apiKey || process.env.GEMINI_API_KEY;
  if (!aiKey || aiKey === 'your_gemini_api_key_here') return null;
  if (!genAI) genAI = new GoogleGenerativeAI(aiKey);
  return genAI;
}

function resetGenAI() {
  genAI = null;
}

async function callGemini(prompt) {
  const ai = getGenAI();
  if (!ai) return null;
  const model = ai.getGenerativeModel({ model: config.model });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ─────────────────────────────────────────────
// General Helpers
// ─────────────────────────────────────────────
function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.user_id || req.query?.user_id || 'anonymous';
}

function normalizeDate(dateValue) {
  if (!dateValue) return null;
  if (dateValue instanceof Date && !isNaN(dateValue.getTime())) return dateValue.toISOString();
  if (typeof dateValue !== 'string') return null;
  const normalized = dateValue.trim().replace(' ', 'T');
  const withZone = normalized.endsWith('Z') ? normalized : normalized + 'Z';
  const date = new Date(withZone);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeUserId(value) {
  const cleaned = sanitize(value || '', 120);
  return cleaned || config.profileUserId || 'anonymous';
}

async function createReminder(database, userId, reminder) {
  const remindAt = normalizeDate(reminder.remind_at) || new Date().toISOString();
  const repeatIntervalDays = Math.max(0, parseInt(reminder.repeat_interval_days) || 0);
  const maxRepeats =
    reminder.max_repeats === undefined || reminder.max_repeats === null
      ? null
      : Math.max(0, parseInt(reminder.max_repeats));
  const repeatCount = Math.max(0, parseInt(reminder.repeat_count) || 0);

  const session = database.session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})
      CREATE (r:Reminder {
        id: randomUUID(),
        reminder_type: $reminder_type,
        reference_type: $reference_type,
        reference_id: $reference_id,
        title: $title,
        message: $message,
        remind_at: datetime($remind_at),
        repeat_interval_days: $repeat_interval_days,
        repeat_count: $repeat_count,
        max_repeats: $max_repeats,
        next_review_at: $next_review_at,
        reminded: 0,
        dismissed: 0,
        created_at: datetime()
      })
      CREATE (u)-[:HAS_REMINDER]->(r)
      RETURN r
      `,
      {
        userId,
        reminder_type: reminder.reminder_type || 'custom',
        reference_type: reminder.reference_type || null,
        reference_id: reminder.reference_id ? String(reminder.reference_id) : null,
        title: sanitize(reminder.title || 'Reminder', 200),
        message: sanitize(reminder.message || '', 1000),
        remind_at: remindAt,
        repeat_interval_days: repeatIntervalDays || null,
        repeat_count: repeatCount,
        max_repeats: maxRepeats,
        next_review_at: reminder.next_review_at ? reminder.next_review_at : null
      }
    );
    return result.records[0] ? result.records[0].get('r').properties : null;
  } finally {
    await session.close();
  }
}

/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Calculates the next review interval and eased factor based on the quality
 * of recall (0-5). Quality >= 3 is considered a successful recall.
 *
 * @param {number} quality — recall quality 0-5 (0=forgotten, 5=perfect)
 * @param {object} card   — {ease_factor, interval_days, repetitions}
 * @returns {{ ease_factor: number, interval_days: number, repetitions: number, next_review_at: string }}
 */
function calculateNextReview(quality, card = {}) {
  const ef = Math.max(1.3, card.ease_factor || 2.5);
  const interval = Math.max(0, parseInt(card.interval_days) || 0);
  const reps = parseInt(card.repetitions) || 0;

  let newEf, newInterval, newReps;

  if (quality >= 3) {
    // Correct recall
    if (reps === 0) {
      newInterval = 1;
    } else if (reps === 1) {
      newInterval = 6;
    } else {
      newInterval = Math.round(interval * ef);
    }
    newReps = reps + 1;
  } else {
    // Incorrect recall — reset
    newInterval = 1;
    newReps = 0;
  }

  // Update ease factor using SM-2 formula
  newEf = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

  const nextDate = new Date(Date.now() + newInterval * 24 * 60 * 60 * 1000);
  return {
    ease_factor: Math.round(newEf * 100) / 100,
    interval_days: newInterval,
    repetitions: newReps,
    next_review_at: nextDate.toISOString(),
  };
}

async function scheduleNextReview(database, reminder) {
  if (!config.spacedReviewEnabled) return null;
  const intervalDays = parseInt(reminder.repeat_interval_days) || config.reviewIntervalDays || 3;
  const maxRepeats =
    reminder.max_repeats === null || reminder.max_repeats === undefined ? null : parseInt(reminder.max_repeats);
  const repeatCount = parseInt(reminder.repeat_count) || 0;
  if (!intervalDays || (maxRepeats !== null && repeatCount >= maxRepeats)) return null;

  const nextAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
  return await createReminder(database, reminder.user_id, {
    reminder_type: reminder.reminder_type,
    reference_type: reminder.reference_type,
    reference_id: reminder.reference_id,
    title: `Review again: ${sanitize(reminder.title || 'Saved item', 160)}`,
    message: reminder.message || 'Time for your next spaced review.',
    remind_at: nextAt,
    repeat_interval_days: intervalDays,
    repeat_count: repeatCount + 1,
    max_repeats,
  });
}

function sanitize(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

function isValidId(id) {
  if (!id) return false;
  const num = parseInt(id);
  return !isNaN(num) && num > 0 && String(num) === String(id);
}

async function sendPushNotification(userId, title, body) {
  console.log(`[Push] Would notify ${userId}: "${title}" — ${body}`);
}

// ─────────────────────────────────────────────
// Embedding Helpers
// ─────────────────────────────────────────────
async function generateEmbedding(text) {
  const trimmed = text.trim().slice(0, 8000);
  const provider = config.embedProvider || 'auto';

  if (provider === 'openai' || (provider === 'auto' && config.apiKey && config.apiKey.startsWith('sk-'))) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { input: trimmed, model: 'text-embedding-ada-002' },
        { headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' } }
      );
      if (response.data?.data?.[0]?.embedding) {
        return response.data.data[0].embedding;
      }
    } catch (err) {
      console.warn('[Embedding] OpenAI embedding failed:', err.message);
    }
    if (provider === 'openai') {
      console.warn('[Embedding] OpenAI explicitly selected but failed, using hash fallback');
      return generateHashEmbedding(trimmed, 128);
    }
  }

  const ai = getGenAI();
  if (ai && provider !== 'openai') {
    try {
      const embedModel = ai.getGenerativeModel({ model: 'text-embedding-004' });
      const result = await embedModel.embedContent(trimmed);
      const vector = result?.embedding?.values;
      if (vector && Array.isArray(vector) && vector.length > 0) {
        return vector;
      }
    } catch (err) {
      console.warn('[Embedding] Gemini embedding failed, trying fallback:', err.message);
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('[Embedding] Using hash fallback (no AI embedding provider configured)');
  }
  return generateHashEmbedding(trimmed, 128);
}

function generateHashEmbedding(text, dimensions = 128) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const vector = new Array(dimensions).fill(0);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= magnitude;
    }
  }
  return vector;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(embeddingStr) {
  try {
    if (typeof embeddingStr === 'string') return JSON.parse(embeddingStr);
    if (Array.isArray(embeddingStr)) return embeddingStr;
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// AI Summarization Helper
// ─────────────────────────────────────────────
async function summarizeText(text, options = {}) {
  const { maxSentences = 3, style = 'concise' } = options;
  const trimmed = text.trim().slice(0, 12000);
  if (!trimmed) return { success: false, error: 'No text to summarize' };

  const ai = getGenAI();
  if (!ai) {
    return { success: false, error: 'AI not configured — set GEMINI_API_KEY in .env or runtime settings' };
  }

  const styleGuide =
    style === 'concise'
      ? `Summarize the following content in ${maxSentences} clear, concise sentences. Focus on the core message. Use plain language.`
      : style === 'bullet'
        ? `Summarize the following content as ${maxSentences} bullet points. Each point should be one line.`
        : `Summarize the following content in ${maxSentences} sentences. Be thorough but concise.`;

  const prompt = `${styleGuide}

Content:
${trimmed}

Summary:`;

  try {
    const summary = await callGemini(prompt);
    if (!summary) return { success: false, error: 'AI returned empty response' };
    return { success: true, summary: summary.trim() };
  } catch (err) {
    console.error('[Summarize Error]', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// Auto-Tagging Helper
// ─────────────────────────────────────────────
async function generateTags(text, options = {}) {
  const { maxTags = 5 } = options;
  const trimmed = text.trim().slice(0, 3000);
  if (!trimmed) return { success: false, error: 'No text to tag', tags: [] };

  const ai = getGenAI();
  if (!ai) {
    const words = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    const sorted = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTags);
    return { success: true, tags: sorted.map(([tag]) => tag) };
  }

  const prompt = `Extract up to ${maxTags} key tags or topics from the following text.
Return ONLY a JSON array of strings, like: ["tag1", "tag2", "tag3"]
No explanation, no formatting, just the array.

Text:
${trimmed}

Tags:`;

  try {
    const result = await callGemini(prompt);
    if (!result) return { success: true, tags: [] };

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : result;
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return {
        success: true,
        tags: parsed
          .slice(0, maxTags)
          .map(t => String(t).trim())
          .filter(Boolean),
      };
    }
    return { success: true, tags: [] };
  } catch (err) {
    console.warn('[Tag Generation Error]', err.message);
    return { success: true, tags: [] };
  }
}

async function storeItemTags(database, itemId, tags) {
  if (!tags || tags.length === 0) return;

  const session = database.session();
  try {
    const validTags = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
    if (validTags.length === 0) return;

    await session.run(
      `
      MATCH (i:Item {id: $itemId})
      OPTIONAL MATCH (i)-[r:HAS_TAG]->(old:Tag)
      DELETE r
      WITH i
      UNWIND $tags as tagName
      MERGE (t:Tag {name: tagName})
      MERGE (i)-[:HAS_TAG]->(t)
      SET i.tags = $tagString
      `,
      {
        itemId: String(itemId),
        tags: validTags,
        tagString: validTags.join(',')
      }
    );
  } finally {
    await session.close();
  }
}

// ─────────────────────────────────────────────
// Source Type Detection
// ─────────────────────────────────────────────
function detectSourceType(url) {
  if (!url) return 'web';
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('github.com')) return 'github';
  if (u.includes('medium.com') || u.includes('substack.com') || u.includes('blog.')) return 'blog';
  if (
    u.includes('news.') ||
    u.includes('reuters.com') ||
    u.includes('cnn.com') ||
    u.includes('bbc.com') ||
    u.includes('nytimes.com') ||
    u.includes('theguardian.com')
  )
    return 'news';
  try {
    const parsed = new URL(u);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const isDocsDomain =
      u.includes('docs.') ||
      u.includes('learn.') ||
      u.includes('wiki.') ||
      parsed.hostname.endsWith('.dev') ||
      parsed.hostname.endsWith('.io') ||
      parsed.hostname.includes('developer') ||
      parsed.hostname.includes('dev.');
    const hasDocsPath =
      pathSegments.some(s => ['docs', 'learn', 'tutorial', 'guide', 'manual', 'reference'].includes(s)) ||
      pathSegments.some(s => s.startsWith('doc') && s.length < 10);
    if (isDocsDomain || hasDocsPath) return 'docs';
  } catch (_) {
    /* Invalid URL — treat as web */
  }
  return 'web';
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────
module.exports = {
  config,
  getDb,
  loadSettings,
  saveSettings,
  getGenAI,
  resetGenAI,
  callGemini,
  getUserId,
  normalizeDate,
  sanitizeUserId,
  createReminder,
  scheduleNextReview,
  calculateNextReview,
  sanitize,
  isValidId,
  sendPushNotification,
  generateEmbedding,
  generateHashEmbedding,
  cosineSimilarity,
  parseEmbedding,
  summarizeText,
  generateTags,
  storeItemTags,
  detectSourceType,
};
