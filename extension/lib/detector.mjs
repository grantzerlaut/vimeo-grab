// Page scanner. chrome.scripting injects this one function into each frame,
// so it must be self-contained: no imports, no outer variables.
//
// It runs in the extension's isolated world, reads the DOM and inline
// scripts, and never executes or modifies anything on the page. Results are
// treated as untrusted by the service worker.
export function scanPage() {
  const MAX_ITEMS = 300;
  const MAX_TEXT = 5_000_000;
  const found = new Map();
  const configs = [];
  const isPlayer = location.hostname === 'player.vimeo.com';
  const urlPattern = /(?:https?:)?\/\/(?:www\.|player\.)?vimeo\.com\/[^\s"'<>\\)]+/gi;

  function add(value, title, source) {
    if (!value || found.size >= MAX_ITEMS || String(value).length > 2048) return;
    let url;
    try { url = new URL(String(value).trim().replace(/\\\//g, '/').replace(/&amp;/g, '&'), location.href); } catch { return; }
    if (!/(^|\.)vimeo\.com$/i.test(url.hostname) || !/\/\d{3,}/.test(url.pathname)) return;
    const previous = found.get(url.href);
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!previous || (!previous.title && clean)) found.set(url.href, {url: url.href, title: clean || previous?.title || '', source});
  }

  function scanText(text, source) {
    if (!text || text.length > MAX_TEXT || !text.includes('vimeo.com')) return;
    const unescaped = text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
    for (const match of unescaped.matchAll(urlPattern)) add(match[0], '', source);
  }

  // Find `playerConfig = {...}` in the player's own HTML and parse it as JSON.
  function readConfigs(text) {
    const marker = /(?:window\.)?playerConfig\s*=\s*/g;
    while (marker.exec(text)) {
      const start = marker.lastIndex;
      if (text[start] !== '{') continue;
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try {
            const config = JSON.parse(text.slice(start, i + 1));
            if (config?.video?.id) {
              // Keep only what the extension reads; drop DRM certificates etc.
              const request = config.request || {};
              configs.push({video: config.video, request: {files: request.files, text_tracks: request.text_tracks,
                config_refresh_url: request.config_refresh_url}});
            }
          } catch { /* Not JSON after all. */ }
          marker.lastIndex = i + 1;
          break;
        }
      }
    }
  }

  const label = node => node.getAttribute('title') || node.getAttribute('aria-label') || node.getAttribute('data-title') || '';
  add(location.href, isPlayer ? '' : document.title, isPlayer ? 'embed' : 'page');

  const roots = [document];
  for (let r = 0; r < roots.length && found.size < MAX_ITEMS; r++) {
    for (const node of roots[r].querySelectorAll('*')) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      const tag = node.localName;
      for (const attr of node.attributes) {
        const value = attr.value;
        if (!value.includes('vimeo.com')) continue;
        if (['src', 'href', 'data-src', 'data-lazy-src', 'data-url', 'data-video-url', 'data-vimeo-url', 'data-embed-src'].includes(attr.name)) {
          const title = tag === 'a' ? node.textContent : label(node);
          add(value, title, tag === 'iframe' || attr.name !== 'href' ? 'embed' : 'link');
        } else scanText(value, 'data');
      }
      // Lazy-embed widgets that store only an ID (lite-vimeo, Plyr, page builders).
      const provider = (node.getAttribute('data-plyr-provider') || node.getAttribute('data-provider') ||
        node.getAttribute('data-video-provider') || node.getAttribute('data-type') || '').toLowerCase();
      const id = node.getAttribute('data-vimeo-id') || node.getAttribute('data-vimeo') ||
        (tag === 'lite-vimeo' || tag === 'lite-vimeo-embed' ? node.getAttribute('videoid') || node.getAttribute('data-id') : null) ||
        (provider.includes('vimeo') ? node.getAttribute('data-plyr-embed-id') || node.getAttribute('data-video-id') || node.getAttribute('data-id') : null);
      if (/^\d{3,}$/.test(id || '')) {
        const hash = node.getAttribute('data-vimeo-hash') || node.getAttribute('data-hash') || '';
        add(`https://player.vimeo.com/video/${id}${/^[0-9a-f]{6,64}$/i.test(hash) ? '?h=' + hash : ''}`, label(node), 'embed');
      }
    }
  }

  for (const script of document.scripts) {
    const text = script.textContent || '';
    if (text.length > MAX_TEXT) continue;
    if (isPlayer && text.includes('playerConfig')) readConfigs(text);
    scanText(text, 'script');
  }

  try {
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.name.includes('player.vimeo.com/video/')) add(entry.name, '', 'network');
    }
  } catch { /* Resource timing can be unavailable. */ }

  return {url: location.href, title: document.title, top: window === window.top, items: [...found.values()], configs};
}
