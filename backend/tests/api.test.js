const request = require('supertest');
const app = require('../server');
const path = require('path');
const fs = require('fs');

// Use a test database path
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'easy-rewind-test.db');

beforeAll(() => {
  // Clean up any existing test DB
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  // Override DB path before server modules init
  process.env.TEST_DB = TEST_DB_PATH;
});

afterAll(() => {
  // Clean up test DB
  try {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Also remove WAL and SHM files
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch (_) {}
});

const USER_ID = 'test-user-123';
const headers = { 'x-user-id': USER_ID };

describe('Health Endpoint', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toContain('easy-rewind');
  });
});

describe('Bookmark Endpoints', () => {
  let bookmarkId;

  test('POST /api/bookmark creates a bookmark', async () => {
    const res = await request(app).post('/api/bookmark').set(headers).send({
      url: 'https://example.com/test',
      title: 'Test Page',
      topic: 'testing',
      notes: 'A test bookmark',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bookmark).toBeDefined();
    expect(res.body.bookmark.url).toBe('https://example.com/test');
    bookmarkId = res.body.bookmark.id;
  });

  test('POST /api/bookmark rejects missing URL', async () => {
    const res = await request(app).post('/api/bookmark').set(headers).send({ topic: 'testing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/bookmark rejects missing title', async () => {
    const res = await request(app)
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'https://example.com', topic: 'testing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Title is required.');
  });

  test('POST /api/bookmark rejects missing topic', async () => {
    const res = await request(app)
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'https://example.com', title: 'Test Page' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/bookmark rejects invalid URL', async () => {
    const res = await request(app)
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'not-a-url', title: 'Test Page', topic: 'testing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid URL');
  });

  test('GET /api/bookmarks returns bookmarks', async () => {
    const res = await request(app).get('/api/bookmarks').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bookmarks)).toBe(true);
    expect(res.body.bookmarks.length).toBeGreaterThan(0);
  });

  test('GET /api/bookmarks supports pagination', async () => {
    const res = await request(app).get('/api/bookmarks?limit=5&offset=0').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.bookmarks.length).toBeLessThanOrEqual(5);
  });

  test('GET /api/search finds bookmarks', async () => {
    const res = await request(app).get('/api/search?q=Test').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  test('GET /api/search returns 400 without query', async () => {
    const res = await request(app).get('/api/search').set(headers);
    expect(res.status).toBe(400);
  });

  test('DELETE /api/bookmark/:id deletes bookmark', async () => {
    const res = await request(app).delete(`/api/bookmark/${bookmarkId}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /api/bookmark/:id rejects invalid ID', async () => {
    const res = await request(app).delete('/api/bookmark/invalid').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('Notes Endpoints', () => {
  let noteId;

  test('POST /api/notes creates a note', async () => {
    const res = await request(app).post('/api/notes').set(headers).send({
      content: 'This is a test note',
      source_url: 'https://example.com',
      source_title: 'Example',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.note).toBeDefined();
    noteId = res.body.note.id;
  });

  test('POST /api/notes rejects empty content', async () => {
    const res = await request(app).post('/api/notes').set(headers).send({ content: '' });
    expect(res.status).toBe(400);
  });

  test('GET /api/notes returns notes', async () => {
    const res = await request(app).get('/api/notes').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notes)).toBe(true);
  });

  test('PATCH /api/notes/:id/toggle toggles completed', async () => {
    const res = await request(app).patch(`/api/notes/${noteId}/toggle`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });

  test('PATCH /api/notes/:id/toggle toggles back', async () => {
    const res = await request(app).patch(`/api/notes/${noteId}/toggle`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(false);
  });

  test('PATCH /api/notes/:id/toggle rejects invalid ID', async () => {
    const res = await request(app).patch('/api/notes/invalid/toggle').set(headers);
    expect(res.status).toBe(400);
  });

  test('DELETE /api/notes/:id deletes note', async () => {
    const res = await request(app).delete(`/api/notes/${noteId}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Reminders Endpoints', () => {
  let reminderId;

  test('POST /api/reminders creates a reminder', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const res = await request(app).post('/api/reminders').set(headers).send({
      title: 'Test Reminder',
      message: 'This is a test reminder',
      remind_at: future,
      reminder_type: 'custom',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    reminderId = res.body.reminder.id;
  });

  test('POST /api/reminders rejects missing title', async () => {
    const res = await request(app).post('/api/reminders').set(headers).send({ remind_at: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  test('POST /api/reminders rejects missing timestamps', async () => {
    const res = await request(app).post('/api/reminders').set(headers).send({ title: 'Test' });
    expect(res.status).toBe(400);
  });

  test('GET /api/reminders returns reminders', async () => {
    const res = await request(app).get('/api/reminders').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reminders)).toBe(true);
  });

  test('PATCH /api/reminders/:id acknowledges reminder', async () => {
    const res = await request(app).patch(`/api/reminders/${reminderId}`).set(headers).send({ reminded: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('PATCH /api/reminders/:id rejects invalid ID', async () => {
    const res = await request(app).patch('/api/reminders/invalid').set(headers).send({ reminded: true });
    expect(res.status).toBe(400);
  });

  test('DELETE /api/reminders/:id deletes reminder', async () => {
    const res = await request(app).delete(`/api/reminders/${reminderId}`).set(headers);
    expect(res.status).toBe(200);
  });
});

describe('Research Endpoints', () => {


  test('POST /api/research queues research (no auto-process)', async () => {
    const res = await request(app).post('/api/research').set(headers).send({
      url: 'https://example.com/article',
      title: 'Test Article',
      user_notes: 'Interesting',
      auto_process: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

  });

  test('POST /api/research rejects missing URL', async () => {
    const res = await request(app).post('/api/research').set(headers).send({ title: 'Test' });
    expect(res.status).toBe(400);
  });

  test('POST /api/research rejects invalid URL', async () => {
    const res = await request(app).post('/api/research').set(headers).send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  test('GET /api/research returns queued items', async () => {
    const res = await request(app).get('/api/research').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.research)).toBe(true);
  });
});

describe('Highlights Endpoints', () => {
  let highlightId;

  test('POST /api/highlights saves a highlight', async () => {
    const res = await request(app).post('/api/highlights').set(headers).send({
      url: 'https://example.com',
      page_title: 'Example',
      text: 'Important text to highlight',
      context: 'Some surrounding context',
      color: 'yellow',
    });
    expect(res.status).toBe(200);
    expect(res.body.highlight).toBeDefined();
    highlightId = res.body.highlight.id;
  });

  test('POST /api/highlights rejects missing text', async () => {
    const res = await request(app).post('/api/highlights').set(headers).send({ url: 'https://example.com' });
    expect(res.status).toBe(400);
  });

  test('GET /api/highlights returns highlights', async () => {
    const res = await request(app).get('/api/highlights').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.highlights)).toBe(true);
  });

  test('DELETE /api/highlights/:id deletes highlight', async () => {
    const res = await request(app).delete(`/api/highlights/${highlightId}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Export/Import Endpoints', () => {
  test('GET /api/export returns user data', async () => {
    const res = await request(app).get('/api/export').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.version).toBeDefined();
    expect(res.body.data).toBeDefined();
    expect(res.body.data.bookmarks).toBeDefined();
  });

  test('POST /api/import with valid data succeeds', async () => {
    const res = await request(app)
      .post('/api/import')
      .set(headers)
      .send({
        data: {
          bookmarks: [],
          notes: [],
          highlights: [],
          research: [],
          reminders: [],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Settings Endpoints', () => {
  test('GET /api/settings returns settings', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.ai_configured).toBeDefined();
  });

  test('POST /api/settings updates settings', async () => {
    const res = await request(app).post('/api/settings').set(headers).send({
      spaced_review_enabled: true,
      review_interval_days: 7,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Logging Endpoints', () => {
  test('POST /api/log stores an error log', async () => {
    const res = await request(app).post('/api/log').set(headers).send({
      level: 'ERROR',
      component: 'test',
      message: 'Test error',
      stack: 'Test stack trace',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('GET /api/logs returns recent logs', async () => {
    const res = await request(app).get('/api/logs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});

describe('Knowledge Graph Endpoints', () => {
  test('GET /api/knowledge-graph returns graph data', async () => {
    const res = await request(app).get('/api/knowledge-graph').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.nodes).toBeDefined();
    expect(res.body.edges).toBeDefined();
  });
});

describe('Review Digest Endpoint', () => {
  test('GET /api/review-digest returns digest', async () => {
    const res = await request(app).get('/api/review-digest').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.stats).toBeDefined();
    expect(res.body.review_items).toBeDefined();
  });
});

describe('Flashcard Endpoints', () => {
  let flashcardId;

  test('POST /api/flashcards creates a flashcard', async () => {
    const res = await request(app).post('/api/flashcards').set(headers).send({
      term: 'What is the DOM?',
      definition: 'Document Object Model — a programming interface for web documents',
      source: 'manual',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.flashcard).toBeDefined();
    expect(res.body.flashcard.term).toBe('What is the DOM?');
    expect(res.body.flashcard.definition).toContain('Document Object Model');
    flashcardId = res.body.flashcard.id;
  });

  test('POST /api/flashcards rejects missing term', async () => {
    const res = await request(app).post('/api/flashcards').set(headers).send({ definition: 'Some definition' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/flashcards rejects missing definition', async () => {
    const res = await request(app).post('/api/flashcards').set(headers).send({ term: 'Some term' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('GET /api/flashcards returns flashcards', async () => {
    const res = await request(app).get('/api/flashcards').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flashcards)).toBe(true);
    expect(res.body.flashcards.length).toBeGreaterThan(0);
  });

  test('GET /api/flashcards?due=true returns due cards', async () => {
    // The test card has next_review_at = now (default), so it should be due
    const res = await request(app).get('/api/flashcards?due=true').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flashcards)).toBe(true);
  });

  test('PATCH /api/flashcards/:id/review with quality 5', async () => {
    const res = await request(app).patch(`/api/flashcards/${flashcardId}/review`).set(headers).send({ quality: 5 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.flashcard).toBeDefined();
    expect(res.body.flashcard.repetitions).toBe(1);
    expect(res.body.flashcard.interval_days).toBe(1);
  });

  test('PATCH /api/flashcards/:id/review with quality 1 resets', async () => {
    const res = await request(app).patch(`/api/flashcards/${flashcardId}/review`).set(headers).send({ quality: 1 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.flashcard.repetitions).toBe(0);
    expect(res.body.flashcard.interval_days).toBe(1);
  });

  test('PATCH /api/flashcards/:id/review rejects invalid quality', async () => {
    const res = await request(app).patch(`/api/flashcards/${flashcardId}/review`).set(headers).send({ quality: 10 });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/flashcards/:id/review rejects invalid ID', async () => {
    const res = await request(app).patch('/api/flashcards/invalid/review').set(headers).send({ quality: 3 });
    expect(res.status).toBe(400);
  });

  test('POST /api/flashcards/generate generates from bookmarks', async () => {
    // First ensure a bookmark exists
    await request(app).post('/api/bookmark').set(headers).send({
      url: 'https://example.com/flashcard-gen',
      title: 'Flashcard Gen Test',
      topic: 'flashcard-testing',
    });

    const res = await request(app).post('/api/flashcards/generate').set(headers).send({ source_type: 'bookmark' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.inserted).toBe('number');
  });

  test('DELETE /api/flashcards/:id deletes flashcard', async () => {
    const res = await request(app).delete(`/api/flashcards/${flashcardId}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /api/flashcards/:id rejects invalid ID', async () => {
    const res = await request(app).delete('/api/flashcards/invalid').set(headers);
    expect(res.status).toBe(400);
  });
});

describe('Error Handling', () => {
  test('GET /api/nonexistent returns 404', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
  });

  test('POST /api/quick-lookup with no body returns 400', async () => {
    const res = await request(app).post('/api/quick-lookup').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});
