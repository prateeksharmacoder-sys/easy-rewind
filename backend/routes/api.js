/**
 * easy-rewind — API Route Index
 *
 * Mounts domain sub-routers under their feature paths.
 * All endpoints are namespaced under /api (set in server.js).
 *
 * Sub-modules:
 *   ai.js       — POST /api/quick-lookup, /api/page-summary, /api/summarize, /api/tag
 *   content.js  — Bookmarks, Notes, Reminders, Search, Check-Reminders
 *   memory.js   — Items, Highlights, Connections, Knowledge-Graph, Vector Search, RAG Ask, Review-Digest
 *   system.js   — Health, Session, Users, Research, Push, Export/Import, Settings, Logging
 */

const express = require('express');
const router = express.Router();

router.use(require('./ai'));
router.use(require('./content'));
router.use(require('./memory'));
router.use(require('./system'));
router.use(require('./quiz'));
router.use(require('./digest'));

module.exports = router;
