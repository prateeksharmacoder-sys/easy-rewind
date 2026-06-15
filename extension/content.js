/**
 * easy-rewind Learning Assistant — content.js
 *
 * This content script runs on every webpage and can:
 * - Read the current page's URL, title, description, and main content
 * - Respond to messages from popup.js and background.js
 * - (Future) Detect and highlight technical terms on the page
 */

// ─────────────────────────────────────────────
// MESSAGE LISTENER
// Listen for messages from popup.js and background.js
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Popup requesting current page info
  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      url: window.location.href,
      title: document.title || 'Untitled Page',
      description: getPageDescription(),
      textContent: getPageText(),
      keywords: getPageKeywords(),
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
      textContent: text.slice(0, 6000), // Limit to 6K chars for AI
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
      // Grab text around the selection from the containing block
      const block = parentEl.closest('p, li, td, div, h1, h2, h3, h4, h5, h6, blockquote, section, article') || parentEl;
      contextText = (block.textContent || '').trim().slice(0, 3000);
    }

    // If context is too short, use nearby siblings
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

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Extract the page's visible text content
 */
function getPageText() {
  // Clone body to avoid modifying the live DOM
  const clone = document.body?.cloneNode(true);
  if (!clone) return '';

  // Remove non-content elements
  const removals = clone.querySelectorAll('script, style, nav, footer, header, iframe, ' +
    'svg, noscript, [role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '.sidebar, .nav, .footer, .header, .menu, .ad, .advertisement');
  removals.forEach(el => el.remove());

  // Get visible text
  const text = clone.textContent || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

/**
 * Get page meta description
 */
function getPageDescription() {
  const metaDesc = document.querySelector('meta[name="description"]')?.content;
  if (metaDesc) return metaDesc.slice(0, 200);

  const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
  if (ogDesc) return ogDesc.slice(0, 200);

  const firstP = document.querySelector('p');
  if (firstP) return firstP.textContent?.trim().slice(0, 200);

  return '';
}

/**
 * Get page keywords
 */
function getPageKeywords() {
  const metaKeywords = document.querySelector('meta[name="keywords"]')?.content;
  if (metaKeywords) return metaKeywords.slice(0, 300);
  return '';
}

// Content script ready
console.log('[easy-rewind] Content script loaded on:', window.location.hostname);
