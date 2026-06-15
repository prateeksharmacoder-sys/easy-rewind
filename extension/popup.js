/**
 * easy-rewind Knowledge Assistant — popup.js
 *
 * Solves all 4 problems:
 * 1. 🔍 Quick AI lookup (no tab switch)
 * 2. 🧠 Research Later — AI analyzes pages, reminds you
 * 3. 📚 Searchable bookmark history with topic organization
 * 4. 📝 Quick notes with tab-close reminders
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const DEFAULT_API_BASE = 'http://localhost:5000';
const DASHBOARD_URL = 'http://localhost:5000/dashboard';

function getApiUrl(path) {
  // Read from sync storage with default fallback
  return new Promise((resolve) => {
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, (result) => {
      const base = result.easy_rewind_api_base || DEFAULT_API_BASE;
      resolve(base.replace(/\/+$/, '') + '/api' + path);
    });
  });
}

function getFullApiUrl(path) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, (result) => {
      const base = result.easy_rewind_api_base || DEFAULT_API_BASE;
      resolve(base.replace(/\/+$/, '') + path);
    });
  });
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let currentPageUrl = '';
let currentPageTitle = '';
let userId = '';
let currentTabId = null;
let selectedReminderMinutes = 0; // 0 = tab close
let selectedBookmarkReminderMinutes = null;

// AI conversation tracking for follow-up questions
let conversationHistory = [];
let currentLookupTerm = '';

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  // Tabs
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tab-content'),

  // Search tab
  searchInput: $('search-term-input'),
  lookupBtn: $('lookup-btn'),
  summarizeBtn: $('summarize-page-btn'),
  definitionCard: $('definition-card'),
  summaryCard: $('summary-card'),
  resultTerm: $('result-term-label'),
  resultDef: $('result-definition-text'),
  resultBadge: $('result-source-badge'),
  resultMeta: $('result-meta-text'),
  summaryDef: $('summary-definition-text'),
  summaryMeta: $('summary-meta'),
  searchStatus: $('search-status'),
  searchSavedResults: $('search-saved-results'),
  searchSavedList: $('search-saved-list'),

  // AI follow-up + suggestions
  suggestionsRow: $('suggestions-row'),
  suggestionsList: $('suggestions-list'),
  followupRow: $('followup-row'),
  followupInput: $('followup-input'),
  followupBtn: $('followup-btn'),

  // Bookmark tab
  pageTitleDisplay: $('page-title-display'),
  pageUrlDisplay: $('page-url-display'),
  topicInput: $('topic-input'),
  notesInput: $('notes-input'),
  saveBookmarkBtn: $('save-bookmark-btn'),
  bookmarkStatus: $('bookmark-status'),
  bookmarkReminderToggle: $('bookmark-reminder-toggle'),
  bookmarkReminderBody: $('bookmark-reminder-body'),
  bookmarkReminderCustom: $('bookmark-reminder-custom'),
  bookmarkReminderPresets: document.querySelectorAll('#bookmark-reminder-body .preset-btn'),
  researchToggle: $('research-toggle'),

  // Notes tab
  noteContentInput: $('note-content-input'),
  notePageInfo: $('note-page-info'),
  noteSourceTitle: $('note-source-title'),
  noteSourceUrl: $('note-source-url'),
  noteReminderToggle: $('note-reminder-toggle'),
  noteReminderBody: $('note-reminder-body'),
  noteReminderCustom: $('note-reminder-custom'),
  noteReminderPresets: document.querySelectorAll('#note-reminder-body .preset-btn'),
  noteReminderTabClose: $('note-reminder-tab-close'),
  saveNoteBtn: $('save-note-btn'),
  noteStatus: $('note-status'),
  recentNotesList: $('recent-notes-list'),
  notesBadge: $('notes-badge'),

  // History tab
  historySearchInput: $('history-search-input'),
  historySearchBtn: $('history-search-btn'),
  bookmarksList: $('bookmarks-list'),
  researchList: $('research-list'),
  historyStatus: $('history-status'),
  totalBookmarksStat: $('total-bookmarks-stat'),
  uniqueTopicsStat: $('unique-topics-stat'),
  totalResearchStat: $('total-research-stat'),
  totalHighlightsStat: $('total-highlights-stat'),
  historySubBm: $('history-sub-bm'),
  historySubResearch: $('history-sub-research'),
  historySubHighlights: $('history-sub-highlights'),
  historyBookmarks: $('history-bookmarks'),
  historyResearch: $('history-research'),
  historyHighlights: $('history-highlights'),
  highlightsList: $('highlights-list'),

  // Footer
  serverStatusDot: $('server-status-dot'),
  serverStatusText: $('server-status-text'),

  // Header
  openDashboardBtn: $('open-dashboard-btn'),
  footerDashboardLink: $('footer-dashboard-link'),
};

// ─────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────

function showStatus(el, message, type = 'loading', duration = 0) {
  el.textContent = message;
  el.className = `status-message visible ${type}`;
  if (duration > 0) setTimeout(() => hideStatus(el), duration);
}

function hideStatus(el) { el.classList.remove('visible'); }

function setButtonLoading(btn, loading, originalText = '') {
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working...';
  } else {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

function parseDbDate(dateStr) {
  // SQLite returns "YYYY-MM-DDTHH:MM:SSZ" (our defaults) or "YYYY-MM-DD HH:MM:SS" (raw datetime)
  // Normalize both so JS Date parses correctly as UTC.
  if (!dateStr) return new Date();
  const normalized = dateStr.replace(' ', 'T');
  // Only append Z if not already present (avoids "2024-01-01T00:00:00ZZ")
  return new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
}

function formatRelativeTime(dateStr) {
  const date = parseDbDate(dateStr);
  const now = new Date();
  const diffMs = now - date;
  // Handle Invalid Date and future dates gracefully
  if (isNaN(diffMs)) return 'Just now';
  if (diffMs < 0) return 'Just now';
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function truncate(str, max = 80) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function apiCall(path, options = {}) {
  const url = await getApiUrl(path);
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────

async function initUserId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['easy_rewind_user_id'], (result) => {
      if (result.easy_rewind_user_id) {
        userId = result.easy_rewind_user_id;
      } else {
        userId = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        chrome.storage.local.set({ easy_rewind_user_id: userId });
      }
      resolve(userId);
    });
  });
}

async function getCurrentPageInfo() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        currentTabId = tabs[0].id;
        resolve({ url: tabs[0].url || '', title: tabs[0].title || 'Untitled Page' });
      } else {
        resolve({ url: '', title: 'Unknown Page' });
      }
    });
  });
}

async function checkServerHealth() {
  try {
    const data = await apiCall('/health');
    els.serverStatusDot.classList.add('online');
    els.serverStatusText.textContent = 'Server online';
  } catch {
    els.serverStatusDot.classList.remove('online');
    els.serverStatusText.textContent = 'Server offline';
  }
}

// ─────────────────────────────────────────────
// MAIN INIT
// ─────────────────────────────────────────────
async function init() {
  await initUserId();

  const pageInfo = await getCurrentPageInfo();
  currentPageUrl = pageInfo.url;
  currentPageTitle = pageInfo.title;

  els.pageTitleDisplay.textContent = truncate(currentPageTitle, 60) || 'No title';
  els.pageUrlDisplay.textContent = truncate(currentPageUrl, 70) || 'No URL';
  els.noteSourceTitle.textContent = truncate(currentPageTitle, 50) || 'Current page';
  els.noteSourceUrl.textContent = truncate(currentPageUrl, 60) || '';

  // Show page info in notes tab if there's a URL
  if (currentPageUrl) {
    els.notePageInfo.style.display = 'block';
  }

  checkServerHealth();

  // Check if we were asked to open a specific tab
  chrome.storage.local.get(['easy_rewind_open_tab'], (result) => {
    if (result.easy_rewind_open_tab) {
      switchTab(result.easy_rewind_open_tab);
      chrome.storage.local.remove('easy_rewind_open_tab');
    }
  });

  // Sync saved API key & model to backend (in case server restarted)
  chrome.storage.local.get({
    easy_rewind_api_key: '',
    easy_rewind_ai_model: 'gemini-2.5-flash',
    easy_rewind_api_base: DEFAULT_API_BASE,
  }, (result) => {
    if (result.easy_rewind_api_key || result.easy_rewind_ai_model !== 'gemini-2.5-flash') {
      const base = (result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
      fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          gemini_api_key: result.easy_rewind_api_key || null,
          ai_model: result.easy_rewind_ai_model,
        }),
      }).catch(() => {});
    }
  });

  // Load pending note from context menu / keyboard shortcut
  chrome.storage.local.get(['easy_rewind_pending_note'], (result) => {
    const pending = result.easy_rewind_pending_note;
    if (pending) {
      els.noteContentInput.value = pending.content || '';
      if (pending.source_url) {
        els.noteSourceTitle.textContent = truncate(pending.source_title || 'Linked page', 50);
        els.noteSourceUrl.textContent = truncate(pending.source_url, 60);
        els.notePageInfo.style.display = 'block';
      }
      chrome.storage.local.remove('easy_rewind_pending_note');
      switchTab('notes');
      els.noteContentInput.focus();
    }
  });

  // Load pending bookmark from context menu
  chrome.storage.local.get(['easy_rewind_pending_bookmark'], (result) => {
    const pending = result.easy_rewind_pending_bookmark;
    if (pending) {
      currentPageUrl = pending.url || currentPageUrl;
      currentPageTitle = pending.title || currentPageTitle;
      els.pageTitleDisplay.textContent = truncate(currentPageTitle, 60);
      els.pageUrlDisplay.textContent = truncate(currentPageUrl, 70);
      chrome.storage.local.remove('easy_rewind_pending_bookmark');
      switchTab('bookmark');
      els.topicInput.focus();
    }
  });

  // Load pending lookup from context menu
  chrome.storage.local.get(['easy_rewind_pending_lookup'], (result) => {
    if (result.easy_rewind_pending_lookup) {
      els.searchInput.value = result.easy_rewind_pending_lookup;
      chrome.storage.local.remove('easy_rewind_pending_lookup');
      switchTab('search');
      setTimeout(handleLookup, 200);
    }
  });

  // Load recent notes
  loadRecentNotes();
}

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────
let historyLoaded = false;
let researchLoaded = false;
let highlightsLoaded = false;

function switchTab(tabName) {
  els.tabBtns.forEach((b) => b.classList.remove('active'));
  els.tabContents.forEach((c) => c.classList.remove('active'));

  const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const targetContent = $(`tab-${tabName}`);
  if (targetBtn) targetBtn.classList.add('active');
  if (targetContent) targetContent.classList.add('active');

  if (tabName === 'history' && !historyLoaded) {
    loadAllBookmarks();
    historyLoaded = true;
  }
  if (tabName === 'history' && !researchLoaded) {
    loadResearchResults();
    researchLoaded = true;
  }
  if (tabName === 'notes') {
    loadRecentNotes();
  }
}

els.tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});

// ═════════════════════════════════════════════
// TAB 1: SEARCH — AI Quick Lookup (Problem #1)
// ═════════════════════════════════════════════

async function handleLookup() {
  const term = els.searchInput.value.trim();
  if (!term) {
    showStatus(els.searchStatus, 'Enter a tech term to look up.', 'error', 3000);
    els.searchInput.focus();
    return;
  }

  setButtonLoading(els.lookupBtn, true);
  hideStatus(els.searchStatus);
  els.definitionCard.classList.remove('visible');
  els.suggestionsRow.style.display = 'none';
  els.followupRow.style.display = 'none';

  // Reset conversation for a brand-new lookup (not a follow-up via chip click)
  if (!arguments[0]?.isFollowUp) {
    conversationHistory = [];
  }

  try {
    // Grab page context for a richer, context-aware definition
    let page_context = '';
    let page_title = currentPageTitle;
    if (currentTabId && !arguments[0]?.isFollowUp) {
      try {
        const resp = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_PAGE_INFO' });
        if (resp && resp.textContent) {
          const idx = resp.textContent.toLowerCase().indexOf(term.toLowerCase());
          if (idx !== -1) {
            const start = Math.max(0, idx - 400);
            const end = Math.min(resp.textContent.length, idx + term.length + 600);
            page_context = (start > 0 ? '...' : '') + resp.textContent.slice(start, end) + (end < resp.textContent.length ? '...' : '');
          } else {
            page_context = resp.textContent.slice(0, 1500);
          }
        }
      } catch { /* content script not available */ }
    }

    const body = { term, page_context, page_title };
    if (conversationHistory.length > 0) {
      body.conversation = conversationHistory;
    }

    const data = await apiCall('/quick-lookup', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    currentLookupTerm = data.term;
    els.resultTerm.textContent = data.term;
    els.resultDef.textContent = data.definition;
    els.resultBadge.textContent = data.source === 'cache' ? '⚡ Cached' : '🤖 AI';
    els.resultBadge.className = `source-badge ${data.source === 'cache' ? 'cache' : 'ai'}`;
    els.resultMeta.textContent = data.source === 'cache' ? 'Retrieved from cache'
      : data.source === 'mock' ? 'Mock response — configure AI key'
      : 'Generated by AI';

    els.definitionCard.classList.add('visible');

    // Show suggestions if available
    if (data.suggestions && data.suggestions.length > 0) {
      els.suggestionsList.innerHTML = data.suggestions.map(s =>
        `<span class="suggestion-chip" data-term="${escapeHtml(s)}">${escapeHtml(s)}</span>`
      ).join('');
      els.suggestionsRow.style.display = 'flex';

      // Clicking a suggestion triggers a new lookup for that term
      els.suggestionsList.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          els.searchInput.value = chip.dataset.term;
          els.followupRow.style.display = 'none';
          els.suggestionsRow.style.display = 'none';
          conversationHistory = [];
          handleLookup();
        });
      });
    }

    // Also search saved bookmarks + notes for this term (combined search)
    searchSavedContent(term);

    // Show follow-up input
    els.followupRow.style.display = 'flex';

    // Save to conversation history
    const lastQuestion = conversationHistory.length > 0
      ? conversationHistory[conversationHistory.length - 1]?.term
      : term;
    conversationHistory.push({ term: lastQuestion, definition: data.definition });

    // Clear the search input so user can type a follow-up
    if (arguments[0]?.isFollowUp) {
      els.searchInput.value = '';
    }
  } catch (err) {
    showStatus(els.searchStatus, err.message || 'Could not get definition. Is the server running?', 'error', 5000);
  } finally {
    setButtonLoading(els.lookupBtn, false, '✨ Get AI Definition');
  }
}

// Follow-up handler: type a question and press Enter or click Ask
async function handleFollowUp() {
  const question = els.followupInput.value.trim();
  if (!question) return;
  els.searchInput.value = question;
  els.followupInput.value = '';
  conversationHistory.push({ term: question });
  await handleLookup({ isFollowUp: true });
}

els.lookupBtn.addEventListener('click', () => handleLookup());
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLookup();
});
els.followupBtn?.addEventListener('click', handleFollowUp);
els.followupInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleFollowUp();
});

// ═════════════════════════════════════════════
// SUMMARIZE PAGE
// ═════════════════════════════════════════════

/**
 * Lightweight markdown-like formatting for summary text:
 * - **bold** → <strong>
 * - *italic* → <em>
 * - ### headers → bold+larger
 * - bullet lines → styled list
 * - double newlines → paragraph break
 */
function formatSummary(text) {
  if (!text) return '';
  const paragraphs = text.split(/\n\n+/);
  return paragraphs.map(p => {
    const lines = p.split('\n');
    const formatted = lines.map(line => {
      // Headers
      if (/^#{1,3}\s/.test(line)) {
        const content = line.replace(/^#{1,3}\s+/, '');
        return `<strong style="font-size:14px;display:block;margin:8px 0 4px;">${escapeHtml(content)}</strong>`;
      }
      // Bullet points
      if (/^[\-\*]\s/.test(line)) {
        const content = line.replace(/^[\-\*]\s+/, '');
        return `• ${formatInline(content)}`;
      }
      return formatInline(line);
    });
    return `<p style="margin-bottom:6px;">${formatted.join('<br>')}</p>`;
  }).join('');
}

function formatInline(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  // **bold**
  const withBold = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // *italic*
  return withBold.replace(/\*(.*?)\*/g, '<em>$1</em>');
}

async function handleSummarizePage() {
  showStatus(els.searchStatus, 'Reading page content...', 'loading');
  els.summaryCard.classList.remove('visible');

  try {
    // Request page content from content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    // Try SUMMARY_PAGE first, fall back to GET_PAGE_INFO
    let pageData = { url: tab.url, title: tab.title, description: '', textContent: '' };

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'SUMMARY_PAGE' });
      if (response) {
        pageData = {
          url: response.url || tab.url,
          title: response.title || tab.title,
          description: response.description || '',
          textContent: response.textContent || '',
        };
      }
    } catch {
      // Content script may not respond — try GET_PAGE_INFO as fallback
      showStatus(els.searchStatus, 'Scanning page metadata...', 'loading');
      try {
        const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
        if (info) {
          pageData = {
            url: info.url || tab.url,
            title: info.title || tab.title,
            description: info.description || '',
            textContent: info.textContent || '',
          };
        }
      } catch {
        throw new Error('Could not reach the page. Try reloading the page first.');
      }
    }

    // If we got text from the content script but it's short, use metadata
    if (!pageData.textContent || pageData.textContent.length < 20) {
      if (pageData.description) {
        showStatus(els.searchStatus, 'Page has limited extractable content. Using description...', 'loading');
        pageData.textContent = pageData.description;
      } else {
        throw new Error('This page does not have enough content to summarize. Try a different page.');
      }
    }

    showStatus(els.searchStatus, 'Generating AI summary...', 'loading');

    const data = await apiCall('/page-summary', {
      method: 'POST',
      body: JSON.stringify(pageData),
    });

    if (data.summary) {
      els.summaryDef.innerHTML = formatSummary(data.summary);
      els.summaryMeta.textContent = data.source === 'ai' ? 'Generated by AI' : 'Summary';
      els.summaryCard.classList.add('visible');
      els.definitionCard?.classList.remove('visible');
      hideStatus(els.searchStatus);
    } else {
      throw new Error(data.error || 'No summary returned');
    }
  } catch (err) {
    showStatus(els.searchStatus, err.message || 'Failed to generate summary.', 'error', 5000);
  }
}

els.summarizeBtn?.addEventListener('click', handleSummarizePage);

// ═════════════════════════════════════════════
// TAB 2: BOOKMARK — Save + Research Later (Problem #2)
// ═════════════════════════════════════════════

// Bookmark Reminder Toggle
els.bookmarkReminderToggle.addEventListener('click', () => {
  els.bookmarkReminderBody.classList.toggle('open');
  const arrow = els.bookmarkReminderToggle.querySelector('span:last-child');
  if (arrow) arrow.textContent = els.bookmarkReminderBody.classList.contains('open') ? '▾' : '▸';
});

els.bookmarkReminderPresets.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.bookmarkReminderPresets.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedBookmarkReminderMinutes = parseInt(btn.dataset.minutes);
    els.bookmarkReminderCustom.value = '';
  });
});

// Custom reminder override
els.bookmarkReminderCustom.addEventListener('input', () => {
  const val = parseInt(els.bookmarkReminderCustom.value);
  if (val > 0) {
    selectedBookmarkReminderMinutes = val;
    els.bookmarkReminderPresets.forEach((b) => b.classList.remove('active'));
  }
});

async function handleSaveBookmark() {
  const topic = els.topicInput.value.trim();
  const notes = els.notesInput.value.trim();

  if (!topic) {
    showStatus(els.bookmarkStatus, 'Please enter a topic label.', 'error', 3000);
    els.topicInput.focus();
    return;
  }
  if (!currentPageUrl) {
    showStatus(els.bookmarkStatus, 'Could not detect current page URL.', 'error', 3000);
    return;
  }

  setButtonLoading(els.saveBookmarkBtn, true);
  showStatus(els.bookmarkStatus, 'Saving bookmark...', 'loading');

  try {
    const body = {
      url: currentPageUrl,
      title: currentPageTitle || currentPageUrl,
      topic,
      notes,
    };

    // Add reminder if set
    if (selectedBookmarkReminderMinutes) {
      body.remind_in_minutes = selectedBookmarkReminderMinutes;
    }

    const data = await apiCall('/bookmark', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    // If research later is toggled, queue research
    if (els.researchToggle.checked && data.bookmark) {
      showStatus(els.bookmarkStatus, 'Saving + queuing AI research...', 'loading');
      await apiCall('/research', {
        method: 'POST',
        body: JSON.stringify({
          url: currentPageUrl,
          title: currentPageTitle || currentPageUrl,
          user_notes: notes || topic,
          auto_process: true,
        }),
      });
    }

    const msgParts = ['✅ Bookmarked!'];
    if (selectedBookmarkReminderMinutes) {
      const mins = selectedBookmarkReminderMinutes;
      msgParts.push(`Reminder in ${mins >= 1440 ? `${Math.floor(mins/1440)}d` : mins >= 60 ? `${Math.floor(mins/60)}h` : `${mins}min`}`);
    }
    if (els.researchToggle.checked) msgParts.push('Research queued!');

    showStatus(els.bookmarkStatus, msgParts.join(' '), 'success', 4000);
    els.topicInput.value = '';
    els.notesInput.value = '';
    els.researchToggle.checked = false;
    selectedBookmarkReminderMinutes = null;
    els.bookmarkReminderPresets.forEach((b) => b.classList.remove('active'));
    historyLoaded = false;
  } catch (err) {
    showStatus(els.bookmarkStatus, err.message || 'Failed to save.', 'error', 5000);
  } finally {
    setButtonLoading(els.saveBookmarkBtn, false, '🔖 Save Bookmark');
  }
}

els.saveBookmarkBtn.addEventListener('click', handleSaveBookmark);

// ═════════════════════════════════════════════
// TAB 3: QUICK NOTES (Problem #4 — Ephemeral Thoughts)
// ═════════════════════════════════════════════

// Note Reminder Toggle
els.noteReminderToggle.addEventListener('click', () => {
  els.noteReminderBody.classList.toggle('open');
  const arrow = els.noteReminderToggle.querySelector('span:last-child');
  if (arrow) arrow.textContent = els.noteReminderBody.classList.contains('open') ? '▾' : '▸';
});

// Note reminder presets
els.noteReminderPresets.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.noteReminderPresets.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedReminderMinutes = parseInt(btn.dataset.minutes);
    els.noteReminderCustom.value = '';

    // Toggle tab-close checkbox visibility
    els.noteReminderTabClose.closest('.toggle-row').style.display =
      selectedReminderMinutes === 0 ? 'flex' : 'none';
  });
});

els.noteReminderCustom.addEventListener('input', () => {
  const val = parseInt(els.noteReminderCustom.value);
  if (val > 0) {
    selectedReminderMinutes = val;
    els.noteReminderPresets.forEach((b) => b.classList.remove('active'));
    els.noteReminderTabClose.closest('.toggle-row').style.display = 'none';
  }
});

async function handleSaveNote() {
  const content = els.noteContentInput.value.trim();
  if (!content) {
    showStatus(els.noteStatus, 'Write your thought first.', 'error', 3000);
    els.noteContentInput.focus();
    return;
  }

  setButtonLoading(els.saveNoteBtn, true);
  showStatus(els.noteStatus, 'Saving thought...', 'loading');

  try {
    const body = {
      content,
      source_url: currentPageUrl || undefined,
      source_title: currentPageTitle || undefined,
    };

    // Set reminder
    let shouldTrackTabClose = false;
    if (selectedReminderMinutes > 0) {
      // User set a specific timer
      body.remind_in_minutes = selectedReminderMinutes;
    } else if (selectedReminderMinutes === 0 && els.noteReminderTabClose.checked) {
      // Tab-close reminder: rely ENTIRELY on tab-close event, no DB fallback
      // (prevents double-notification: tab-close fires + timed reminder also fires)
      shouldTrackTabClose = true;
    }

    const data = await apiCall('/notes', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    // Track tab for close reminder
    if (shouldTrackTabClose && currentTabId && data.note) {
      chrome.runtime.sendMessage({
        type: 'TRACK_TAB_REMINDER',
        noteData: {
          id: data.note.id,
          content: content,
          source_title: currentPageTitle,
        },
      });
    }

    showStatus(els.noteStatus, shouldTrackTabClose
      ? '✅ Saved! I\'ll remind you when you leave this tab.'
      : '✅ Thought saved!', 'success', 3000);

    els.noteContentInput.value = '';
    els.noteReminderPresets.forEach((b) => b.classList.remove('active'));
    document.querySelector('#note-reminder-body .preset-btn[data-minutes="0"]')?.classList.add('active');
    selectedReminderMinutes = 0;

    loadRecentNotes();
  } catch (err) {
    showStatus(els.noteStatus, err.message || 'Failed to save.', 'error', 5000);
  } finally {
    setButtonLoading(els.saveNoteBtn, false, '💾 Save Thought');
  }
}

els.saveNoteBtn.addEventListener('click', handleSaveNote);
els.noteContentInput.addEventListener('keydown', (e) => {
  // Ctrl+Enter to save
  if (e.ctrlKey && e.key === 'Enter') handleSaveNote();
});

// Load recent notes
async function loadRecentNotes() {
  try {
    const data = await apiCall('/notes?limit=10');
    const notes = data.notes || [];
    const pendingCount = notes.filter(n => !n.completed).length;

    // Update badge
    if (pendingCount > 0) {
      els.notesBadge.style.display = 'inline';
      els.notesBadge.textContent = pendingCount;
    } else {
      els.notesBadge.style.display = 'none';
    }

    if (notes.length === 0) {
      els.recentNotesList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💭</div>
          <div class="empty-title">No thoughts captured yet</div>
          <div class="empty-subtitle">Ideas vanish fast — write them down here</div>
        </div>`;
      return;
    }

    els.recentNotesList.innerHTML = notes.map((note) => `
      <div class="list-item" data-id="${note.id}">
        <div class="list-item-content" style="${note.completed ? 'text-decoration:line-through;opacity:0.5;' : ''}">
          ${escapeHtml(truncate(note.content, 150))}
        </div>
        ${note.source_title ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">📍 ${escapeHtml(truncate(note.source_title, 60))}</div>` : ''}
        <div class="list-item-meta">
          <span class="list-item-date">
            ${formatRelativeTime(note.created_at)}
            ${note.remind_at ? ' ⏰' : ''}
            ${note.completed ? ' ✓ Done' : ''}
          </span>
          <div class="list-item-actions">
            <button class="complete-btn ${note.completed ? 'done' : ''}" data-id="${note.id}" data-completed="${note.completed}" title="Toggle done">✓</button>
            <button class="delete-btn" data-id="${note.id}" title="Delete">✕</button>
          </div>
        </div>
      </div>
    `).join('');

    // Wire up note actions
    els.recentNotesList.querySelectorAll('.complete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await apiCall(`/notes/${id}/toggle`, { method: 'PATCH' });
          loadRecentNotes();
        } catch (err) {
          showStatus(els.noteStatus, 'Failed to toggle.', 'error', 3000);
        }
      });
    });

    els.recentNotesList.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = btn.closest('.list-item');
        item.style.opacity = '0.3';
        try {
          await apiCall(`/notes/${id}`, { method: 'DELETE' });
          item.remove();
          loadRecentNotes();
        } catch (err) {
          item.style.opacity = '1';
          showStatus(els.noteStatus, 'Failed to delete.', 'error', 3000);
        }
      });
    });
  } catch (err) {
    console.warn('[Load Notes Error]', err.message);
  }
}

// ═════════════════════════════════════════════
// TAB 4: HISTORY — Bookmarks + Research
// ═════════════════════════════════════════════

// Sub-tab switching (Bookmarks / Research / Highlights)
els.historySubBm.addEventListener('click', () => {
  els.historySubBm.classList.add('active');
  els.historySubResearch.classList.remove('active');
  els.historySubHighlights.classList.remove('active');
  els.historyBookmarks.style.display = 'block';
  els.historyResearch.style.display = 'none';
  els.historyHighlights.style.display = 'none';
});

els.historySubResearch.addEventListener('click', () => {
  els.historySubResearch.classList.add('active');
  els.historySubBm.classList.remove('active');
  els.historySubHighlights.classList.remove('active');
  els.historyResearch.style.display = 'block';
  els.historyBookmarks.style.display = 'none';
  els.historyHighlights.style.display = 'none';
  if (!researchLoaded) {
    loadResearchResults();
    researchLoaded = true;
  }
});

els.historySubHighlights.addEventListener('click', () => {
  els.historySubHighlights.classList.add('active');
  els.historySubBm.classList.remove('active');
  els.historySubResearch.classList.remove('active');
  els.historyHighlights.style.display = 'block';
  els.historyBookmarks.style.display = 'none';
  els.historyResearch.style.display = 'none';
  if (!highlightsLoaded) {
    loadHighlights();
    highlightsLoaded = true;
  }
});

// ── Bookmarks ──

function renderBookmarks(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) {
    els.bookmarksList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No bookmarks found</div>
        <div class="empty-subtitle">Save some bookmarks first</div>
      </div>`;
    return;
  }

  els.bookmarksList.innerHTML = bookmarks.map((bm) => `
    <div class="list-item" data-url="${escapeHtml(bm.url)}" data-id="${bm.id}">
      <div class="list-item-topic">${escapeHtml(bm.topic)}</div>
      <div class="list-item-title">${escapeHtml(truncate(bm.title || bm.url, 60))}</div>
      ${bm.notes ? `<div class="list-item-content" style="font-size:11px;font-style:italic;color:var(--text-secondary);margin-top:2px;">${escapeHtml(truncate(bm.notes, 80))}</div>` : ''}
      <div class="list-item-meta">
        <span class="list-item-date">
          ${formatRelativeTime(bm.created_at)}
          ${bm.remind_at ? ' ⏰' : ''}
        </span>
        <button class="delete-btn" data-id="${bm.id}" title="Delete bookmark">✕</button>
      </div>
    </div>
  `).join('');

  els.bookmarksList.querySelectorAll('.list-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-btn')) return;
      const url = item.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });

  els.bookmarksList.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const item = btn.closest('.list-item');
      item.style.opacity = '0.4';
      item.style.pointerEvents = 'none';
      try {
        await apiCall(`/bookmark/${id}`, { method: 'DELETE' });
        item.style.transition = 'all 0.3s ease';
        item.style.height = '0';
        item.style.padding = '0';
        item.style.overflow = 'hidden';
        setTimeout(() => item.remove(), 300);
        const current = parseInt(els.totalBookmarksStat.textContent) || 0;
        if (current > 0) els.totalBookmarksStat.textContent = current - 1;
      } catch {
        item.style.opacity = '1';
        item.style.pointerEvents = 'auto';
      }
    });
  });
}

async function loadAllBookmarks() {
  showStatus(els.historyStatus, 'Loading bookmarks...', 'loading');
  try {
    const [bmData, hlData] = await Promise.all([
      apiCall('/bookmarks?limit=100'),
      apiCall('/highlights/stats'),
    ]);
    els.totalBookmarksStat.textContent = bmData.stats?.total_bookmarks ?? bmData.total ?? 0;
    els.uniqueTopicsStat.textContent = bmData.stats?.unique_topics ?? '—';
    els.totalHighlightsStat.textContent = hlData.total ?? 0;
    renderBookmarks(bmData.bookmarks || []);
    hideStatus(els.historyStatus);
  } catch (err) {
    showStatus(els.historyStatus, err.message || 'Failed to load.', 'error');
  }
}

async function searchBookmarks() {
  const query = els.historySearchInput.value.trim();
  if (!query) { loadAllBookmarks(); return; }

  showStatus(els.historyStatus, `Searching...`, 'loading');
  try {
    const data = await apiCall(`/search?q=${encodeURIComponent(query)}`);
    renderBookmarks(data.results || []);
    if ((data.results || []).length === 0) {
      hideStatus(els.historyStatus);
    } else {
      showStatus(els.historyStatus, `Found ${data.count} result${data.count !== 1 ? 's' : ''}`, 'success', 3000);
    }
  } catch (err) {
    showStatus(els.historyStatus, err.message || 'Search failed.', 'error');
  }
}

els.historySearchBtn.addEventListener('click', searchBookmarks);
els.historySearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchBookmarks();
});

let searchDebounceTimer;
els.historySearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (els.historySearchInput.value.trim() === '') loadAllBookmarks();
  }, 500);
});

// ── Research (Problem #2) ──

function renderResearch(research) {
  if (!research || research.length === 0) {
    els.researchList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧠</div>
        <div class="empty-title">No research yet</div>
        <div class="empty-subtitle">Toggle "Research Later" when bookmarking a page</div>
      </div>`;
    return;
  }

  els.researchList.innerHTML = research.map((r) => {
    const statusClass = r.status === 'done' ? 'done' : r.status === 'processing' ? 'processing' : r.status === 'failed' ? 'failed' : 'pending';
    return `
      <div class="list-item" data-id="${r.id}">
        <div class="list-item-title">${escapeHtml(truncate(r.title || r.url, 60))}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;word-break:break-all;">${escapeHtml(truncate(r.url, 60))}</div>
        <div class="list-item-meta">
          <div class="research-status">
            <span class="status-badge ${statusClass}">${r.status}</span>
            <span class="list-item-date">${formatRelativeTime(r.created_at)}</span>
          </div>
          ${r.status === 'done' ? '<button class="btn btn-xs btn-secondary toggle-research-result">View Analysis</button>' : ''}
        </div>
        ${r.research_result ? `<div class="research-result" style="display:none;">${escapeHtml(r.research_result)}</div>` : ''}
        ${r.status === 'failed' && r.error_message ? `<div style="font-size:10px;color:#f87171;margin-top:4px;">Error: ${escapeHtml(r.error_message)}</div>` : ''}
      </div>`;
  }).join('');

  els.researchList.querySelectorAll('.toggle-research-result').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const resultDiv = btn.closest('.list-item').querySelector('.research-result');
      if (resultDiv) {
        resultDiv.style.display = resultDiv.style.display === 'none' ? 'block' : 'none';
        btn.textContent = resultDiv.style.display === 'block' ? 'Hide Analysis' : 'View Analysis';
      }
    });
  });
}

async function loadResearchResults() {
  try {
    const data = await apiCall('/research?limit=20');
    els.totalResearchStat.textContent = data.total || 0;
    renderResearch(data.research || []);
  } catch (err) {
    console.warn('[Load Research Error]', err.message);
  }
}

// ── Highlights ──
async function loadHighlights() {
  try {
    const data = await apiCall('/highlights?limit=50');
    renderHighlights(data.highlights || []);
  } catch (err) {
    console.warn('[Load Highlights Error]', err.message);
    els.highlightsList.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🖍</div>
      <div class="empty-title">Could not load highlights</div>
      <div class="empty-subtitle">Is the server running?</div>
    </div>`;
  }
}

function renderHighlights(highlights) {
  if (!highlights.length) {
    els.highlightsList.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🖍</div>
      <div class="empty-title">No highlights yet</div>
      <div class="empty-subtitle">Select text on any page, right-click → Save highlight to easy-rewind</div>
    </div>`;
    return;
  }

  let html = '';
  highlights.forEach((h) => {
    const colorHex = h.color === 'yellow' ? '#f59e0b' : h.color === 'green' ? '#34d399' : h.color === 'blue' ? '#60a5fa' : h.color === 'pink' ? '#ec4899' : '#a78bfa';
    html += `<div class="list-item" data-url="${escapeHtml(h.url || '')}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span class="highlight-color-dot" style="background:${colorHex};"></span>
        <span style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(h.page_title || 'Untitled').slice(0, 50)}</span>
      </div>
      <div class="highlight-quote">${escapeHtml(h.text)}</div>
      <div class="list-item-meta">
        <span class="list-item-date">${formatRelativeTime(h.created_at)}${h.tags ? ' · ' + escapeHtml(h.tags) : ''}</span>
        <div class="list-item-actions">
          <button class="delete-btn del-highlight" data-id="${h.id}" title="Delete highlight">✕</button>
        </div>
      </div>
    </div>`;
  });
  els.highlightsList.innerHTML = html;

  // Delete handlers
  els.highlightsList.querySelectorAll('.del-highlight').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      try {
        await apiCall(`/highlights/${id}`, { method: 'DELETE' });
        loadHighlights();
      } catch (err) {
        console.warn('[Delete Highlight Error]', err.message);
      }
    });
  });

  // Click to open source page
  els.highlightsList.querySelectorAll('.list-item[data-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      const url = el.dataset.url;
      if (url && url !== 'about:blank') {
        chrome.tabs.create({ url });
      }
    });
    el.style.cursor = 'pointer';
  });
}

// ═════════════════════════════════════════════
// COMBINED SEARCH: Search saved bookmarks + notes from Search tab
// ═════════════════════════════════════════════
async function searchSavedContent(term) {
  if (!term || term.trim().length < 2) {
    els.searchSavedResults.style.display = 'none';
    return;
  }

  try {
    const data = await apiCall(`/search?q=${encodeURIComponent(term)}`);
    const bookmarks = data.results || [];
    const notes = data.notes || [];

    if (bookmarks.length === 0 && notes.length === 0) {
      els.searchSavedResults.style.display = 'none';
      return;
    }

    let html = '';

    if (bookmarks.length > 0) {
      html += bookmarks.slice(0, 5).map(bm => `
        <div class="list-item" data-url="${escapeHtml(bm.url)}" style="cursor:pointer;">
          <div class="list-item-topic">${escapeHtml(bm.topic)}</div>
          <div class="list-item-title">${escapeHtml(truncate(bm.title || bm.url, 55))}</div>
          <div class="list-item-meta">
            <span class="list-item-date">🔖 ${formatRelativeTime(bm.created_at)}</span>
          </div>
        </div>
      `).join('');
    }

    if (notes.length > 0) {
      html += notes.slice(0, 3).map(note => `
        <div class="list-item" style="cursor:default;">
          <div class="list-item-content">${escapeHtml(truncate(note.content, 80))}</div>
          <div class="list-item-meta">
            <span class="list-item-date">📝 ${formatRelativeTime(note.created_at)}</span>
          </div>
        </div>
      `).join('');
    }

    els.searchSavedList.innerHTML = html;
    els.searchSavedResults.style.display = 'block';

    // Wire up click-to-open for bookmarks
    els.searchSavedList.querySelectorAll('.list-item[data-url]').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });
  } catch (err) {
    // Silent fail — this is a secondary feature
    console.warn('[Saved Search]', err.message);
  }
}

// ═════════════════════════════════════════════
// DASHBOARD LINKS
// ═════════════════════════════════════════════

async function openDashboard() {
  const url = await getFullApiUrl('/dashboard');
  chrome.tabs.create({ url });
}
els.openDashboardBtn.addEventListener('click', (e) => { e.preventDefault(); openDashboard(); });
els.footerDashboardLink.addEventListener('click', (e) => { e.preventDefault(); openDashboard(); });

// ═════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════
function openSettings() {
  // Load current settings and populate modal
  chrome.storage.local.get({
    easy_rewind_api_base: DEFAULT_API_BASE,
    easy_rewind_api_key: '',
    easy_rewind_ai_model: 'gemini-2.5-flash',
  }, (result) => {
    $('settings-api-url').value = result.easy_rewind_api_base || DEFAULT_API_BASE;
    $('settings-api-key').value = result.easy_rewind_api_key || '';
    $('settings-ai-model').value = result.easy_rewind_ai_model || 'gemini-2.5-flash';
    $('settings-overlay').classList.add('open');
  });
}

function closeSettings() {
  $('settings-overlay').classList.remove('open');
}

function saveSettings() {
  const apiUrl = $('settings-api-url').value.trim() || DEFAULT_API_BASE;
  const apiKey = $('settings-api-key').value.trim();
  const aiModel = $('settings-ai-model').value.trim() || 'gemini-2.5-flash';

  chrome.storage.local.set({
    easy_rewind_api_base: apiUrl,
    easy_rewind_api_key: apiKey,
    easy_rewind_ai_model: aiModel,
  }, () => {
    // Sync API key to backend if provided
    if (apiKey) {
      fetch(`${apiUrl.replace(/\/+$/, '')}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ gemini_api_key: apiKey, ai_model: aiModel }),
      }).catch(() => {});
    }
    showStatus(els.searchStatus, '✅ Settings saved!', 'success', 3000);
    closeSettings();
  });
}

$('settings-btn')?.addEventListener('click', openSettings);
$('settings-close-btn')?.addEventListener('click', closeSettings);
$('settings-save-btn')?.addEventListener('click', saveSettings);
$('settings-cancel-btn')?.addEventListener('click', closeSettings);
$('settings-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('settings-overlay')) closeSettings();
});

// ═════════════════════════════════════════════
// EXPORT / IMPORT
// ═════════════════════════════════════════════

$('export-data-btn')?.addEventListener('click', async () => {
  try {
    showStatus(els.searchStatus, 'Preparing export...', 'loading');
    const data = await apiCall('/export');
    if (data.error) throw new Error(data.error);

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `easy-rewind-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(els.searchStatus, `✅ Exported ${data.stats?.total || 0} items`, 'success', 3000);
  } catch (err) {
    showStatus(els.searchStatus, 'Export failed: ' + err.message, 'error', 4000);
  }
});

$('import-data-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.data) throw new Error('Invalid export file');
    showStatus(els.searchStatus, `Importing ${parsed.stats?.total || '...'} items...`, 'loading');
    const result = await apiCall('/import', {
      method: 'POST',
      body: JSON.stringify({ data: parsed.data }),
    });
    if (result.error) throw new Error(result.error);
    showStatus(els.searchStatus, `✅ Imported ${result.imported?.bookmarks || 0} bookmarks, ${result.imported?.notes || 0} notes, ${result.imported?.highlights || 0} highlights`, 'success', 4000);
  } catch (err) {
    showStatus(els.searchStatus, 'Import failed: ' + err.message, 'error', 5000);
  }
  e.target.value = '';
});

// ═════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════
init();
