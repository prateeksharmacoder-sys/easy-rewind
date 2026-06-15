/**
 * easy-rewind Desktop Overlay — Renderer Script
 *
 * Provides: quick lookup, quick notes, recent bookmarks/notes
 * All API calls go through the preload bridge.
 */

const API = window.easyRewind;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let desktopSettings = { apiBase: 'http://localhost:5000', apiKey: '', aiModel: 'gemini-2.5-flash', reminderMinutes: 60 };

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const els = {
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  resultBox: document.getElementById('result-box'),
  resultTerm: document.getElementById('result-term'),
  resultDef: document.getElementById('result-def'),

  modeTabs: document.querySelectorAll('.mode-tab'),
  panels: {
    note: document.getElementById('panel-note'),
    recent: document.getElementById('panel-recent'),
  },

  noteInput: document.getElementById('note-input'),
  saveNoteBtn: document.getElementById('save-note-btn'),
  noteStatus: document.getElementById('note-status'),

  recentList: document.getElementById('recent-list'),
  globalStatus: document.getElementById('global-status'),

  closeBtn: document.getElementById('close-btn'),

  // Settings
  settingsBtn: document.getElementById('settings-btn'),
  settingsOverlay: document.getElementById('settings-overlay'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsSave: document.getElementById('settings-save'),
  settingsApiUrl: document.getElementById('settings-api-url'),
  settingsApiKey: document.getElementById('settings-api-key'),
  settingsReminderMin: document.getElementById('settings-reminder-min'),
};

// ─────────────────────────────────────────────
// MODE SWITCHING
// ─────────────────────────────────────────────
let currentMode = 'search';

els.modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.modeTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;

    // Hide all panels
    Object.values(els.panels).forEach((p) => p?.classList.remove('active'));

    if (currentMode === 'note') {
      els.panels.note?.classList.add('active');
      els.noteInput?.focus();
    } else if (currentMode === 'recent') {
      els.panels.recent?.classList.add('active');
      loadRecent();
    } else {
      els.searchInput?.focus();
    }
  });
});

// ─────────────────────────────────────────────
// SHOW STATUS
// ─────────────────────────────────────────────
function showStatus(el, msg, type = '', duration = 0) {
  el.textContent = msg;
  el.className = 'status visible ' + type;
  if (duration > 0) setTimeout(() => { el.classList.remove('visible'); }, duration);
}

// ─────────────────────────────────────────────
// QUICK LOOKUP
// ─────────────────────────────────────────────
async function handleSearch() {
  const term = els.searchInput.value.trim();
  if (!term) return;

  els.resultBox.classList.remove('visible');
  els.searchBtn.disabled = true;
  els.searchBtn.innerHTML = '<span class="spinner"></span>';

  try {
    const data = await API.apiCall('/quick-lookup', {
      method: 'POST',
      body: { term },
    });

    if (data.error) {
      throw new Error(data.error);
    }

    els.resultTerm.textContent = data.term;
    els.resultDef.textContent = data.definition;
    els.resultBox.classList.add('visible');
  } catch (err) {
    showStatus(els.globalStatus, err.message || 'Server offline', 'error', 3000);
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.innerHTML = '🔍';
  }
}

els.searchBtn.addEventListener('click', handleSearch);
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSearch();
  if (e.key === 'Escape') API.hideOverlay();
});

// ─────────────────────────────────────────────
// QUICK NOTE
// ─────────────────────────────────────────────
async function handleSaveNote() {
  const content = els.noteInput.value.trim();
  if (!content) return;

  els.saveNoteBtn.disabled = true;
  els.saveNoteBtn.innerHTML = '<span class="spinner"></span> Saving...';

  try {
    const remindMins = desktopSettings.reminderMinutes || 60;
    await API.apiCall('/notes', {
      method: 'POST',
      body: { content, remind_in_minutes: remindMins },
    });

    showStatus(els.noteStatus, `✅ Thought saved! (reminder in ${remindMins >= 1440 ? Math.floor(remindMins/1440)+'d' : remindMins >= 60 ? Math.floor(remindMins/60)+'h' : remindMins+'min'})`, 'success', 3000);
    els.noteInput.value = '';
  } catch (err) {
    showStatus(els.noteStatus, err.message || 'Failed to save', 'error', 3000);
  } finally {
    els.saveNoteBtn.disabled = false;
    els.saveNoteBtn.innerHTML = '💾 Save Thought';
  }
}

els.saveNoteBtn.addEventListener('click', handleSaveNote);
els.noteInput.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') handleSaveNote();
  if (e.key === 'Escape') API.hideOverlay();
});

// ─────────────────────────────────────────────
// LOAD RECENT BOOKMARKS & NOTES
// ─────────────────────────────────────────────
async function loadRecent() {
  els.recentList.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:11px;">Loading...</div>';

  try {
    const [bookmarksData, notesData] = await Promise.all([
      API.apiCall('/bookmarks?limit=10'),
      API.apiCall('/notes?limit=5'),
    ]);

    const bookmarks = bookmarksData.bookmarks || [];
    const notes = notesData.notes || [];

    if (bookmarks.length === 0 && notes.length === 0) {
      els.recentList.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:11px;">No bookmarks or notes yet. Start exploring!</div>';
      return;
    }

    let html = '';

    if (notes.length > 0) {
      html += '<div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">📝 Recent Thoughts</div>';
      notes.forEach((note) => {
        html += `<div class="recent-item" data-action="hide">
          <div class="recent-item-content">${escapeHtml(String(note.content).slice(0, 100))}</div>
          <div class="recent-item-meta">${formatTime(note.created_at)}${note.remind_at ? ' · ⏰' : ''}</div>
        </div>`;
      });
    }

    if (bookmarks.length > 0) {
      html += '<div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 4px;">🔖 Recent Bookmarks</div>';
      bookmarks.forEach((bm) => {
        html += `<div class="recent-item" data-action="open" data-url="${escapeHtml(String(bm.url))}">
          <div class="recent-item-content">${escapeHtml(String(bm.topic))} — ${escapeHtml(String(bm.title || bm.url).slice(0, 60))}</div>
          <div class="recent-item-meta">${formatTime(bm.created_at)}</div>
        </div>`;
      });
    }

    els.recentList.innerHTML = html;

    // Attach event handlers (no inline onclick)
    els.recentList.querySelectorAll('.recent-item[data-action="hide"]').forEach(el => {
      el.addEventListener('click', () => API.hideOverlay());
    });
    els.recentList.querySelectorAll('.recent-item[data-action="open"]').forEach(el => {
      el.addEventListener('click', () => API.openInBrowser(el.dataset.url));
    });
  } catch (err) {
    els.recentList.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:11px;">Could not load — is the server running?</div>';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

function parseDbDate(dateStr) {
  if (!dateStr) return new Date();
  const normalized = dateStr.replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = parseDbDate(dateStr);
  const now = new Date();
  const diffMs = now - date;
  if (isNaN(diffMs)) return 'Just now';
  if (diffMs < 0) return 'Just now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ─────────────────────────────────────────────
// SETTINGS MODAL
// ─────────────────────────────────────────────
async function openSettings() {
  try {
    const settings = await API.getSettings();
    if (settings) desktopSettings = settings;
  } catch (_) {}
  els.settingsApiUrl.value = desktopSettings.apiBase || 'http://localhost:5000';
  els.settingsApiKey.value = desktopSettings.apiKey || '';
  els.settingsReminderMin.value = desktopSettings.reminderMinutes || 60;
  els.settingsOverlay.classList.add('open');
}

function closeSettings() {
  els.settingsOverlay.classList.remove('open');
}

async function saveSettings() {
  desktopSettings.apiBase = els.settingsApiUrl.value.trim() || 'http://localhost:5000';
  desktopSettings.apiKey = els.settingsApiKey.value.trim();
  desktopSettings.reminderMinutes = parseInt(els.settingsReminderMin.value) || 60;
  try {
    await API.setSettings(desktopSettings);
    showStatus(els.globalStatus, '✅ Settings saved!', 'success', 2000);
  } catch (_) {}
  closeSettings();
}

els.settingsBtn.addEventListener('click', openSettings);
els.settingsCancel.addEventListener('click', closeSettings);
els.settingsSave.addEventListener('click', saveSettings);
els.settingsOverlay.addEventListener('click', (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});

// ─────────────────────────────────────────────
// CLOSE BUTTON
// ─────────────────────────────────────────────
els.closeBtn.addEventListener('click', () => API.hideOverlay());

// ─────────────────────────────────────────────
// GLOBAL KEYBOARD
// ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.settingsOverlay.classList.contains('open')) {
    API.hideOverlay();
  } else if (e.key === 'Escape') {
    closeSettings();
  }
});

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
// Load saved settings, then focus search
(async () => {
  try {
    const settings = await API.getSettings();
    if (settings) desktopSettings = settings;
  } catch (_) {}
  els.searchInput.focus();
})();
