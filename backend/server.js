/**
 * easy-rewind Learning Assistant - Express Backend Server
 *
 * This is the main entry point for the backend API.
 * It handles CORS, rate limiting, middleware setup, and route registration.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// CORS Configuration
// Allows requests from Chrome extensions and local dashboard
// ─────────────────────────────────────────────
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) return callback(null, true);

    // Allow Chrome extensions (any extension ID)
    if (origin.startsWith('chrome-extension://')) return callback(null, true);

    // Allow local development origins
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5000',
      'http://127.0.0.1:5000',
      'http://127.0.0.1:3000',
    ];

    if (allowedOrigins.includes(origin)) return callback(null, true);

    // Block all other origins
    callback(new Error(`CORS policy: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
  credentials: true,
};

app.use(cors(corsOptions));

// ─────────────────────────────────────────────
// Rate Limiting
// Prevents abuse of the AI lookup endpoint
// ─────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // max 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 AI lookups per minute (cached responses bypass this)
  message: { error: 'Too many AI lookups. Please wait a moment.' },
});

app.use(generalLimiter);

// ─────────────────────────────────────────────
// Security Headers (CSP, XSS, etc.)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' http://localhost:*"
  );
  next();
});

// ─────────────────────────────────────────────
// Body Parsing Middleware
// ─────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
// Request Logging with timing
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  // Capture response finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'WARN' : 'INFO';
    const emoji = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️' : '✅';
    console.log(`${emoji} [${timestamp}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
  });

  next();
});

// ─────────────────────────────────────────────
// Serve Dashboard Website
// The dashboard.html is served from the frontend folder
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html'));
});

// Root redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ─────────────────────────────────────────────
// API Routes
// Apply AI-specific rate limiter only to the quick-lookup route
// ─────────────────────────────────────────────
app.use('/api/quick-lookup', aiLimiter);
app.use('/api', apiRoutes);

// ─────────────────────────────────────────────
// Global Error Handler
// Catches any unhandled errors and returns clean JSON responses
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);

  // CORS errors
  if (err.message && err.message.startsWith('CORS policy')) {
    return res.status(403).json({ error: 'Request blocked by CORS policy.' });
  }

  res.status(500).json({
    error: 'Internal server error. Please try again.',
    ...(process.env.NODE_ENV === 'development' && { details: err.message }),
  });
});

// ─────────────────────────────────────────────
// 404 Handler for unmatched routes
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     easy-rewind Learning Assistant       ║');
  console.log('║        Backend Server Running             ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  API:       http://localhost:${PORT}/api     ║`);
  console.log(`║  Dashboard: http://localhost:${PORT}/dashboard ║`);
  console.log(`║  Health:    http://localhost:${PORT}/api/health ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Warn if Gemini API key is not set
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    console.warn('WARNING: Gemini API key not configured in .env');
    console.warn('   AI quick-lookup will use mock responses until configured.\n');
  }

  // Auto-check reminders every 2 minutes (built-in, no extension needed)
  setInterval(
    async () => {
      try {
        await axios.post(
          `http://localhost:${PORT}/api/check-reminders`,
          {},
          {
            headers: { 'Content-Type': 'application/json', 'x-user-id': 'system' },
          }
        );
      } catch (_) {
        /* silent — server self-check is best-effort */
      }
    },
    2 * 60 * 1000
  );
  console.log('[Reminders] Auto-check every 2 minutes enabled\n');

  // Weekly digest auto-generation — checks every hour if a digest is due
  setInterval(
    async () => {
      try {
        const { config, loadSettings } = require('./routes/helpers');
        loadSettings();
        const prefs = config.digestPrefs || {};
        if (!prefs.enabled) return;

        // Check if a digest is due (once per week on the configured day+hour)
        const now = new Date();
        const currentDay = now.getDay();
        const currentHour = now.getHours();
        const targetDay = prefs.day_of_week ?? 0;
        const targetHour = prefs.hour ?? 9;

        if (currentDay !== targetDay || currentHour !== targetHour) return;

        // Only generate if no digest was generated today
        const today = now.toISOString().slice(0, 10);
        if (prefs.last_digest_at && prefs.last_digest_at.startsWith(today)) return;

        // Also check that we're not too early in the hour (wait 5 min for clock jitter)
        if (now.getMinutes() > 15) return;

        await axios.post(
          `http://localhost:${PORT}/api/digest/generate`,
          {},
          {
            headers: { 'Content-Type': 'application/json', 'x-user-id': 'system' },
          }
        );

        // Update last_digest_at
        prefs.last_digest_at = now.toISOString();
        config.digestPrefs = prefs;
        try {
          const { saveSettings } = require('./routes/helpers');
          saveSettings();
        } catch (_) {}

        console.log(`[Digest] Auto-generated weekly digest at ${now.toISOString()}`);
      } catch (_) {
        /* silent — best-effort */
      }
    },
    60 * 60 * 1000
  ); // Check once per hour
  console.log('[Digest] Weekly auto-digest enabled (hourly check)\n');
});

module.exports = app;
