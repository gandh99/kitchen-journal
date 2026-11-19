// YouTube support: read a video's title, description and thumbnail, then pull the
// ingredients/method out of the description (where most cooking channels put them).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Returns the 11-char video id for any common YouTube URL shape, else null. */
export function youtubeId(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v')
      || u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1]
      || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function jsonString(html, re) {
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

/** @returns {Promise<{id, title, channel, description, thumbnail, url}>} */
export async function fetchYouTubeVideo(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  let title = null;
  let channel = null;
  let description = '';

  try {
    const res = await fetch(`${url}&hl=en`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      description = jsonString(html, /"shortDescription":"((?:[^"\\]|\\.)*)"/) || '';
      title = jsonString(html, /"videoDetails":\{[^{}]*?"title":"((?:[^"\\]|\\.)*)"/);
      channel = jsonString(html, /"ownerChannelName":"((?:[^"\\]|\\.)*)"/) || jsonString(html, /"author":"((?:[^"\\]|\\.)*)"/);
    }
  } catch { /* fall through to oEmbed */ }

  if (!title) {
    // Official oEmbed endpoint: always gives title + channel, never the description.
    try {
      const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
      if (o.ok) { const j = await o.json(); title = j.title; channel = j.author_name; }
      else if (o.status === 404 || o.status === 401 || o.status === 400) {
        throw Object.assign(new Error('That YouTube video is private, removed, or does not exist.'), { status: 404 });
      }
    } catch (e) { if (e.status) throw e; }
  }
  if (!title) throw Object.assign(new Error('Could not reach YouTube. Try again in a moment.'), { status: 502 });

  return { id, url, title, channel, description, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
}

/** "Best Pad Thai EVER! 🍜 | Chef John #shorts" -> "Best Pad Thai EVER!" */
export function cleanVideoTitle(title = '', channel = '') {
  // "Binging with Babish: Pasta Aglio e Olio" -> "Pasta Aglio e Olio"
  if (channel && title.toLowerCase().startsWith(channel.toLowerCase())) {
    const rest = title.slice(channel.length).replace(/^\s*[:|–—-]\s*/, '');
    if (rest.length > 3) title = rest;
  }
  return title
    .replace(/#\w+/g, '')
    .split(/\s[|–—]\s|\s-\s(?=[^-]*$)/)[0]
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim() || title.trim();
}

const SKIP_LINK_HOSTS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.me|tiktok\.com|twitter\.com|x\.com|threads\.net|patreon\.com|amazon\.[a-z.]+|amzn\.to|amzn\.eu|spotify\.com|apple\.com|discord\.(gg|com)|pinterest\.[a-z.]+|pin\.it|snapchat\.com|twitch\.tv|reddit\.com|ko-fi\.com|buymeacoffee\.com|paypal\.me|epidemicsound\.com|artlist\.io|geni\.us|shopmy\.us|ltk\.app|liketoknow\.it)$/i;

/** Links in the description that might be the written recipe, best first. */
export function recipeLinks(description = '') {
  const found = [];
  for (const line of description.split('\n')) {
    for (const m of line.matchAll(/https?:\/\/[^\s)<>"']+/g)) {
      const href = m[0].replace(/[.,!?]+$/, '');
      let host;
      try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { continue; }
      if (SKIP_LINK_HOSTS.test(host)) continue;
      const score = (/recipe/i.test(line) ? 2 : 0) + (/recipe/i.test(href) ? 1 : 0);
      found.push({ href, score });
    }
  }
  const seen = new Set();
  return found.sort((a, b) => b.score - a.score)
    .filter(({ href }) => !seen.has(href) && seen.add(href))
    .map((f) => f.href)
    .slice(0, 3);
}
