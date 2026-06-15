/**
 * easy-rewind Learning Assistant — content.js
 *
 * Runs on every webpage:
 * - Reads page info for popup/background
 * - Tracks engagement for Smart Auto-Capture
 * - Responds to messages from popup.js and background.js
 */

// ═══════════════════════════════════════════════
// ENGAGEMENT TRACKING (Smart Auto-Capture)
// ═══════════════════════════════════════════════

const EngagementTracker = (() => {
  const state = {
    startTime: Date.now(),
    maxScrollDepth: 0,
    scrollEvents: 0,
    lastScrollTime: 0,
    totalScrollDuration: 0,     // ms spent actively scrolling
    visibleTime: 0,             // ms page was in foreground
    lastVisibleCheck: Date.now(),
    clicks: 0,
    selections: 0,
    keypresses: 0,
    isVisible: !document.hidden,
    heartbeatInterval: null,
    wasEngaged: false,          // true once threshold has been crossed
    scrollTimer: null,
    isScrolling: false,
    scrollStartTime: 0,
    sourceType: null,           // detected on init
  };

  const SETTINGS_KEY = 'easy_rewind_auto_capture';
  const HEARTBEAT_MS = 15000;    // send engagement update every 15s
  const FLUSH_MS = 2000;         // delay flush after scroll stops

  // ── Settings (loaded from chrome.storage, with defaults) ──
  let settings = {
    enabled: true,
    minMinutes: 5,              // minimum minutes of visible time
    minScrollPct: 80,           // minimum scroll depth percentage
    promptOnThreshold: true,    // show notification when threshold is crossed
  };

  // ── Source type detection ──
  function detectSourceType() {
    const url = window.location.href.toLowerCase();

    // Explicit URL-based detection
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('github.com')) return 'github';

    // Content-based detection
    const hasVideo = document.querySelector('video, [data-youtube-video]');
    if (hasVideo && (url.includes('watch') || url.includes('/video/') || url.includes('/tv/'))) return 'youtube';

    // Check for article/blog markers
    const hasArticle = document.querySelector('article');
    const hasBlogMeta = document.querySelector('[property="article:published_time"], meta[name="blog"]');
    const hasAuthor = document.querySelector('[rel="author"], .author, .byline');
    const hasPostClass = document.querySelector('[class*="post"], [class*="article"], [id*="post-"]');
    if (hasArticle || hasBlogMeta || (hasAuthor && hasPostClass)) return 'blog';

    // Documentation markers
    const hasDocsMeta = document.querySelector('[class*="doc"], [class*="tutorial"], [class*="guide"], [id*="doc-"]');
    const hasCodeBlock = document.querySelector('pre code, pre.chroma');
    const urlHasDocs = url.includes('docs.') || url.includes('learn.') || url.includes('wiki.');
    if (urlHasDocs || (hasDocsMeta && hasCodeBlock)) return 'docs';

    // News markers
    const hasNewsMeta = document.querySelector('[property="article:section"], meta[name="news_keywords"]');
    const urlIsNews = url.includes('news.') || url.includes('/news/');
    if (urlIsNews || hasNewsMeta) return 'news';

    // GitHub (content-based fallback)
    const hasRepoMeta = document.querySelector('[class*="repository"], [class*="repo"]');
    if (hasRepoMeta && window.location.hostname === 'github.com') return 'github';

    return 'web';
  }

  // ── Get adaptive engagement weights based on content type ──
  function getEngagementWeights() {
    const type = state.sourceType || 'web';
    const weights = {
      //           time  scroll  click  select  key  visible
      youtube: [0.50, 0.10, 0.10, 0.05, 0.05, 0.20],  // watch time dominant
      github:  [0.40, 0.15, 0.10, 0.10, 0.10, 0.15],  // time + selections
      blog:    [0.30, 0.35, 0.10, 0.10, 0.05, 0.10],  // scroll depth matters most
      docs:    [0.25, 0.30, 0.10, 0.20, 0.05, 0.10],  // selections + scroll
      news:    [0.35, 0.30, 0.10, 0.05, 0.05, 0.15],  // scroll + time
      web:     [0.35, 0.30, 0.10, 0.10, 0.05, 0.10],  // balanced default
    };
    return weights[type] || weights.web;
  }

  // ── Get adaptive thresholds based on content type ──
  function getAdaptiveThresholds() {
    const type = state.sourceType || 'web';
    const thresholds = {
      youtube: { minMinutes: 3, minScrollPct: 50, scoreThreshold: 60 },   // shorter watch, less scrolling
      github:  { minMinutes: 4, minScrollPct: 60, scoreThreshold: 60 },   // browsing repos
      blog:    { minMinutes: 5, minScrollPct: 80, scoreThreshold: 65 },   // full read
      docs:    { minMinutes: 4, minScrollPct: 70, scoreThreshold: 60 },   // reference reading
      news:    { minMinutes: 3, minScrollPct: 60, scoreThreshold: 55 },   // quick scan
      web:     { minMinutes: 5, minScrollPct: 80, scoreThreshold: 65 },   // default
    };
    return thresholds[type] || thresholds.web;
  }

  // ── Scroll tracking ──
  function onScroll() {
    const now = Date.now();
    state.scrollEvents++;

    // Calculate scroll depth
    const scrollTop = window.scrollY;
    const docHeight = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.clientHeight,
      document.documentElement.scrollHeight
    );
    const winHeight = window.innerHeight;
    const maxScroll = docHeight - winHeight;
    const depth = maxScroll > 0 ? Math.round((scrollTop / maxScroll) * 100) : 100;
    state.maxScrollDepth = Math.max(state.maxScrollDepth, depth);

    // Track active scrolling duration (user is actively scrolling)
    if (!state.isScrolling) {
      state.isScrolling = true;
      state.scrollStartTime = now;
    }
    state.lastScrollTime = now;

    // Debounce: after 2s of no scroll, accumulate duration
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => {
      if (state.isScrolling) {
        state.totalScrollDuration += now - state.scrollStartTime;
        state.isScrolling = false;
      }
    }, FLUSH_MS);
  }

  // ── Click tracking ──
  function onClick() {
    state.clicks++;
  }

  // ── Selection tracking ──
  function onSelection() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 3) {
      state.selections++;
    }
  }

  // ── Keypress tracking ──
  function onKeypress() {
    state.keypresses++;
  }

  // ── Visibility tracking ──
  function onVisibilityChange() {
    const now = Date.now();
    if (document.hidden) {
      // Page went hidden — accumulate visible time
      state.visibleTime += now - state.lastVisibleCheck;
      state.isVisible = false;
      // Flush engagement data immediately so background.js has latest
      flushEngagement();
    } else {
      state.lastVisibleCheck = now;
      state.isVisible = true;
    }
  }

  // ── Load settings from chrome.storage ──
  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        if (result[SETTINGS_KEY]) {
          settings = { ...settings, ...result[SETTINGS_KEY] };
        }
      });
    } catch (_) {
      // chrome.storage may not be available in some contexts
    }
  }

  // ── Compute current engagement score (0-100) with adaptive weights ──
  function getEngagementScore() {
    const now = Date.now();
    const elapsedMs = now - state.startTime;
    const elapsedMin = elapsedMs / 60000;

    // Get adaptive thresholds for this content type
    const adaptive = getAdaptiveThresholds();
    const weights = getEngagementWeights();

    // Visible time ratio (how much of elapsed time was page visible)
    const visibleRatio = elapsedMin > 0
      ? Math.min(1, (state.visibleTime + (state.isVisible ? (now - state.lastVisibleCheck) : 0)) / elapsedMs)
      : 0;

    // Scores for each dimension (0-1) — uses adaptive minMinutes/minScrollPct
    const timeScore    = Math.min(1, elapsedMin / (adaptive.minMinutes || settings.minMinutes));
    const scrollScore  = Math.min(1, state.maxScrollDepth / (adaptive.minScrollPct || settings.minScrollPct));
    const clickScore   = Math.min(1, state.clicks / 5);
    const selectScore  = Math.min(1, state.selections / 3);
    const keyScore     = Math.min(1, state.keypresses / 20);

    // Adaptive weighted composite
    const composite = (weights[0] * timeScore) + (weights[1] * scrollScore) + (weights[2] * clickScore)
                    + (weights[3] * selectScore) + (weights[4] * keyScore) + (weights[5] * visibleRatio);

    return {
      score: Math.round(composite * 100),
      elapsed_min: Math.round(elapsedMin * 10) / 10,
      max_scroll_depth: state.maxScrollDepth,
      clicks: state.clicks,
      selections: state.selections,
      visible_ratio: Math.round(visibleRatio * 100),
      source_type: state.sourceType || 'web',
    };
  }

  // ── Flush engagement data to background.js ──
  function flushEngagement() {
    try {
      const data = getEngagementScore();
      chrome.runtime.sendMessage({
        type: 'ENGAGEMENT_UPDATE',
        tabId: null, // background.js will infer from sender
        engagement: data,
        url: window.location.href,
        title: document.title || 'Untitled Page',
      }, () => {
        // Ignore errors (background might be starting up)
        if (chrome.runtime.lastError) { /* silent */ }
      });
    } catch (_) {
      // Background might not be ready
    }
  }

  // ── Heartbeat: periodically send engagement data ──
  function startHeartbeat() {
    if (state.heartbeatInterval) return;
    state.heartbeatInterval = setInterval(() => {
      if (state.isVisible) {
        const now = Date.now();
        state.visibleTime += now - state.lastVisibleCheck;
        state.lastVisibleCheck = now;
      }
      flushEngagement();
    }, HEARTBEAT_MS);
  }

  // ── Public init ──
  function init() {
    // Detect source type once on page load
    state.sourceType = detectSourceType();

    loadSettings();
    if (!settings.enabled) return;

    // Attach event listeners
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick);
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('keydown', onKeypress);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Flush on beforeunload
    window.addEventListener('beforeunload', () => {
      if (state.isVisible) {
        state.visibleTime += Date.now() - state.lastVisibleCheck;
      }
      flushEngagement();
    });

    startHeartbeat();

    // Log detected type for debugging
    console.log(`[easy-rewind] Tracking ${state.sourceType} page:`, window.location.hostname);
  }

  return { init, getEngagementScore, flushEngagement, detectSourceType, settings };
})();

// ═══════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Popup requesting current page info
  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      url: window.location.href,
      title: document.title || 'Untitled Page',
      description: getPageDescription(),
      textContent: getPageText(),
      keywords: getPageKeywords(),
      engagement: EngagementTracker.getEngagementScore(),
      source_type: EngagementTracker.detectSourceType(),
    });
    return true;
  }

  // Popup requesting AI summarization of this page
  if (message.type === 'SUMMARY_PAGE') {
    const text = getPageText();
    const title = document.title || 'Untitled Page';
    const description = getPageDescription();
    sendResponse({
      title,
      url: window.location.href,
      description,
      textContent: text.slice(0, 6000),
    });
    return true;
  }

  // Popup requesting highlighted text + context
  if (message.type === 'HIGHLIGHT_TEXT') {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      sendResponse({ error: 'No text selected' });
      return true;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      sendResponse({ error: 'No text selected' });
      return true;
    }

    // Get surrounding context from the parent node
    let contextText = '';
    const range = selection.getRangeAt(0);
    const parentNode = range.commonAncestorContainer;
    const parentEl = parentNode.nodeType === 3 ? parentNode.parentElement : parentNode;
    if (parentEl) {
      const block = parentEl.closest('p, li, td, div, h1, h2, h3, h4, h5, h6, blockquote, section, article') || parentEl;
      contextText = (block.textContent || '').trim().slice(0, 3000);
    }

    if (contextText.length < selectedText.length + 40) {
      contextText = getPageText().slice(0, 3000);
    }

    sendResponse({
      selectedText,
      context: contextText,
      url: window.location.href,
      pageTitle: document.title || 'Untitled Page',
    });
    return true;
  }

  // Ping check
  if (message.type === 'PING') {
    sendResponse({ status: 'alive', url: window.location.href });
    return true;
  }
});

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

function getPageText() {
  const clone = document.body?.cloneNode(true);
  if (!clone) return '';
  const removals = clone.querySelectorAll('script, style, nav, footer, header, iframe, ' +
    'svg, noscript, [role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '.sidebar, .nav, .footer, .header, .menu, .ad, .advertisement');
  removals.forEach(el => el.remove());
  const text = clone.textContent || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

function getPageDescription() {
  const metaDesc = document.querySelector('meta[name="description"]')?.content;
  if (metaDesc) return metaDesc.slice(0, 200);
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
  if (ogDesc) return ogDesc.slice(0, 200);
  const firstP = document.querySelector('p');
  if (firstP) return firstP.textContent?.trim().slice(0, 200);
  return '';
}

function getPageKeywords() {
  const metaKeywords = document.querySelector('meta[name="keywords"]')?.content;
  if (metaKeywords) return metaKeywords.slice(0, 300);
  return '';
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════

EngagementTracker.init();
console.log('[easy-rewind] Content script loaded on:', window.location.hostname);
