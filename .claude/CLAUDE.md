# easy-rewind — Knowledge Assistant

A Chrome extension + Electron desktop app + Node.js backend with SQLite for instant AI definitions, smart bookmarks, quick notes with reminders, and searchable history while browsing.

## Project Structure

```
easy-rewind/
├── backend/
│   ├── data/
│   │   └── easy-rewind.db   — SQLite database (auto-created)
│   ├── server.js              — Express server entry (CORS, rate limiting, routes, static files)
│   ├── routes/api.js          — All ~25 API endpoints + SQLite + Gemini AI
│   ├── package.json
│   └── .env                   — GEMINI_API_KEY
│
├── extension/
│   ├── manifest.json          — Manifest V3 config
│   ├── popup.html             — Extension popup UI (4 tabs: Search, Bookmark, Notes, History)
│   ├── popup.js               — All popup logic
│   ├── background.js          — Service worker (tab-close detection, alarms, notifications)
│   ├── content.js             — Page info reader (injected on all URLs)
│   └── icons/                 — Extension icons
│
├── desktop/
│   ├── main.js                — Electron tray + global shortcut
│   ├── preload.js             — Safe API bridge
│   ├── overlay.html           — Global overlay UI
│   ├── overlay.js             — Overlay logic
│   └── package.json           — Electron + electron-builder
│
├── frontend/
│   └── dashboard.html         — Analytics dashboard (pure HTML/CSS/JS)
│
└── database/
    └── setup.sql              — Reference schema (SQLite creates tables automatically)
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Chrome Extension** | Manifest V3, Vanilla JS, no framework |
| **Backend** | Node.js, Express.js |
| **Database** | SQLite (via `better-sqlite3`) |
| **AI** | Google Gemini (`gemini-2.5-flash`) — reads `GEMINI_API_KEY` from .env |
| **Desktop App** | Electron, system tray, global shortcut |
| **Dashboard** | Pure HTML/CSS/JS (no framework) |
| **Styling** | Dark purple theme, Inter font, CSS custom properties |

## API Endpoints (all under `http://localhost:5000/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/quick-lookup` | AI definition for a tech term (cached) |
| `POST` | `/bookmark` | Save a bookmark (with optional reminder + research) |
| `GET` | `/bookmarks` | List bookmarks (pagination, sort, topic filter) |
| `GET` | `/search?q=term` | Search bookmarks across topic, title, url, notes |
| `DELETE` | `/bookmark/:id` | Delete a bookmark |
| `POST` | `/notes` | Create a quick note with optional reminder |
| `GET` | `/notes` | List notes |
| `PATCH` | `/notes/:id/toggle` | Toggle note completed |
| `DELETE` | `/notes/:id` | Delete a note |
| `POST` | `/reminders` | Schedule a reminder |
| `GET` | `/reminders?due=true` | Get due/pending reminders |
| `PATCH` | `/reminders/:id` | Acknowledge/dismiss |
| `DELETE` | `/reminders/:id` | Delete a reminder |
| `POST` | `/research` | Queue AI deep-research on a URL |
| `GET` | `/research` | Get research results |
| `POST` | `/check-reminders` | Process due reminders |

**Headers**: All endpoints accept `x-user-id` for user identity.

## Code Conventions

- **JS style**: Vanilla JS, CommonJS (`require`/`module.exports`), no TypeScript
- **API responses**: Always JSON. Errors: `{ error: "message" }`. Success: varies.
- **Sanitization**: All user inputs go through `sanitize(str, maxLength)` — trim + slice
- **User ID**: Extracted via `getUserId(req)` — checks header → body → query param → falls back to `'anonymous'`
- **Status messages**: `showStatus(el, message, type, duration)` with types `success`/`error`/`loading`
- **Button loading**: `setButtonLoading(btn, loading, originalText)` — disables + shows spinner
- **XSS prevention**: `escapeHtml(str)` using DOM `textContent` + `innerHTML`
- **Relative time**: `formatRelativeTime(dateStr)` — "2h ago", "3d ago"
- **Caching**: AI definitions cached in `cache` table keyed by term (case-insensitive)
- **DB**: SQLite via `better-sqlite3` — synchronous API, auto-creates tables on first startup

## Running the Project

```bash
cd backend
npm install
npm start        # or: npm run dev (nodemon auto-restart)
```

Server runs on `http://localhost:5000`. Dashboard at `/dashboard`.

Chrome extension: load `extension/` as unpacked in `chrome://extensions` (developer mode).

Desktop app: `cd desktop && npm install && npm start`.

## Environment Variables

```env
PORT=5000
NODE_ENV=development
GEMINI_API_KEY=your_gemini_api_key_here
```

## Database (auto-created in `backend/data/easy-rewind.db`)

7 tables: `bookmarks`, `cache`, `search_log`, `notes`, `reminders`, `push_subscriptions`, `research_queue`.

Refer to `database/setup.sql` for the full schema.

## Common Tasks

- **Add an API endpoint**: Create route in `backend/routes/api.js` using `router.get/post/delete`, then call from extension/desktop
- **Modify extension UI**: Edit `extension/popup.html` (DOM) and `extension/popup.js` (logic/events)
- **Modify desktop overlay**: Edit `desktop/overlay.html` and `desktop/overlay.js`
- **Modify dashboard**: Edit `frontend/dashboard.html` — it's a single-file SPA
- **Change AI model**: Update `model` param in `routes/api.js` in `callGemini()` function

## Key File Locations

- AI lookup logic: `backend/routes/api.js`
- SQLite DB init: `backend/routes/api.js` — `getDb()` function
- Extension tab switching: `extension/popup.js`
- Extension tab-close detection: `extension/background.js`
- Electron tray + global shortcut: `desktop/main.js`
- Server health check: `backend/server.js`
- Dashboard: `frontend/dashboard.html`
