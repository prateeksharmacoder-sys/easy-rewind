/**
 * easy-rewind Knowledge Assistant — background.js (Service Worker)
 *
 * Handles:
 * - Extension installation & user ID generation
 * - Context menu (right-click → lookup)
 * - Tab-close reminder detection (Problem #4)
 * - Alarm-based reminder checking
 * - Desktop notifications for due reminders
 * - Quick note capture via keyboard shortcut
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const DEFAULT_API_BASE = 'http://localhost:5000';
const REMINDER_CHECK_INTERVAL = 2; // minutes

function getApiUrl(path) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ easy_rewind_api_base: DEFAULT_API_BASE }, (result) => {
      const base = result.easy_rewind_api_base || DEFAULT_API_BASE;
      resolve(base.replace(/\/+$/, '') + '/api' + path);
    });
  });
}

// ─────────────────────────────────────────────
// INSTALLATION
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const userId = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({
      easy_rewind_user_id: userId,
      easy_rewind_installed_at: new Date().toISOString(),
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
  }
});

// ─────────────────────────────────────────────
// CONTEXT MENU HANDLER
// ─────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'easy-rewind-lookup') {
    const selectedText = info.selectionText?.trim();
    if (selectedText) {
      chrome.storage.local.set({ easy_rewind_pending_lookup: selectedText });
      // Try to open the popup (MV3 limitation: can only signal, not force-open)
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
      // Get highlight context from content script, then save
      chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_TEXT' }, async (response) => {
        if (chrome.runtime.lastError || !response || response.error) {
          // Fallback: save just the selected text
          const highlightData = {
            text: info.selectionText?.trim() || '',
            url: tab.url,
            page_title: tab.title || '',
            context: '',
            color: 'yellow',
          };
          if (highlightData.text) {
            await saveHighlight(highlightData);
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
  } catch (err) {
    console.warn('[Highlight Save Error]', err.message);
  }
}

// ─────────────────────────────────────────────
// TAB-CLOSE REMINDER DETECTION (Problem #4)
// ─────────────────────────────────────────────
// We track tabs where the user has pending "remind me when I leave this tab" notes.
// When the tab closes, we show a notification.

/**
 * Track a tab for close-event reminder.
 * Called from popup.js when user saves a note with "remind on tab close"
 */
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

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get({ easy_rewind_tracked_tabs: {} }, (result) => {
    const tracked = result.easy_rewind_tracked_tabs;
    if (tracked[tabId]) {
      const note = tracked[tabId];

      // Show notification
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

      // Clean up the tracked tab
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
  // buttonIndex 0 = View Note, buttonIndex 1 = Mark Done
  if (buttonIndex === 0) {
    // Open popup to notes tab
    chrome.storage.local.set({ easy_rewind_open_tab: 'notes' });
    chrome.action.openPopup();
  }
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  // Clicking the notification body also opens popup
  chrome.storage.local.set({ easy_rewind_open_tab: 'notes' });
  chrome.action.openPopup();
  chrome.notifications.clear(notificationId);
});

// ─────────────────────────────────────────────
// ALARM: Periodic Reminder Check
// ─────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-reminders') {
    checkDueReminders();
  }
});

async function checkDueReminders() {
  try {
    const { easy_rewind_user_id: userId } = await chrome.storage.local.get('easy_rewind_user_id');
    if (!userId) return;

    const url = await getApiUrl('/reminders?due=true&limit=10');
    const response = await fetch(url, {
      headers: { 'x-user-id': userId },
    });

    if (!response.ok) return;
    const data = await response.json();

    if (data.reminders && data.reminders.length > 0) {
      for (const reminder of data.reminders) {
        chrome.notifications.create({
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

        // Acknowledge via API (don't show again on next poll)
        const ackUrl = await getApiUrl(`/reminders/${reminder.id}`);
        await fetch(ackUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ reminded: true }),
        });
      }
    }
  } catch (err) {
    console.warn('[Reminder Check Error]', err.message);
  }
}

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

  if (message.type === 'PING') {
    sendResponse({ status: 'alive' });
  }
});
