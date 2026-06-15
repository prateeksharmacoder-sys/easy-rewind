/**
 * full-check.js — Comprehensive system health check for easy-rewind
 */
const fs = require('fs');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkAll() {
  await sleep(1500);

  const base = 'http://localhost:5000/api';
  const headers = { 'Content-Type': 'application/json', 'x-user-id': 'healthcheck_user' };
  let allOk = true;

  function log(label, ok, detail) {
    const icon = ok ? '✅' : '❌';
    console.log(icon + ' ' + label.padEnd(30) + ' ' + detail);
    if (!ok) allOk = false;
  }

  console.log('\n══════════════════════════════════════');
  console.log('   easy-rewind — Full System Check   ');
  console.log('══════════════════════════════════════\n');

  // 1. SERVER HEALTH
  try {
    const r = await fetch(base + '/health');
    const d = await r.json();
    log('Server running', d.status === 'ok', 'http://localhost:5000');
    log('SQLite connected', d.storage_ready, d.storage_ready ? 'DB ready at backend/data/' : 'DB issue');
    log('AI key configured', d.ai_configured, d.ai_configured ? 'Ready' : 'Not set (mock mode)');
  } catch (e) {
    log('Server running', false, 'Cannot reach localhost:5000');
    console.log('\nServer is down. Cannot continue tests.');
    return;
  }

  // 2. QUICK LOOKUP
  try {
    const r = await fetch(base + '/quick-lookup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ term: 'Docker' }),
    });
    const d = await r.json();
    log(
      'Quick lookup',
      !!d.definition,
      d.definition ? '[' + d.source + '] ' + d.definition.slice(0, 55) + '...' : d.error
    );
  } catch (e) {
    log('Quick lookup', false, e.message);
  }

  // 3. CACHE CHECK (same term = should be cached now)
  try {
    const r = await fetch(base + '/quick-lookup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ term: 'Docker' }),
    });
    const d = await r.json();
    log('Cache working', d.source === 'cache' || d.source === 'mock', 'Source: ' + d.source);
  } catch (e) {
    log('Cache working', false, e.message);
  }

  // 4. SAVE BOOKMARK
  let savedId = null;
  try {
    const r = await fetch(base + '/bookmark', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://nodejs.org',
        title: 'Node.js Docs',
        topic: 'Node.js',
        notes: 'Health check',
      }),
    });
    const d = await r.json();
    savedId = d.bookmark?.id;
    log('Bookmark save', d.success, d.success ? 'id=' + savedId + ' saved to Supabase' : d.error);
  } catch (e) {
    log('Bookmark save', false, e.message);
  }

  // 5. GET ALL BOOKMARKS
  try {
    const r = await fetch(base + '/bookmarks', { headers });
    const d = await r.json();
    log(
      'Get all bookmarks',
      Array.isArray(d.bookmarks),
      d.bookmarks?.length + ' bookmark(s) | ' + d.stats?.unique_topics + ' topic(s)'
    );
  } catch (e) {
    log('Get all bookmarks', false, e.message);
  }

  // 6. SEARCH
  try {
    const r = await fetch(base + '/search?q=Node', { headers });
    const d = await r.json();
    log('Search bookmarks', Array.isArray(d.results), d.count + ' result(s) for "Node"');
  } catch (e) {
    log('Search bookmarks', false, e.message);
  }

  // 7. DELETE BOOKMARK
  if (savedId) {
    try {
      const r = await fetch(base + '/bookmark/' + savedId, { method: 'DELETE', headers });
      const d = await r.json();
      log('Delete bookmark', d.success, d.success ? 'id=' + savedId + ' removed' : d.error);
    } catch (e) {
      log('Delete bookmark', false, e.message);
    }
  }

  // 8. DASHBOARD PAGE
  try {
    const r = await fetch('http://localhost:5000/dashboard');
    log('Dashboard page', r.status === 200, 'http://localhost:5000/dashboard (HTTP ' + r.status + ')');
  } catch (e) {
    log('Dashboard page', false, e.message);
  }

  // 9. EXTENSION FILES
  const extFiles = ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'content.js'];
  const missing = extFiles.filter(f => !fs.existsSync('../extension/' + f));
  log(
    'Extension files',
    missing.length === 0,
    missing.length === 0 ? 'All 5 files present' : 'Missing: ' + missing.join(', ')
  );

  const icons = ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'];
  const missingIcons = icons.filter(f => !fs.existsSync('../extension/icons/' + f));
  log(
    'Extension icons',
    missingIcons.length === 0,
    missingIcons.length === 0 ? 'All 4 icon sizes present' : 'Missing: ' + missingIcons.join(', ')
  );

  // SUMMARY
  console.log('\n══════════════════════════════════════');
  if (allOk) {
    console.log('  RESULT: ALL CHECKS PASSED!');
  } else {
    console.log('  RESULT: Some checks need attention (see above)');
  }
  console.log('══════════════════════════════════════');
  console.log('Dashboard:  http://localhost:5000/dashboard');
  console.log('Health API: http://localhost:5000/api/health');
  console.log('Extension:  Load from easy-rewind/extension/ folder\n');
}

checkAll().catch(e => console.error('Fatal:', e.message));
