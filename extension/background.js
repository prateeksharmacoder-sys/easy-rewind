/**
 * easy-rewind Knowledge Assistant — background.js (Service Worker)
 *
 * Handles:
 * - Extension installation & user ID generation
 * - Context menu (right-click → lookup)
 * - Tab-close reminder detection
 * - Alarm-based reminder checking
 * - Desktop notifications for due reminders
 * - Quick note capture via keyboard shortcut
 * - Smart Auto-Capture engagement tracking
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const DEFAULT_API_BASE = 'http://localhost:5000';
const REMINDER_CHECK_INTERVAL = 2; // minutes

// In-memory store of prompted tab IDs to avoid re-notification after
// service-worker restart. On start we first check chrome.storage.session
// for surviving engagement state.
let promptedTabs = new Set();
let suppressedTabs = new Set();

function getApiUrl(path) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, (result) => {
      const base = result.easy_rewind_api_base || DEFAULT_API_BASE;
      resolve(base.replace(/\/+$/, '') + '/api' + path);
    });
  });
}

// ─────────────────────────────────────────────
// SERVER HEALTH BADGE
// ─────────────────────────────────────────────

async function updateServerBadge() {
  try {
    const { easy_rewind_api_base } = await chrome.storage.local.get('easy_rewind_api_base');
    const base = (easy_rewind_api_base || 'http://localhost:5000').replace(/\/+$/, '');
    const response = await fetch(`${base}/api/health`);
    if (response.ok) {
      await chrome.action.setBadgeText({ text: '' });
    } else {
      throw new Error('Unhealthy');
    }
  } catch {
    await chrome.action.setBadgeText({ text: '!!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// ─────────────────────────────────────────────
// SYNC TRACKER
// ─────────────────────────────────────────────

async function updateLastSyncTime() {
  try {
    const now = new Date().toISOString();
    await chrome.storage.local.set({ easy_rewind_last_sync: now });
  } catch (_) {}
}

async function syncItems() {
  try {
    const { easy_rewind_last_sync, easy_rewind_user_id, easy_rewind_api_base } =
      await chrome.storage.local.get(['easy_rewind_last_sync', 'easy_rewind_user_id', 'easy_rewind_api_base']);
    if (!easy_rewind_user_id) return;

    const base = (easy_rewind_api_base || 'http://localhost:5000').replace(/\/+$/, '');
    const since = easy_rewind_last_sync ? `?since=${encodeURIComponent(easy_rewind_last_sync)}` : '?limit=10';
    const url = `${base}/api/items${since}`;

    const response = await fetch(url, {
      headers: { 'x-user-id': easy_rewind_user_id },
    });
    if (!response.ok) return;
    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const lastCount = (await chrome.storage.local.get('easy_rewind_new_items')).easy_rewind_new_items || 0;
      await chrome.storage.local.set({ easy_rewind_new_items: lastCount + data.items.length });
      updateLastSyncTime();
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// SMART AUTO-CAPTURE — Engagement Tracking
// ─────────────────────────────────────────────

/**
 * Per-tab engagement state kept in memory.
 * Survives service-worker restarts poorly, but
 * content.js re-sends heartbeats every 15s, so
 * state is re-established quickly.
 */
const engagementState = new Map(); // tabId → { engagement, lastHeartbeat, prompted, suppressed }

// Engagement thresholds (can be overridden via chrome.storage)
let autoCaptureSettings = {
  enabled: true,
  minMinutes: 5,
  minScrollPct: 80,
  scoreThreshold: 65,          // composite score 0-100
  promptDelayMs: 120000,       // wait 2 min after threshold before prompting (anti-flash)
};

// Load auto-capture settings
async function loadAutoCaptureSettings() {
  try {
    const result = await chrome.storage.local.get('easy_rewind_auto_capture');
    if (result.easy_rewind_auto_capture) {
      autoCaptureSettings = { ...autoCaptureSettings, ...result.easy_rewind_auto_capture };
    }
  } catch (_) {}
}

// Persist prompted/suppressed state across service-worker restarts
async function persistEngagementState() {
  try {
    await chrome.storage.session.set({
      easy_rewind_prompted_tabs: [...promptedTabs],
      easy_rewind_suppressed_tabs: [...suppressedTabs],
    });
  } catch (_) {}
}

async function restoreEngagementState() {
  try {
    const result = await chrome.storage.session.get(['easy_rewind_prompted_tabs', 'easy_rewind_suppressed_tabs']);
    if (result.easy_rewind_prompted_tabs) promptedTabs = new Set(result.easy_rewind_prompted_tabs);
    if (result.easy_rewind_suppressed_tabs) suppressedTabs = new Set(result.easy_rewind_suppressed_tabs);
  } catch (_) {}
}

// Handle engagement heartbeats from content scripts
function handleEngagementUpdate(tabId, data) {
  if (!autoCaptureSettings.enabled) return;

  const now = Date.now();
  const existing = engagementState.get(tabId) || { prompted: false, suppressed: false, notified: false, lastHeartbeat: 0 };
  existing.lastHeartbeat = now;
  existing.engagement = data;
  engagementState.set(tabId, existing);

  // Don't re-prompt or re-notify if already done (checks both in-memory and persisted set)
  if (existing.prompted || existing.suppressed || promptedTabs.has(tabId) || suppressedTabs.has(tabId)) return;

  // Check threshold
  // If promptDelayMs is set, only prompt after the user has been engaged for at least that long
  // past the threshold crossing
  if (data.score >= autoCaptureSettings.scoreThreshold && data.elapsed_min >= autoCaptureSettings.minMinutes) {
    existing.prompted = true;
    existing.promptedAt = now;
    engagementState.set(tabId, existing);
    promptedTabs.add(tabId);
    persistEngagementState();
    fireAutoCapturePrompt(tabId, data);
  }
}

// Fire a notification when engagement threshold is crossed
async function fireAutoCapturePrompt(tabId, engagement) {
  try {
    // Get tab info
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;

    // Don't prompt on certain URLs
    const skipDomains = ['chrome://', 'chrome-extension://', 'about:', 'file://', 'localhost', '127.0.0.1'];
    if (skipDomains.some(p => tab.url?.startsWith(p))) return;

    // Store the pending save data so popup can pick it up
    const pendingData = {
      url: tab.url || '',
      title: tab.title || 'Untitled Page',
      engagement: engagement,
      triggered_at: new Date().toISOString(),
    };

    await chrome.storage.local.set({
      easy_rewind_pending_auto_save: pendingData,
    });

    // Create the notification
    const minutes = Math.round(engagement.elapsed_min);
    const depth = engagement.max_scroll_depth;
    const notifId = `auto-capture-${tabId}-${Date.now()}`;

    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🧠 Save this to memory?',
      message: `You spent ${minutes} min reading "${tab.title?.slice(0, 60) || 'this page'}" — scrolled ${depth}%.`,
      priority: 2,
      buttons: [
        { title: '💾 Save to Memory' },
        { title: '✕ Not Now' },
      ],
      requireInteraction: true,
      contextMessage: 'easy-rewind auto-capture',
    });

    console.log(`[Auto-Capture] Prompt for tab ${tabId}: "${tab.title}" (${minutes}min, ${depth}% scroll)`);
  } catch (err) {
    console.warn('[Auto-Capture] Failed to prompt:', err.message);
  }
}

// Handle notification button clicks for auto-capture
async function handleAutoCaptureNotification(notificationId, buttonIndex) {
  // notificationId format: auto-capture-{tabId}-{timestamp}
  const parts = notificationId.split('-');
  if (parts.length < 3 || parts[0] !== 'auto' || parts[1] !== 'capture') return false;

  const tabId = parseInt(parts[2]);
  const state = engagementState.get(tabId);

  if (buttonIndex === 0) {
    // 💾 Save to Memory
    // Open popup — it will read easy_rewind_pending_auto_save and auto-save
    await chrome.storage.local.set({ easy_rewind_open_tab: 'save' });
    chrome.action.openPopup();
  } else if (buttonIndex === 1) {
    // ✕ Not Now — suppress further prompts for this tab
    if (state) {
      state.suppressed = true;
      engagementState.set(tabId, state);
    }
    suppressedTabs.add(tabId);
    persistEngagementState();
    // Also clear the pending data
    await chrome.storage.local.remove('easy_rewind_pending_auto_save');
  }

  return true; // handled
}

// Check engagement states periodically for cleanup (stale tabs)
function cleanEngagementState() {
  const staleCutoff = Date.now() - 30 * 60 * 1000; // 30 min
  for (const [tabId, state] of engagementState.entries()) {
    if (state.lastHeartbeat < staleCutoff) {
      engagementState.delete(tabId);
    }
  }
}

// ─────────────────────────────────────────────
// INSTALLATION
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const clientId = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({
      easy_rewind_user_id: clientId,
      easy_rewind_installed_at: new Date().toISOString(),
    });
    // Try to get a canonical shared user ID from the server
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, (result) => {
      const base = (result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
      fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_type: 'extension' }),
      }).then(r => r.json()).then(session => {
        if (session.user_id && session.user_id !== clientId) {
          chrome.storage.local.set({ easy_rewind_user_id: session.user_id });
        }
      }).catch(() => {});
    });
  }

  if (details.reason === 'install' || details.reason === 'update') {
    // Create context menu
    chrome.contextMenus.create({
      id: 'easy-rewind-lookup',
      title: '🔍 Look up "%s" in easy-rewind',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: 'easy-rewind-save-note',
      title: '📝 Save selection as quick note',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: 'easy-rewind-bookmark-page',
      title: '🔖 Bookmark this page in easy-rewind',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'easy-rewind-highlight',
      title: '🖍 Save highlight to easy-rewind',
      contexts: ['selection'],
    });

    // Set up periodic reminder check
    chrome.alarms.create('check-reminders', {
      periodInMinutes: REMINDER_CHECK_INTERVAL,
    });

    // Set up server health check badge
    chrome.alarms.create('check-server-health', {
      periodInMinutes: 2,
    });
  }

  // Load auto-capture settings on install/update
  await loadAutoCaptureSettings();
});

// ─────────────────────────────────────────────
// CONTEXT MENU HANDLER
// ─────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'easy-rewind-lookup') {
    const selectedText = info.selectionText?.trim();
    if (selectedText) {
      chrome.storage.local.set({ easy_rewind_pending_lookup: selectedText });
      chrome.action.openPopup();
    }
  }

  if (info.menuItemId === 'easy-rewind-save-note') {
    const selectedText = info.selectionText?.trim();
    if (selectedText && tab) {
      chrome.storage.local.set({
        easy_rewind_pending_note: {
          content: selectedText,
          source_url: tab.url,
          source_title: tab.title,
        }
      });
      chrome.action.openPopup();
    }
  }

  if (info.menuItemId === 'easy-rewind-bookmark-page') {
    if (tab) {
      chrome.storage.local.set({
        easy_rewind_pending_bookmark: {
          url: tab.url,
          title: tab.title,
        }
      });
      chrome.action.openPopup();
    }
  }

  if (info.menuItemId === 'easy-rewind-highlight') {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_TEXT' }, async (response) => {
        if (chrome.runtime.lastError || !response || response.error) {
          const highlightData = {
            text: info.selectionText?.trim() || '',
            url: tab.url,
            page_title: tab.title || '',
            context: '',
            color: 'yellow',
          };
          if (highlightData.text) {
            await saveHighlight(highlightData);
            await updateLastSyncTime();
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: '🖍 Highlight Saved',
              message: `"${highlightData.text.slice(0, 80)}..."`,
              priority: 1,
            });
          }
        } else {
          await saveHighlight({
            text: response.selectedText || info.selectionText?.trim() || '',
            url: response.url || tab.url,
            page_title: response.pageTitle || tab.title || '',
            context: response.context || '',
            color: 'yellow',
          });
          await updateLastSyncTime();
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: '🖍 Highlight Saved',
            message: `"${(response.selectedText || '').slice(0, 80)}..."`,
            priority: 1,
          });
        }
      });
    }
  }
});

async function saveHighlight(highlightData) {
  try {
    const { easy_rewind_user_id: userId, easy_rewind_api_base: apiBase } =
      await chrome.storage.local.get(['easy_rewind_user_id', 'easy_rewind_api_base']);
    const base = (apiBase || 'http://localhost:5000').replace(/\/+$/, '');
    await fetch(`${base}/api/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId || 'anonymous' },
      body: JSON.stringify(highlightData),
    });
    await updateLastSyncTime();
  } catch (err) {
    console.warn('[Highlight Save Error]', err.message);
  }
}

// ─────────────────────────────────────────────
// TAB-CLOSE REMINDER DETECTION (Problem #4)
// ─────────────────────────────────────────────

function trackTabForReminder(tabId, noteData) {
  chrome.storage.local.get({ easy_rewind_tracked_tabs: {} }, (result) => {
    const tracked = result.easy_rewind_tracked_tabs;
    tracked[tabId] = {
      noteId: noteData.id || 'pending',
      content: noteData.content,
      source_title: noteData.source_title || 'current page',
      saved_at: new Date().toISOString(),
    };
    chrome.storage.local.set({ easy_rewind_tracked_tabs: tracked });
    console.log(`[Tab Tracker] Tracking tab ${tabId} for close reminder`);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  // Clean up engagement state for closed tabs
  engagementState.delete(tabId);
  promptedTabs.delete(tabId);
  suppressedTabs.delete(tabId);
  persistEngagementState();

  // Check tab-close reminders
  chrome.storage.local.get({ easy_rewind_tracked_tabs: {} }, (result) => {
    const tracked = result.easy_rewind_tracked_tabs;
    if (tracked[tabId]) {
      const note = tracked[tabId];

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '⏰ You left this tab!',
        message: `"${note.content.slice(0, 100)}" — tap to view your note`,
        priority: 2,
        buttons: [
          { title: '📋 View Note' },
          { title: '✓ Mark Done' },
        ],
        requireInteraction: true,
      });

      delete tracked[tabId];
      chrome.storage.local.set({ easy_rewind_tracked_tabs: tracked });
      console.log(`[Tab Tracker] Tab ${tabId} closed, reminder fired`);
    }
  });
});

// ─────────────────────────────────────────────
// NOTIFICATION BUTTON HANDLER
// ─────────────────────────────────────────────
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  // Check if this is an auto-capture notification first
  if (notificationId.startsWith('auto-capture-')) {
    handleAutoCaptureNotification(notificationId, buttonIndex);
    chrome.notifications.clear(notificationId);
    return;
  }

  // Reminder notification (prefix: reminder-)
  if (notificationId.startsWith('reminder-')) {
    const parts = notificationId.split('-');
    const reminderId = parseInt(parts[1]);
    if (buttonIndex === 0) {
      // ✓ Mark Done — dismiss the reminder
      if (reminderId) {
        chrome.storage.local.get({ easy_rewind_user_id: '' }, (result) => {
          getApiUrl(`/reminders/${reminderId}`).then(url => {
            fetch(url, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'x-user-id': result.easy_rewind_user_id || 'anonymous' },
              body: JSON.stringify({ dismissed: true }),
            }).catch(() => {});
          });
        });
      }
    } else if (buttonIndex === 1) {
      // ⏱ Snooze 5 min — reschedule
      if (reminderId) {
        const snoozeTime = new Date(Date.now() + 5 * 60000).toISOString();
        chrome.storage.local.get({ easy_rewind_user_id: '' }, (result) => {
          getApiUrl(`/reminders/${reminderId}`).then(url => {
            fetch(url, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'x-user-id': result.easy_rewind_user_id || 'anonymous' },
              body: JSON.stringify({ reminded: false, remind_at: snoozeTime }),
            }).catch(() => {});
          });
        });
      }
    }
    chrome.notifications.clear(notificationId);
    return;
  }

  // Default notification handling (legacy)
  if (buttonIndex === 0) {
    chrome.storage.local.set({ easy_rewind_open_tab: 'notes' });
    chrome.action.openPopup();
  }
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  // For auto-capture notifications, clicking body = save
  if (notificationId.startsWith('auto-capture-')) {
    const parts = notificationId.split('-');
    if (parts.length >= 3) {
      chrome.storage.local.set({ easy_rewind_open_tab: 'save' });
      chrome.action.openPopup();
    }
  } else if (notificationId.startsWith('reminder-')) {
    // Clicking a reminder notification body — open popup to notes tab
    chrome.storage.local.set({ easy_rewind_open_tab: 'notes' });
    chrome.action.openPopup();
  } else {
    chrome.storage.local.set({ easy_rewind_open_tab: 'notes' });
    chrome.action.openPopup();
  }
  chrome.notifications.clear(notificationId);
});

// ─────────────────────────────────────────────
// ALARM: Periodic Reminder Check
// ─────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-reminders') {
    checkDueReminders();
  }
  if (alarm.name === 'cleanup-engagement') {
    cleanEngagementState();
  }
  if (alarm.name === 'check-server-health') {
    updateServerBadge();
  }
});

async function checkDueReminders() {
  try {
    const { easy_rewind_user_id: userId } = await chrome.storage.local.get('easy_rewind_user_id');
    if (!userId) { console.log('[Reminder Check] No userId in storage'); return; }

    const url = await getApiUrl('/reminders?due=true&limit=10');
    const response = await fetch(url, {
      headers: { 'x-user-id': userId },
    });

    if (!response.ok) { console.log('[Reminder Check] API returned', response.status); return; }
    const data = await response.json();

    if (data.reminders && data.reminders.length > 0) {
      console.log('[Reminder Check] Firing', data.reminders.length, 'notification(s)');
      for (const reminder of data.reminders) {
        const notifId = `reminder-${reminder.id}-${Date.now()}`;
        chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: reminder.title || '⏰ Reminder',
          message: reminder.message || 'You have a pending reminder.',
          priority: 2,
          buttons: [
            { title: '✓ Mark Done' },
            { title: '⏱ Snooze 5 min' },
          ],
          requireInteraction: true,
          contextMessage: reminder.reminder_type?.replace('_', ' ') || 'easy-rewind',
        });

        const ackUrl = await getApiUrl(`/reminders/${reminder.id}`);
        await fetch(ackUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ reminded: true }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Reminder Check Error]', err.message);
  }
}

// ─────────────────────────────────────────────
// OMNIBOX: Type "er <query>" in address bar to search
// ─────────────────────────────────────────────

chrome.omnibox.onInputEntered.addListener(async (query) => {
  if (!query || query.trim().length === 0) return;

  chrome.storage.local.set({ easy_rewind_pending_lookup: query.trim() });

  try {
    chrome.action.openPopup();
  } catch (_) {}

  try {
    const { easy_rewind_user_id } = await chrome.storage.local.get('easy_rewind_user_id');
    const searchUrl = await getApiUrl(`/items/search?q=${encodeURIComponent(query.trim())}`);
    await fetch(searchUrl, {
      headers: { 'x-user-id': easy_rewind_user_id || 'anonymous' },
    });
  } catch (_) {}
});

chrome.omnibox.onInputChanged.addListener((query, suggest) => {
  if (!query || query.trim().length < 2) return suggest([]);

  chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE, easy_rewind_user_id: 'anonymous' }, async (result) => {
    const base = (result.easy_rewind_api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
    try {
      const response = await fetch(`${base}/api/items/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { 'x-user-id': result.easy_rewind_user_id },
      });
      if (!response.ok) return suggest([]);
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const suggestions = data.results.slice(0, 5).map(item => ({
          content: item.title || 'Saved item',
          description: `${item.title || 'Untitled'} — ${item.summary ? item.summary.slice(0, 80) : 'No summary'}`,
        }));
        suggest(suggestions);
      }
    } catch (_) {
      suggest([]);
    }
  });
});

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUT: Quick Capture Note
// ─────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-capture-note') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      chrome.storage.local.set({
        easy_rewind_pending_note: {
          content: '',
          source_url: tab?.url || '',
          source_title: tab?.title || '',
        },
        easy_rewind_open_tab: 'notes',
      });
      chrome.action.openPopup();
    });
  }
});

// ─────────────────────────────────────────────
// MESSAGE HANDLING
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ═══ Smart Auto-Capture: engagement heartbeat ═══
  if (message.type === 'ENGAGEMENT_UPDATE') {
    const tabId = sender.tab?.id || message.tabId;
    if (tabId && message.engagement) {
      handleEngagementUpdate(tabId, message.engagement);
    }
    sendResponse({ received: true });
    return true;
  }

  // ═══ Auto-capture settings update from popup ═══
  if (message.type === 'AUTO_CAPTURE_SETTINGS') {
    if (message.settings) {
      autoCaptureSettings = { ...autoCaptureSettings, ...message.settings };
      chrome.storage.local.set({ easy_rewind_auto_capture: autoCaptureSettings });
    }
    sendResponse({ updated: true });
    return true;
  }

  if (message.type === 'GET_USER_ID') {
    chrome.storage.local.get(['easy_rewind_user_id'], (result) => {
      sendResponse({ userId: result.easy_rewind_user_id || null });
    });
    return true;
  }

  if (message.type === 'TRACK_TAB_REMINDER') {
    trackTabForReminder(sender.tab?.id, message.noteData);
    sendResponse({ tracked: true });
    return true;
  }

  if (message.type === 'REFRESH_SERVER_BADGE') {
    updateServerBadge();
    sendResponse({ updated: true });
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ status: 'alive' });
  }

  if (message.type === 'CHECK_DUE_REMINDERS') {
    checkDueReminders();
    sendResponse({ checked: true });
    return true;
  }
});

// ─────────────────────────────────────────────
// INIT: load settings on startup
// ─────────────────────────────────────────────
loadAutoCaptureSettings();
restoreEngagementState();

// Check server health on background start and set badge
updateServerBadge();

// Ensure periodic alarms are registered (also created in onInstalled,
// but this covers service-worker restart edge cases)
chrome.alarms.create('check-reminders', { periodInMinutes: REMINDER_CHECK_INTERVAL });
chrome.alarms.create('check-server-health', { periodInMinutes: 2 });
chrome.alarms.create('cleanup-engagement', {
  periodInMinutes: 15,
});
