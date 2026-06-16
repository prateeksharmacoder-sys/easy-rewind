/**
 * easy-rewind Knowledge Assistant — popup.js
 *
 * v2.5 — Redesigned: clean SVG icons, premium dark theme.
 * All logic identical; only visual/icon layer changed.
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const DEFAULT_API_BASE = 'http://localhost:5000';
const DASHBOARD_URL = 'http://localhost:5000/dashboard';

function getApiUrl(path) {
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
let selectedReminderMinutes = 0;
let selectedBookmarkReminderMinutes = null;
let conversationHistory = [];
let currentLookupTerm = '';

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tc'),

  // Search
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

  suggestionsRow: $('suggestions-row'),
  suggestionsList: $('suggestions-list'),
  followupRow: $('followup-row'),
  followupInput: $('followup-input'),
  followupBtn: $('followup-btn'),

  // Bookmark
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

  // Notes
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

  // History
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
  startServerBtn: $('start-server-btn'),

  // API Key bar
  apiBar: $('api-bar'),
  apiIndicator: $('api-indicator'),
  apiStatusText: $('api-status-text'),
  apiEditBtn: $('api-edit-btn'),
  apiBody: $('api-body'),
  apiKeyInput: $('api-key-input'),
  apiVisBtn: $('api-vis-btn'),
  apiSaveStatus: $('api-save-status'),

  // Header
  openDashboardBtn: $('open-dashboard-btn'),
  footerDashboardLink: $('footer-dashboard-link'),
};

// ─────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────

function showStatus(el, message, type, duration) {
  if (!el) return;
  el.textContent = message;
  el.className = 'stmsg visible ' + (type || 'loading');
  if (duration > 0) setTimeout(() => hideStatus(el), duration);
}

function hideStatus(el) { if (el) el.classList.remove('visible'); }

function setButtonLoading(btn, loading, originalText) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working...';
  } else {
    btn.disabled = false;
    btn.innerHTML = originalText || btn.innerHTML.replace('<span class="spinner"></span> Working...', '').trim();
  }
}

function parseDbDate(dateStr) {
  if (!dateStr) return new Date();
  const n = dateStr.replace(' ', 'T');
  return new Date(n.endsWith('Z') ? n : n + 'Z');
}

function formatRelativeTime(dateStr) {
  const date = parseDbDate(dateStr);
  const now = new Date();
  const diffMs = now - date;
  if (isNaN(diffMs) || diffMs < 0) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function truncate(str, max) {
  if (!str) return '';
  max = max || 80;
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

async function apiCall(path, options) {
  const url = await getApiUrl(path);
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
      ...(options ? (options.headers || {}) : {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

async function initUserId() {
  let clientId = await new Promise(resolve =>
    chrome.storage.local.get({ easy_rewind_user_id: '' }, result => {
      if (result.easy_rewind_user_id) resolve(result.easy_rewind_user_id);
      else {
        const id = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        chrome.storage.local.set({ easy_rewind_user_id: id });
        resolve(id);
      }
    })
  );

  try {
    const baseUrl = await new Promise(resolve =>
      chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, result =>
        resolve((result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, ''))
      )
    );
    const sessionResp = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_type: 'extension' }),
    });
    if (sessionResp.ok) {
      const session = await sessionResp.json();
      userId = session.user_id;
      chrome.storage.local.set({ easy_rewind_user_id: userId });
    } else { userId = clientId; }
  } catch { userId = clientId; }
  return userId;
}

async function getCurrentPageInfo() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs && tabs[0]) {
        currentTabId = tabs[0].id;
        resolve({ url: tabs[0].url || '', title: tabs[0].title || 'Untitled Page' });
      } else resolve({ url: '', title: 'Unknown Page' });
    });
  });
}

async function checkServerHealth() {
  try {
    await apiCall('/health');
    if (els.serverStatusDot) els.serverStatusDot.classList.add('online');
    if (els.serverStatusText) els.serverStatusText.textContent = 'Online';
    if (els.startServerBtn) els.startServerBtn.style.display = 'none';
    loadApiKeyStatus();
    return true;
  } catch {
    if (els.serverStatusDot) els.serverStatusDot.classList.remove('online');
    if (els.serverStatusText) els.serverStatusText.textContent = 'Offline';
    if (els.startServerBtn) els.startServerBtn.style.display = 'inline-block';
    return false;
  }
}

// ─────────────────────────────────────────────
// API KEY MANAGEMENT
// ─────────────────────────────────────────────

function getApiBaseUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, result =>
      resolve((result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, ''))
    );
  });
}

function loadApiKeyStatus() {
  chrome.storage.local.get({ easy_rewind_api_key: '' }, result => {
    const key = result.easy_rewind_api_key || '';
    if (els.apiKeyInput) els.apiKeyInput.value = key;
    updateApiKeyIndicator(key);
  });
}

function updateApiKeyIndicator(key) {
  const hasKey = !!key && key.length > 10;
  if (els.apiIndicator) {
    els.apiIndicator.className = 'api-dot ' + (hasKey ? 'ok' : 'missing');
  }
  if (els.apiStatusText) {
    els.apiStatusText.textContent = hasKey
      ? 'Configured (' + key.slice(0, 8) + '...)'
      : 'Not configured';
  }
}

let apiKeySaveTimer = null;
function handleApiKeyChange() {
  const key = (els.apiKeyInput.value || '').trim();
  if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
  if (els.apiSaveStatus) {
    els.apiSaveStatus.textContent = 'Saving...';
    els.apiSaveStatus.className = 'api-save-status saving';
  }
  apiKeySaveTimer = setTimeout(async () => {
    try {
      await new Promise(resolve => chrome.storage.local.set({ easy_rewind_api_key: key }, resolve));
      const base = await getApiBaseUrl();
      fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ gemini_api_key: key || null }),
      }).catch(() => {});
      updateApiKeyIndicator(key);
      const sf = $('settings-api-key');
      if (sf) sf.value = key;
      if (els.apiSaveStatus) {
        els.apiSaveStatus.textContent = 'Saved';
        els.apiSaveStatus.className = 'api-save-status saved';
        setTimeout(() => {
          if (els.apiSaveStatus && els.apiSaveStatus.classList.contains('saved')) {
            els.apiSaveStatus.textContent = '';
            els.apiSaveStatus.className = 'api-save-status';
          }
        }, 2000);
      }
    } catch (err) {
      if (els.apiSaveStatus) {
        els.apiSaveStatus.textContent = 'Save failed';
        els.apiSaveStatus.className = 'api-save-status error';
      }
    }
  }, 600);
}

function toggleApiKeyVisibility() {
  if (!els.apiKeyInput) return;
  if (els.apiKeyInput.type === 'password') {
    els.apiKeyInput.type = 'text';
  } else {
    els.apiKeyInput.type = 'password';
  }
}

function toggleApiKeyBody() {
  if (!els.apiBody) return;
  const vis = els.apiBody.style.display !== 'none';
  els.apiBody.style.display = vis ? 'none' : 'block';
  if (!vis && els.apiKeyInput) {
    els.apiKeyInput.focus();
    const len = els.apiKeyInput.value.length;
    els.apiKeyInput.setSelectionRange(len, len);
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

  if (currentPageUrl) els.notePageInfo.style.display = 'block';

  checkServerHealth();
  loadApiKeyStatus();
  setInterval(checkServerHealth, 30000);

  // Open specific tab from storage
  chrome.storage.local.get(['easy_rewind_open_tab'], result => {
    if (result.easy_rewind_open_tab) {
      const tab = result.easy_rewind_open_tab;
      switchTab(tab === 'save' ? 'bookmark' : tab);
      chrome.storage.local.remove('easy_rewind_open_tab');
    }
  });

  // Sync settings to backend
  chrome.storage.local.get({
    easy_rewind_api_key: '',
    easy_rewind_ai_model: 'gemini-2.5-flash',
    easy_rewind_api_base: DEFAULT_API_BASE,
  }, result => {
    if (result.easy_rewind_api_key || result.easy_rewind_ai_model !== 'gemini-2.5-flash') {
      const base = (result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
      const body = {};
      if (result.easy_rewind_api_key) body.gemini_api_key = result.easy_rewind_api_key;
      if (result.easy_rewind_ai_model) body.ai_model = result.easy_rewind_ai_model;
      fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
  });

  // Pending note
  chrome.storage.local.get(['easy_rewind_pending_note'], result => {
    const p = result.easy_rewind_pending_note;
    if (p) {
      els.noteContentInput.value = p.content || '';
      if (p.source_url) {
        els.noteSourceTitle.textContent = truncate(p.source_title || 'Linked page', 50);
        els.noteSourceUrl.textContent = truncate(p.source_url, 60);
        els.notePageInfo.style.display = 'block';
      }
      chrome.storage.local.remove('easy_rewind_pending_note');
      switchTab('notes');
      els.noteContentInput.focus();
    }
  });

  // Pending bookmark
  chrome.storage.local.get(['easy_rewind_pending_bookmark'], result => {
    const p = result.easy_rewind_pending_bookmark;
    if (p) {
      currentPageUrl = p.url || currentPageUrl;
      currentPageTitle = p.title || currentPageTitle;
      els.pageTitleDisplay.textContent = truncate(currentPageTitle, 60);
      els.pageUrlDisplay.textContent = truncate(currentPageUrl, 70);
      chrome.storage.local.remove('easy_rewind_pending_bookmark');
      switchTab('bookmark');
      els.topicInput.focus();
    }
  });

  // Pending lookup
  chrome.storage.local.get(['easy_rewind_pending_lookup'], result => {
    if (result.easy_rewind_pending_lookup) {
      els.searchInput.value = result.easy_rewind_pending_lookup;
      chrome.storage.local.remove('easy_rewind_pending_lookup');
      switchTab('search');
      setTimeout(handleLookup, 200);
    }
  });

  // Auto-capture
  chrome.storage.local.get(['easy_rewind_pending_auto_save'], async result => {
    const p = result.easy_rewind_pending_auto_save;
    if (p) {
      currentPageUrl = p.url || currentPageUrl;
      currentPageTitle = p.title || currentPageTitle;
      els.pageTitleDisplay.textContent = truncate(currentPageTitle, 60);
      els.pageUrlDisplay.textContent = truncate(currentPageUrl, 70);
      els.topicInput.value = currentPageTitle.slice(0, 100);
      els.topicInput.focus();
      const mins = Math.round(p.engagement?.elapsed_min || 0);
      const depth = p.engagement?.max_scroll_depth || 0;
      showStatus(els.bookmarkStatus,
        'Captured from your reading session (' + mins + 'min, ' + depth + '% scroll) — review and save',
        'success', 8000);
      switchTab('bookmark');
      chrome.storage.local.remove('easy_rewind_pending_auto_save');
    }
  });

  loadRecentNotes();
}

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────

let historyLoaded = false;
let researchLoaded = false;
let highlightsLoaded = false;

function switchTab(tabName) {
  els.tabBtns.forEach(b => b.classList.remove('active'));
  els.tabContents.forEach(c => c.classList.remove('active'));
  const tb = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const tc = $(`tab-${tabName}`);
  if (tb) tb.classList.add('active');
  if (tc) tc.classList.add('active');
  if (tabName === 'history' && !historyLoaded) { loadAllBookmarks(); historyLoaded = true; }
  if (tabName === 'history' && !researchLoaded) { loadResearchResults(); researchLoaded = true; }
  if (tabName === 'notes') { loadRecentNotes(); }
}

els.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─────────────────────────────────────────────
// TAB 1: SEARCH — AI Quick Lookup
// ─────────────────────────────────────────────

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

  if (!arguments[0]?.isFollowUp) conversationHistory = [];

  try {
    let page_context = '';
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
      } catch {}
    }
    const body = { term, page_context, page_title: currentPageTitle };
    if (conversationHistory.length > 0) body.conversation = conversationHistory;
    const data = await apiCall('/quick-lookup', { method: 'POST', body: JSON.stringify(body) });

    currentLookupTerm = data.term;
    els.resultTerm.textContent = data.term;
    els.resultDef.textContent = data.definition;
    els.resultBadge.textContent = data.source === 'cache' ? 'Cached' : 'AI';
    els.resultBadge.className = 'src-badge ' + (data.source === 'cache' ? 'cache' : 'ai');
    els.resultMeta.textContent = data.source === 'cache' ? 'Retrieved from cache'
      : data.source === 'mock' ? 'Mock response — configure AI key'
      : 'Generated by AI';
    els.definitionCard.classList.add('visible');

    if (data.suggestions && data.suggestions.length > 0) {
      els.suggestionsList.innerHTML = data.suggestions.map(s =>
        '<span class="suggest-chip" data-term="' + escapeHtml(s) + '">' + escapeHtml(s) + '</span>'
      ).join('');
      els.suggestionsRow.style.display = 'flex';
      els.suggestionsList.querySelectorAll('.suggest-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          els.searchInput.value = chip.dataset.term;
          els.followupRow.style.display = 'none';
          els.suggestionsRow.style.display = 'none';
          conversationHistory = [];
          handleLookup();
        });
      });
    }

    searchSavedContent(term);
    els.followupRow.style.display = 'flex';

    const lastQuestion = conversationHistory.length > 0
      ? conversationHistory[conversationHistory.length - 1]?.term
      : term;
    conversationHistory.push({ term: lastQuestion, definition: data.definition });
    if (arguments[0]?.isFollowUp) els.searchInput.value = '';
  } catch (err) {
    showStatus(els.searchStatus, err.message || 'Could not connect. Is the server running?', 'error', 5000);
  } finally {
    setButtonLoading(els.lookupBtn, false, 'Get AI Definition');
  }
}

async function handleFollowUp() {
  const q = els.followupInput.value.trim();
  if (!q) return;
  els.searchInput.value = q;
  els.followupInput.value = '';
  conversationHistory.push({ term: q });
  await handleLookup({ isFollowUp: true });
}

els.lookupBtn.addEventListener('click', () => handleLookup());
els.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLookup(); });
els.followupBtn?.addEventListener('click', handleFollowUp);
els.followupInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleFollowUp(); });

// ─────────────────────────────────────────────
// SUMMARIZE PAGE
// ─────────────────────────────────────────────

function formatSummary(text) {
  if (!text) return '';
  const paragraphs = text.split(/\n\n+/);
  return paragraphs.map(p => {
    const lines = p.split('\n');
    const formatted = lines.map(line => {
      if (/^#{1,3}\s/.test(line)) {
        const c = line.replace(/^#{1,3}\s+/, '');
        return '<strong style="font-size:14px;display:block;margin:8px 0 4px;">' + escapeHtml(c) + '</strong>';
      }
      if (/^[\-\*]\s/.test(line)) {
        return '• ' + formatInline(line.replace(/^[\-\*]\s+/, ''));
      }
      return formatInline(line);
    });
    return '<p style="margin-bottom:6px;">' + formatted.join('<br>') + '</p>';
  }).join('');
}

function formatInline(text) {
  if (!text) return '';
  const esc = escapeHtml(text);
  return esc.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>');
}

async function handleSummarizePage() {
  showStatus(els.searchStatus, 'Reading page content...', 'loading');
  els.summaryCard.classList.remove('visible');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    let pageData = { url: tab.url, title: tab.title, description: '', textContent: '' };
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'SUMMARY_PAGE' });
      if (r) { pageData = { url: r.url || tab.url, title: r.title || tab.title, description: r.description || '', textContent: r.textContent || '' }; }
    } catch {
      showStatus(els.searchStatus, 'Scanning page metadata...', 'loading');
      try {
        const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
        if (info) { pageData = { url: info.url || tab.url, title: info.title || tab.title, description: info.description || '', textContent: info.textContent || '' }; }
      } catch { throw new Error('Could not reach the page. Try reloading first.'); }
    }
    const combined = [pageData.title && ('Title: ' + pageData.title), pageData.description && ('Description: ' + pageData.description), pageData.textContent].filter(Boolean).join('\n\n').trim();
    if (!combined || combined.length < 20) throw new Error('Not enough content to summarize.');

    let summary = null, source = null;
    if (window.ai?.summarizer || 'Summarizer' in window) {
      try {
        showStatus(els.searchStatus, 'Using on-device AI...', 'loading');
        const s = await window.ai.summarizer.create({ type: 'tl;dr', format: 'plain-text', length: 'medium' });
        summary = await s.summarize(combined.slice(0, 12000));
        source = 'local-ai';
      } catch (e) { console.log('[Summarize] On-device failed:', e.message); }
    }
    if (!summary) {
      showStatus(els.searchStatus, 'Generating AI summary...', 'loading');
      const data = await apiCall('/page-summary', {
        method: 'POST',
        body: JSON.stringify({
          url: pageData.url, title: pageData.title,
          description: pageData.description,
          text_content: pageData.textContent.slice(0, 12000),
        }),
      });
      summary = data.summary;
      source = data.source;
    }
    if (summary) {
      els.summaryDef.innerHTML = formatSummary(summary);
      els.summaryMeta.textContent = source === 'local-ai' ? 'On-device AI' : source === 'ai' ? 'AI' : 'Summary';
      els.summaryCard.classList.add('visible');
      hideStatus(els.searchStatus);
    } else throw new Error('No summary returned');
  } catch (err) {
    showStatus(els.searchStatus, err.message || 'Failed.', 'error', 5000);
  }
}
els.summarizeBtn?.addEventListener('click', handleSummarizePage);

// ─────────────────────────────────────────────
// TAB 2: BOOKMARK
// ─────────────────────────────────────────────

els.bookmarkReminderToggle.addEventListener('click', () => {
  els.bookmarkReminderBody.classList.toggle('open');
});

els.bookmarkReminderPresets.forEach(btn => {
  btn.addEventListener('click', () => {
    els.bookmarkReminderPresets.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedBookmarkReminderMinutes = parseInt(btn.dataset.minutes);
    els.bookmarkReminderCustom.value = '';
  });
});

els.bookmarkReminderCustom.addEventListener('input', () => {
  const v = parseInt(els.bookmarkReminderCustom.value);
  if (v > 0) {
    selectedBookmarkReminderMinutes = v;
    els.bookmarkReminderPresets.forEach(b => b.classList.remove('active'));
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
    const body = { url: currentPageUrl, title: currentPageTitle || currentPageUrl, topic, notes };
    if (selectedBookmarkReminderMinutes) body.remind_in_minutes = selectedBookmarkReminderMinutes;
    const data = await apiCall('/bookmark', { method: 'POST', body: JSON.stringify(body) });
    if (els.researchToggle.checked && data.bookmark) {
      showStatus(els.bookmarkStatus, 'Saving + queuing AI research...', 'loading');
      await apiCall('/research', { method: 'POST', body: JSON.stringify({
        url: currentPageUrl, title: currentPageTitle || currentPageUrl, user_notes: notes || topic, auto_process: true,
      }) });
    }
    const parts = ['Saved!'];
    if (selectedBookmarkReminderMinutes) {
      const m = selectedBookmarkReminderMinutes;
      parts.push('Reminder in ' + (m >= 1440 ? Math.floor(m / 1440) + 'd' : m >= 60 ? Math.floor(m / 60) + 'h' : m + 'min'));
    }
    if (els.researchToggle.checked) parts.push('Research queued!');
    showStatus(els.bookmarkStatus, parts.join(' '), 'success', 4000);
    els.topicInput.value = '';
    els.notesInput.value = '';
    els.researchToggle.checked = false;
    selectedBookmarkReminderMinutes = null;
    els.bookmarkReminderPresets.forEach(b => b.classList.remove('active'));
    if (historyLoaded) loadAllBookmarks();
  } catch (err) {
    showStatus(els.bookmarkStatus, err.message || 'Failed to save.', 'error', 5000);
  } finally {
    setButtonLoading(els.saveBookmarkBtn, false, 'Save Bookmark');
  }
}
els.saveBookmarkBtn.addEventListener('click', handleSaveBookmark);

// ─────────────────────────────────────────────
// TAB 3: NOTES
// ─────────────────────────────────────────────

els.noteReminderToggle.addEventListener('click', () => {
  els.noteReminderBody.classList.toggle('open');
});

els.noteReminderPresets.forEach(btn => {
  btn.addEventListener('click', () => {
    els.noteReminderPresets.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedReminderMinutes = parseInt(btn.dataset.minutes);
    els.noteReminderCustom.value = '';
    els.noteReminderTabClose.closest('.toggle-row').style.display =
      selectedReminderMinutes === 0 ? 'flex' : 'none';
  });
});

els.noteReminderCustom.addEventListener('input', () => {
  const v = parseInt(els.noteReminderCustom.value);
  if (v > 0) {
    selectedReminderMinutes = v;
    els.noteReminderPresets.forEach(b => b.classList.remove('active'));
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
    const body = { content, source_url: currentPageUrl || undefined, source_title: currentPageTitle || undefined };
    let shouldTrackTabClose = false;
    if (selectedReminderMinutes > 0) body.remind_in_minutes = selectedReminderMinutes;
    else if (selectedReminderMinutes === 0 && els.noteReminderTabClose.checked) shouldTrackTabClose = true;

    const data = await apiCall('/notes', { method: 'POST', body: JSON.stringify(body) });
    if (shouldTrackTabClose && currentTabId && data.note) {
      chrome.runtime.sendMessage({
        type: 'TRACK_TAB_REMINDER',
        noteData: { id: data.note.id, content, source_title: currentPageTitle },
      });
    }
    showStatus(els.noteStatus,
      shouldTrackTabClose ? 'Saved! I will remind you when you leave this tab.' : 'Saved!',
      'success', 3000);
    els.noteContentInput.value = '';
    els.noteReminderPresets.forEach(b => b.classList.remove('active'));
    const def = document.querySelector('#note-reminder-body .preset-btn[data-minutes="0"]');
    if (def) def.classList.add('active');
    selectedReminderMinutes = 0;
    loadRecentNotes();
  } catch (err) {
    showStatus(els.noteStatus, err.message || 'Failed.', 'error', 5000);
  } finally {
    setButtonLoading(els.saveNoteBtn, false, 'Save Thought');
  }
}
els.saveNoteBtn.addEventListener('click', handleSaveNote);
els.noteContentInput.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') handleSaveNote();
});

async function loadRecentNotes() {
  try {
    const data = await apiCall('/notes?limit=10');
    const notes = data.notes || [];
    const pendingCount = notes.filter(n => !n.completed).length;
    if (pendingCount > 0) {
      els.notesBadge.style.display = 'inline';
      els.notesBadge.textContent = pendingCount;
    } else { els.notesBadge.style.display = 'none'; }

    if (!notes.length) {
      els.recentNotesList.innerHTML = '<div class="empty"><div class="empty-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div><div class="empty-title">No thoughts captured yet</div><div class="empty-sub">Ideas vanish fast — write them down here</div></div>';
      return;
    }
    els.recentNotesList.innerHTML = notes.map(note =>
      '<div class="list-item" data-id="' + note.id + '">' +
        '<div class="list-item-text" style="' + (note.completed ? 'text-decoration:line-through;opacity:0.5;' : '') + '">' + escapeHtml(truncate(note.content, 150)) + '</div>' +
        (note.source_title ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + escapeHtml(truncate(note.source_title, 60)) + '</div>' : '') +
        '<div class="list-meta">' +
          '<span class="list-date">' + formatRelativeTime(note.created_at) + (note.completed ? ' Done' : '') + '</span>' +
          '<div class="list-actions">' +
            '<button class="done-btn ' + (note.completed ? 'done' : '') + '" data-id="' + note.id + '" data-completed="' + note.completed + '">' +
              '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</button>' +
            '<button class="tbl-btn" data-id="' + note.id + '">' +
              '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    ).join('');

    els.recentNotesList.querySelectorAll('.done-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await apiCall('/notes/' + btn.dataset.id + '/toggle', { method: 'PATCH' });
          loadRecentNotes();
        } catch (err) { showStatus(els.noteStatus, 'Failed.', 'error', 3000); }
      });
    });
    els.recentNotesList.querySelectorAll('.tbl-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const item = btn.closest('.list-item');
        item.style.opacity = '0.3';
        try {
          await apiCall('/notes/' + btn.dataset.id, { method: 'DELETE' });
          item.remove();
          loadRecentNotes();
        } catch (err) { item.style.opacity = '1'; showStatus(els.noteStatus, 'Failed.', 'error', 3000); }
      });
    });
  } catch (err) { console.warn('[Notes]', err.message); }
}

// ─────────────────────────────────────────────
// TAB 4: HISTORY
// ─────────────────────────────────────────────

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
  if (!researchLoaded) { loadResearchResults(); researchLoaded = true; }
});
els.historySubHighlights.addEventListener('click', () => {
  els.historySubHighlights.classList.add('active');
  els.historySubBm.classList.remove('active');
  els.historySubResearch.classList.remove('active');
  els.historyHighlights.style.display = 'block';
  els.historyBookmarks.style.display = 'none';
  els.historyResearch.style.display = 'none';
  if (!highlightsLoaded) { loadHighlights(); highlightsLoaded = true; }
});

function renderBookmarks(bookmarks) {
  if (!bookmarks || !bookmarks.length) {
    els.bookmarksList.innerHTML = '<div class="empty"><div class="empty-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></div><div class="empty-title">No bookmarks found</div><div class="empty-sub">Save some bookmarks first</div></div>';
    return;
  }
  els.bookmarksList.innerHTML = bookmarks.map(bm =>
    '<div class="list-item" data-url="' + escapeHtml(bm.url) + '" data-id="' + bm.id + '">' +
      '<div class="list-topic">' + escapeHtml(bm.topic) + '</div>' +
      '<div class="list-item-title">' + escapeHtml(truncate(bm.title || bm.url, 60)) + '</div>' +
      (bm.notes ? '<div class="list-item-text" style="font-size:11px;font-style:italic;color:var(--text-secondary);margin-top:2px;">' + escapeHtml(truncate(bm.notes, 80)) + '</div>' : '') +
      '<div class="list-meta">' +
        '<span class="list-date">' + formatRelativeTime(bm.created_at) + '</span>' +
        '<button class="tbl-btn" data-id="' + bm.id + '">' +
          '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>'
  ).join('');

  els.bookmarksList.querySelectorAll('.list-item[data-url]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.tbl-btn')) return;
      const url = item.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
  els.bookmarksList.querySelectorAll('.tbl-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const item = btn.closest('.list-item');
      item.style.opacity = '0.4';
      item.style.pointerEvents = 'none';
      try {
        await apiCall('/bookmark/' + id, { method: 'DELETE' });
        item.style.transition = 'all 0.3s ease';
        item.style.height = '0';
        item.style.padding = '0';
        item.style.margin = '0';
        item.style.overflow = 'hidden';
        setTimeout(() => item.remove(), 300);
        const curr = parseInt(els.totalBookmarksStat.textContent) || 0;
        if (curr > 0) els.totalBookmarksStat.textContent = String(curr - 1);
      } catch { item.style.opacity = '1'; item.style.pointerEvents = 'auto'; }
    });
  });
}

async function loadAllBookmarks() {
  showStatus(els.historyStatus, 'Loading bookmarks...', 'loading');
  try {
    const [bmData, hlData] = await Promise.all([
      apiCall('/bookmarks?limit=100'),
      apiCall('/highlights/stats').catch(() => ({ total: 0 })),
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
  const q = els.historySearchInput.value.trim();
  if (!q) { loadAllBookmarks(); return; }
  showStatus(els.historyStatus, 'Searching...', 'loading');
  try {
    const data = await apiCall('/search?q=' + encodeURIComponent(q));
    renderBookmarks(data.results || []);
    if (!(data.results || []).length) hideStatus(els.historyStatus);
    else showStatus(els.historyStatus, 'Found ' + data.count + ' result' + (data.count !== 1 ? 's' : ''), 'success', 3000);
  } catch (err) { showStatus(els.historyStatus, err.message || 'Failed.', 'error'); }
}
els.historySearchBtn.addEventListener('click', searchBookmarks);
els.historySearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBookmarks(); });
let searchDebounce;
els.historySearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { if (!els.historySearchInput.value.trim()) loadAllBookmarks(); }, 500);
});

function renderResearch(research) {
  if (!research || !research.length) {
    els.researchList.innerHTML = '<div class="empty"><div class="empty-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div><div class="empty-title">No research yet</div><div class="empty-sub">Toggle "Research Later" when bookmarking</div></div>';
    return;
  }
  els.researchList.innerHTML = research.map(r => {
    const sc = r.status === 'done' ? 'done' : r.status === 'processing' ? 'processing' : r.status === 'failed' ? 'failed' : 'pending';
    return '<div class="list-item" data-id="' + r.id + '">' +
      '<div class="list-item-title">' + escapeHtml(truncate(r.title || r.url, 60)) + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted);margin-top:1px;word-break:break-all;">' + escapeHtml(truncate(r.url, 60)) + '</div>' +
      '<div class="list-meta">' +
        '<div class="res-status"><span class="st-badge ' + sc + '">' + r.status + '</span><span class="list-date">' + formatRelativeTime(r.created_at) + '</span></div>' +
        (r.status === 'done' ? '<button class="btn btn-xs btn-secondary toggle-research-result">View Analysis</button>' : '') +
      '</div>' +
      (r.research_result ? '<div class="res-result">' + escapeHtml(r.research_result) + '</div>' : '') +
      (r.status === 'failed' && r.error_message ? '<div style="font-size:10px;color:var(--red);margin-top:3px;">' + escapeHtml(r.error_message) + '</div>' : '') +
    '</div>';
  }).join('');
  els.researchList.querySelectorAll('.toggle-research-result').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const rd = btn.closest('.list-item').querySelector('.res-result');
      if (rd) { rd.classList.toggle('visible'); btn.textContent = rd.classList.contains('visible') ? 'Hide Analysis' : 'View Analysis'; }
    });
  });
}

async function loadResearchResults() {
  try {
    const data = await apiCall('/research?limit=20');
    els.totalResearchStat.textContent = data.total || 0;
    renderResearch(data.research || []);
  } catch (err) {
    console.warn('[Research]', err.message);
    els.researchList.innerHTML = '<div class="empty"><div class="empty-title">Could not load research</div><div class="empty-sub">' + escapeHtml(err.message || '') + '</div></div>';
  }
}

async function loadHighlights() {
  try {
    const data = await apiCall('/highlights?limit=50');
    renderHighlights(data.highlights || []);
  } catch (err) {
    console.warn('[Highlights]', err.message);
    els.highlightsList.innerHTML = '<div class="empty"><div class="empty-title">Could not load highlights</div><div class="empty-sub">Is the server running?</div></div>';
  }
}

function renderHighlights(highlights) {
  if (!highlights.length) {
    els.highlightsList.innerHTML = '<div class="empty"><div class="empty-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div><div class="empty-title">No highlights yet</div><div class="empty-sub">Select text, right-click → Save highlight</div></div>';
    return;
  }
  const colorHex = { yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', pink: '#ec4899', purple: '#a78bfa' };
  els.highlightsList.innerHTML = highlights.map(h => {
    const hex = colorHex[h.color] || '#a78bfa';
    return '<div class="list-item" data-url="' + escapeHtml(h.url || '') + '">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">' +
        '<span class="hl-color" style="background:' + hex + ';"></span>' +
        '<span style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;">' + escapeHtml((h.page_title || 'Untitled').slice(0, 50)) + '</span>' +
      '</div>' +
      '<div class="highlight-quote">' + escapeHtml(h.text) + '</div>' +
      '<div class="list-meta">' +
        '<span class="list-date">' + formatRelativeTime(h.created_at) + (h.tags ? ' · ' + escapeHtml(h.tags) : '') + '</span>' +
        '<button class="tbl-btn del-highlight" data-id="' + h.id + '">' +
          '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
  els.highlightsList.querySelectorAll('.del-highlight').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      try { await apiCall('/highlights/' + btn.dataset.id, { method: 'DELETE' }); loadHighlights(); }
      catch (err) { console.warn('[Delete highlight]', err.message); }
    });
  });
  els.highlightsList.querySelectorAll('.list-item[data-url]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tbl-btn')) return;
      const u = el.dataset.url;
      if (u && u !== 'about:blank') chrome.tabs.create({ url: u });
    });
    el.style.cursor = 'pointer';
  });
}

// ─────────────────────────────────────────────
// COMBINED SEARCH
// ─────────────────────────────────────────────

async function searchSavedContent(term) {
  if (!term || term.trim().length < 2) { els.searchSavedResults.style.display = 'none'; return; }
  try {
    const [bmData, itemsData] = await Promise.all([
      apiCall('/search?q=' + encodeURIComponent(term)).catch(() => null),
      apiCall('/items/search?q=' + encodeURIComponent(term)).catch(() => null),
    ]);
    const bookmarks = bmData?.results || [];
    const notes = bmData?.notes || [];
    const items = itemsData?.results || [];
    if (!bookmarks.length && !notes.length && !items.length) { els.searchSavedResults.style.display = 'none'; return; }

    let html = '';
    if (items.length > 0) {
      html += items.slice(0, 5).map(item =>
        '<div class="list-item" data-url="' + escapeHtml(item.url) + '" data-item-id="' + item.id + '" style="cursor:pointer;">' +
          '<div class="list-topic">' + escapeHtml(item.title || 'Untitled') + '</div>' +
          '<div class="list-item-text">' + escapeHtml(truncate(item.summary || item.content || '', 80)) + '</div>' +
          (item.tags ? '<div style="font-size:9px;color:var(--text-muted);margin-top:1px;">' + escapeHtml(item.tags) + '</div>' : '') +
          '<div class="list-meta"><span class="list-date">' + formatRelativeTime(item.created_at) + '</span></div>' +
        '</div>'
      ).join('');
    }
    if (bookmarks.length > 0) {
      html += bookmarks.slice(0, 5).map(bm =>
        '<div class="list-item" data-url="' + escapeHtml(bm.url) + '" style="cursor:pointer;">' +
          '<div class="list-topic">' + escapeHtml(bm.topic) + '</div>' +
          '<div class="list-item-title">' + escapeHtml(truncate(bm.title || bm.url, 55)) + '</div>' +
          '<div class="list-meta"><span class="list-date">' + formatRelativeTime(bm.created_at) + '</span></div>' +
        '</div>'
      ).join('');
    }
    if (notes.length > 0) {
      html += notes.slice(0, 3).map(note =>
        '<div class="list-item" style="cursor:default;">' +
          '<div class="list-item-text">' + escapeHtml(truncate(note.content, 80)) + '</div>' +
          '<div class="list-meta"><span class="list-date">' + formatRelativeTime(note.created_at) + '</span></div>' +
        '</div>'
      ).join('');
    }
    els.searchSavedList.innerHTML = html;
    els.searchSavedResults.style.display = 'block';

    els.searchSavedList.querySelectorAll('.list-item[data-url]:not([data-item-id])').forEach(item => {
      item.addEventListener('click', () => { const u = item.dataset.url; if (u) chrome.tabs.create({ url: u }); });
    });
    els.searchSavedList.querySelectorAll('.list-item[data-item-id]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        loadRelatedItemsForItem(item.dataset.itemId, item.dataset.url);
      });
    });
  } catch (err) { console.warn('[Saved Search]', err.message); }
}

// ─────────────────────────────────────────────
// RELATED MEMORIES
// ─────────────────────────────────────────────

async function loadRelatedItemsForItem(itemId) {
  if (!itemId) return;
  const listEl = $('search-related-list');
  const container = $('search-related-results');
  if (!listEl || !container) return;
  container.style.display = 'block';
  listEl.innerHTML = '<div style="text-align:center;padding:6px;font-size:11px;color:var(--text-muted);">Finding related memories...</div>';
  try {
    const data = await apiCall('/items/' + itemId + '/related');
    const related = data.related || [];
    if (!related.length) { container.style.display = 'none'; return; }
    listEl.innerHTML = related.slice(0, 5).map(r =>
      '<div class="list-item" data-url="' + escapeHtml(r.url || '') + '" style="cursor:pointer;padding:6px 8px;">' +
        '<div class="list-item-title" style="font-size:11px;">' + escapeHtml(r.title || 'Related memory') + '</div>' +
        '<div style="font-size:9px;color:var(--text-muted);margin-top:1px;">' +
          (r.summary ? escapeHtml(truncate(r.summary, 60)) : '') +
          (r.tags ? ' · ' + escapeHtml(r.tags) : '') +
        '</div>' +
        '<div class="list-meta" style="margin-top:2px;"><span class="list-date">' + Math.round((r.similarity || 0) * 100) + '% match</span></div>' +
      '</div>'
    ).join('');
    listEl.querySelectorAll('.list-item[data-url]').forEach(item => {
      item.addEventListener('click', () => { const u = item.dataset.url; if (u) chrome.tabs.create({ url: u }); });
    });
  } catch (err) { console.warn('[Related]', err.message); container.style.display = 'none'; }
}

// ─────────────────────────────────────────────
// DASHBOARD LINK
// ─────────────────────────────────────────────

async function openDashboard() {
  const url = await getFullApiUrl('/dashboard');
  chrome.tabs.create({ url });
}
els.openDashboardBtn.addEventListener('click', e => { e.preventDefault(); openDashboard(); });
els.footerDashboardLink.addEventListener('click', e => { e.preventDefault(); openDashboard(); });

// ═══ API Key Bar Events ═══
els.apiBar?.addEventListener('click', e => {
  if (e.target.closest('button')) return;
  toggleApiKeyBody();
});
els.apiEditBtn?.addEventListener('click', e => {
  e.stopPropagation();
  toggleApiKeyBody();
});
els.apiKeyInput?.addEventListener('input', handleApiKeyChange);
els.apiVisBtn?.addEventListener('click', e => {
  e.stopPropagation();
  toggleApiKeyVisibility();
});

// ═══ Start Server Button ═══
els.startServerBtn?.addEventListener('click', async () => {
  if (!els.startServerBtn) return;
  els.startServerBtn.disabled = true;
  els.startServerBtn.textContent = 'Trying...';
  showStatus(els.searchStatus,
    'Starting server… If this takes a while, run start-backend.bat from the project folder.',
    'loading');
  let ok = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const b = await getApiBaseUrl(); const r = await fetch(b + '/api/health'); if (r.ok) { ok = true; break; } } catch {}
  }
  if (ok) {
    showStatus(els.searchStatus, 'Server connected!', 'success', 3000);
    checkServerHealth();
  } else {
    showStatus(els.searchStatus,
      'Could not reach server. Run start-backend.bat from the easy-rewind folder.',
      'error', 8000);
  }
  if (els.startServerBtn) { els.startServerBtn.textContent = 'Start Server'; els.startServerBtn.disabled = false; }
});

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

function openSettings() {
  chrome.storage.local.get({
    easy_rewind_api_base: DEFAULT_API_BASE,
    easy_rewind_api_key: '',
    easy_rewind_ai_model: 'gemini-2.5-flash',
    easy_rewind_embed_provider: 'auto',
    easy_rewind_auto_capture: { enabled: true, minMinutes: 5, minScrollPct: 80 },
  }, result => {
    $('settings-api-url').value = result.easy_rewind_api_base || DEFAULT_API_BASE;
    $('settings-api-key').value = result.easy_rewind_api_key || '';
    $('settings-ai-model').value = result.easy_rewind_ai_model || 'gemini-2.5-flash';
    $('settings-embed-provider').value = result.easy_rewind_embed_provider || 'auto';
    const ac = result.easy_rewind_auto_capture || {};
    if ($('settings-auto-capture')) $('settings-auto-capture').checked = ac.enabled !== false;
    try {
      const base = (result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
      fetch(base + '/api/settings')
        .then(r => r.json())
        .then(s => {
          if (s.summarization_backend && $('settings-summ-backend')) $('settings-summ-backend').value = s.summarization_backend;
          if ($('settings-spaced-review')) $('settings-spaced-review').checked = !!s.spaced_review_enabled;
          if (s.review_interval_days && $('settings-review-interval')) $('settings-review-interval').value = String(s.review_interval_days);
        })
        .catch(() => {});
    } catch (_) {}
    $('settings-overlay').classList.add('open');
  });
}

function closeSettings() { $('settings-overlay').classList.remove('open'); }

function saveSettings() {
  const apiUrl = $('settings-api-url').value.trim() || DEFAULT_API_BASE;
  const apiKey = $('settings-api-key').value.trim();
  const aiModel = $('settings-ai-model').value.trim() || 'gemini-2.5-flash';
  const summBackend = $('settings-summ-backend')?.value || 'auto';
  const spacedReview = $('settings-spaced-review')?.checked || false;
  const reviewInterval = parseInt($('settings-review-interval')?.value) || 3;
  const embedProvider = $('settings-embed-provider')?.value || 'auto';
  const autoCaptureEnabled = $('settings-auto-capture')?.checked !== false;
  const autoCaptureSettings = { enabled: autoCaptureEnabled, minMinutes: 5, minScrollPct: 80 };

  chrome.storage.local.set({
    easy_rewind_api_base: apiUrl,
    easy_rewind_api_key: apiKey,
    easy_rewind_ai_model: aiModel,
    easy_rewind_embed_provider: embedProvider,
    easy_rewind_auto_capture: autoCaptureSettings,
  }, () => {
    fetch(apiUrl.replace(/\/+$/, '') + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        gemini_api_key: apiKey || null,
        ai_model: aiModel,
        api_base_url: apiUrl,
        summarization_backend: summBackend,
        spaced_review_enabled: spacedReview,
        review_interval_days: reviewInterval,
        embed_provider: embedProvider,
      }),
    }).catch(() => {});
    try { chrome.runtime.sendMessage({ type: 'AUTO_CAPTURE_SETTINGS', settings: autoCaptureSettings }); } catch (_) {}
    loadApiKeyStatus();
    showStatus(els.searchStatus, 'Settings saved!', 'success', 3000);
    closeSettings();
  });
}

$('settings-btn')?.addEventListener('click', openSettings);
$('settings-close-btn')?.addEventListener('click', closeSettings);
$('settings-save-btn')?.addEventListener('click', saveSettings);
$('settings-cancel-btn')?.addEventListener('click', closeSettings);
$('settings-overlay')?.addEventListener('click', e => { if (e.target === $('settings-overlay')) closeSettings(); });

// ─────────────────────────────────────────────
// EXPORT / IMPORT
// ─────────────────────────────────────────────

$('export-data-btn')?.addEventListener('click', async () => {
  try {
    showStatus(els.searchStatus, 'Preparing export...', 'loading');
    const data = await apiCall('/export');
    if (data.error) throw new Error(data.error);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'easy-rewind-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showStatus(els.searchStatus, 'Exported ' + (data.stats?.total || 0) + ' items', 'success', 3000);
  } catch (err) { showStatus(els.searchStatus, 'Export failed: ' + err.message, 'error', 4000); }
});

$('import-data-input')?.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.data) throw new Error('Invalid file');
    showStatus(els.searchStatus, 'Importing...', 'loading');
    const result = await apiCall('/import', { method: 'POST', body: JSON.stringify({ data: parsed.data }) });
    if (result.error) throw new Error(result.error);
    showStatus(els.searchStatus,
      'Imported ' + (result.imported?.bookmarks || 0) + ' bookmarks, ' +
      (result.imported?.notes || 0) + ' notes, ' +
      (result.imported?.highlights || 0) + ' highlights',
      'success', 4000);
  } catch (err) { showStatus(els.searchStatus, 'Import failed: ' + err.message, 'error', 5000); }
  e.target.value = '';
});

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
init();
