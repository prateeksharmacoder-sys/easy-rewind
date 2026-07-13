# ⏪ easy-rewind — Knowledge Assistant

> **Capture ideas. Define terms. Research later. Never forget.**

One tool that lives everywhere — Chrome, Windows tray, Android — catching things before they fall through the cracks.

## The 4 Problems It Solves

| # | Problem | Solution |
|---|---------|----------|
| 1 | **Context switching** — search breaks focus | **Quick AI lookup** without leaving your tab. Shortcut: `Ctrl+Shift+E` |
| 2 | **"Research later"** — amazing things you forget to revisit | **Save + AI deep research**. Bookmark a page, get AI analysis, get reminded |
| 3 | **"I know I saw this"** — can't find that solution you watched | **Full-text searchable history** across all bookmarks |
| 4 | **Ephemeral thoughts** — "I'll do it after this meeting" → forget | **Quick notes with tab-close detection**. Leave the tab → instant reminder |

## Quick Start

### 1. Backend

```bash
cd backend
npm install
# Edit .env with your real credentials
npm start
# → http://localhost:5000/api/health
```

### 2. Chrome Extension

1. Open `chrome://extensions` → Developer mode
2. "Load unpacked" → select `extension/` folder
3. Press `Ctrl+Shift+E` to open the popup

### 3. Windows Desktop App

```bash
cd desktop
npm install
npm start        # Run in dev mode
npm run build    # Build Windows installer
```

Global shortcut: `Ctrl+Shift+Space` to open overlay from anywhere.

---

## Project Structure

```
easy-rewind/
├── backend/
│   ├── server.js              — Express server (CORS, rate limiting, static files)
│   ├── routes/                — API endpoints + Neo4j + Gemini AI
│   ├── .env                   — Your credentials
│   └── package.json
│
├── extension/
│   ├── manifest.json           — MV3 with keyboard shortcuts, alarms, notifications
│   ├── popup.html              — 4-tab UI (Search, Bookmark, Notes, History)
│   ├── popup.js                — All extension logic
│   ├── background.js           — Tab-close detection, alarms, notifications
│   └── content.js              — Page info reader
│
├── desktop/
│   ├── main.js                 — Electron tray + global shortcut
│   ├── preload.js              — Safe API bridge
│   ├── overlay.html            — Global overlay UI
│   ├── overlay.js              — Overlay logic
│   └── package.json            — Electron + electron-builder
│
├── frontend/
│   └── dashboard.html          — Analytics dashboard
│
├── database/
│   └── setup.sql               — Reference schema (Neo4j Cypher/Legacy)
```

---

## API Endpoints

All at `http://localhost:5000/api` with `x-user-id` header.

### Core
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |
| `POST` | `/api/quick-lookup` | AI term definition (cached) |

### Bookmarks
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/bookmark` | Save bookmark (with optional reminder) |
| `GET` | `/api/bookmarks` | List with pagination, sorting, topic filter |
| `GET` | `/api/search?q=` | Search bookmarks |
| `DELETE` | `/api/bookmark/:id` | Delete |

### Notes (Problem #4)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/notes` | Create note with optional reminder |
| `GET` | `/api/notes` | List notes |
| `PATCH` | `/api/notes/:id/toggle` | Toggle completed |
| `DELETE` | `/api/notes/:id` | Delete |

### Reminders
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/reminders` | Schedule a reminder |
| `GET` | `/api/reminders?due=true` | Get due reminders |
| `PATCH` | `/api/reminders/:id` | Acknowledge/dismiss |
| `DELETE` | `/api/reminders/:id` | Delete |

### Research (Problem #2)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/research` | Queue AI deep-research on a URL |
| `GET` | `/api/research` | Get results |

### Push Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/push-subscribe` | Register device for push |
| `DELETE` | `/api/push-subscribe/:id` | Unsubscribe |
| `POST` | `/api/check-reminders` | Process due reminders |

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Chrome Extension** | Manifest V3, Vanilla JS |
| **Backend** | Node.js, Express.js |
| **Database** | Neo4j Aura (Graph Database) |
| **AI** | Google Gemini (`gemini-2.5-flash`) |
| **Windows App** | Electron, system tray, global shortcut |
| **Dashboard** | Pure HTML/CSS/JS |
| **Styling** | Dark purple theme, Inter font |

---

## Keyboard Shortcuts

| Shortcut | Where | Action |
|----------|-------|--------|
| `Ctrl+Shift+E` | Browser (Chrome) | Open easy-rewind popup |
| `Ctrl+Shift+N` | Browser (Chrome) | Quick capture note |
| `Ctrl+Shift+Space` | Windows (anywhere) | Open global search overlay |
| Right-click → "Look up" | Browser | Quick lookup selected text |
| Right-click → "Save selection" | Browser | Save text as note |
| Right-click → "Bookmark page" | Browser | Quick bookmark |
