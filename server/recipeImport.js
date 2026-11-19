import { safeFetch, UrlError } from './safeFetch.js';
import { CATEGORIES, guessCategory } from './tagger.js';
import { parseRecipeText, looksLikeIngredient } from './textParse.js';
import { youtubeId, fetchYouTubeVideo, cleanVideoTitle, recipeLinks } from './youtube.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_HTML = 5 * 1024 * 1024;

export function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------- safe fetching
// The SSRF guard (address checks pinned to the connection, port/scheme limits,
// manual redirects, streamed body cap) lives in safeFetch.js.
const PAGE_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' };
// One message for every network/upstream failure, so the importer can't be used to
// probe which internal hosts/ports exist or what they answer. Details go to the log.
const FETCH_FAILED = "Couldn't fetch that page. Use the Clip button from your browser, or paste the recipe text instead.";

/** Fetch a page for import; returns { status, ok, url, headers, body } or throws an httpError. */
async function fetchPage(rawUrl) {
  try {
    return await safeFetch(rawUrl, { headers: PAGE_HEADERS, maxBytes: MAX_HTML, timeoutMs: 15000, maxRedirects: 5 });
  } catch (e) {
    if (e instanceof UrlError) throw httpError(400, e.message);
    console.error(`[import] fetch failed for ${rawUrl}:`, e?.message || e, e?.cause?.code || '');
    throw httpError(502, FETCH_FAILED, 'blocked');
  }
}

// ---------------------------------------------------------------- HTML helpers
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓', frac23: '⅔', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', times: '×' };
export function decodeEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const stripTags = (s = '') => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').trim();
const stripScripts = (html) => html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');

/** Rough HTML -> text with line breaks at block boundaries (for heading-based parsing). */
function htmlToText(html) {
  return decodeEntities(stripScripts(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|table|dd|dt|figure|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s+/g, '\n');
}

function findRecipeNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node !== 'object') return null;
  const type = node['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const r = findRecipeNode(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

function flattenInstructions(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') {
    // Some sites put the whole method in one string, with or without HTML.
    return htmlToText(ins).split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(ins)) return ins.flatMap(flattenInstructions);
  if (typeof ins === 'object') {
    if (ins.itemListElement) {
      const steps = flattenInstructions(ins.itemListElement);
      return ins.name ? [`${stripTags(ins.name).replace(/:+$/, '')}:`, ...steps] : steps;
    }
    return [stripTags(ins.text || ins.name || '')];
  }
  return [];
}

function pickImage(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return pickImage(img[0]);
  return img.url || img.contentUrl || '';
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function mapCategory(values = []) {
  const text = values.join(' ').toLowerCase();
  if (!text) return null;
  if (/dessert|sweet/.test(text)) return 'Desserts';
  if (/bread|bak|cake|cookie|pastr|muffin/.test(text)) return 'Baking';
  if (/breakfast|brunch/.test(text)) return 'Breakfast';
  if (/soup|salad|stew/.test(text)) return 'Soups & Salads';
  if (/drink|beverage|cocktail/.test(text)) return 'Drinks';
  if (/side|snack|appeti|starter/.test(text)) return 'Snacks & Sides';
  if (/main|dinner|lunch|entr/.test(text)) return 'Mains';
  return null;
}

const httpUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol) ? new URL(u).href : ''; } catch { return ''; } };
const absUrl = (u, base) => { if (!u) return ''; try { return httpUrl(new URL(decodeEntities(u), base).href); } catch { return ''; } };

/** Text of every element whose class list contains `cls`. */
function textByClass(html, cls) {
  const re = new RegExp(`<(li|div|span|p)\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
  return [...html.matchAll(re)].map((m) => stripTags(m[2])).filter(Boolean);
}

/**
 * Find recipe data in a page's HTML. Tries, in order: schema.org JSON-LD, microdata,
 * popular WordPress recipe plugins (WP Recipe Maker, Tasty, Mediavine Create), and
 * finally "Ingredients"/"Method" headings in the page text.
 * @returns {object|null}
 */
export function parseRecipeHtml(html, baseUrl, { strict = false } = {}) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const pageName = stripTags(ogTitle || title || '').replace(/\s[|–—-]\s[^|–—-]+$/, '');

  // 1. JSON-LD
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let recipe = null;
    try { recipe = findRecipeNode(JSON.parse(m[1].trim())); } catch { /* invalid JSON-LD; keep looking */ }
    if (recipe) {
      const ingredients = asList(recipe.recipeIngredient || recipe.ingredients).map(stripTags).filter(Boolean);
      if (!ingredients.length) continue;
      return {
        name: stripTags(recipe.name || pageName),
        ingredients,
        instructions: flattenInstructions(recipe.recipeInstructions).filter(Boolean).join('\n'),
        imageUrl: absUrl(pickImage(recipe.image) || ogImage, baseUrl),
        category: mapCategory(asList(recipe.recipeCategory)),
        hints: asList(recipe.recipeCuisine).flatMap((c) => String(c).split(',')).map(stripTags).filter((c) => c && c.length < 25),
      };
    }
  }

  const base = { name: pageName, imageUrl: absUrl(ogImage, baseUrl), category: null, hints: [] };

  // 2. Microdata
  const micro = [...html.matchAll(/<([a-z]+)[^>]*itemprop=["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => stripTags(m[2])).filter(Boolean);
  if (micro.length) {
    const steps = [...html.matchAll(/<([a-z]+)[^>]*itemprop=["']recipeInstructions["'][^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => htmlToText(m[2]).trim());
    return { ...base, ingredients: micro, instructions: steps.join('\n').replace(/\n{2,}/g, '\n').trim() };
  }

  // 3. Recipe-card plugins used by most food blogs
  const pluginIngredients = [
    ...textByClass(html, 'wprm-recipe-ingredient'),
  ];
  const tasty = html.match(/class=["'][^"']*tasty-recipes-ingredients[^"']*["'][\s\S]*?(<ul[\s\S]*?<\/ul>)/i)?.[1];
  const mv = html.match(/class=["'][^"']*mv-create-ingredients[^"']*["'][\s\S]*?(<ul[\s\S]*?<\/ul>)/i)?.[1];
  for (const block of [tasty, mv]) if (block) pluginIngredients.push(...[...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1])));
  if (pluginIngredients.length) {
    const steps = [
      ...textByClass(html, 'wprm-recipe-instruction-text'),
      ...[...(html.match(/class=["'][^"']*(?:tasty-recipes-instructions|mv-create-instructions)[^"']*["'][\s\S]*?(<ol[\s\S]*?<\/ol>)/i)?.[1] || '')
        .matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1])),
    ];
    return { ...base, ingredients: pluginIngredients.filter(Boolean), instructions: steps.join('\n') };
  }

  // 4. Headings in the page text (skipped in strict mode, e.g. for links found in a
  //    video description, which are often shops rather than recipes).
  if (strict) return null;
  const parsed = parseRecipeText(htmlToText(html));
  const good = parsed.ingredients.filter(looksLikeIngredient).length;
  if (good >= 3 && good / parsed.ingredients.length >= 0.6) {
    return { ...base, ingredients: parsed.ingredients, instructions: parsed.steps.join('\n') };
  }
  return null;
}

function finalize(out, sourceUrl) {
  out.ingredients = [...new Set(out.ingredients.map((s) => s
    .replace(/\(\(([^()]*)\)\)/g, '($1)')   // "((or other oil))" -> "(or other oil)"
    .replace(/\(\s*,\s*/g, '(')             // "(, thinly sliced)" -> "(thinly sliced)"
    .replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 150);
  out.instructions = (out.instructions || '').trim();
  out.category = out.category && CATEGORIES.includes(out.category) ? out.category : guessCategory(out.name, out.ingredients);
  out.hints ??= [];
  out.sourceUrl = sourceUrl || out.sourceUrl || '';
  return out;
}

// ---------------------------------------------------------------- TheMealDB
const MEALDB = 'https://www.themealdb.com/api/json/v1/1';
const cache = new Map();
export async function cachedJson(url, ttlMs = 60 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache.set(url, { data, expires: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

export function mealIngredients(meal) {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    const ing = (meal[`strIngredient${i}`] || '').trim();
    if (!ing) continue;
    const measure = (meal[`strMeasure${i}`] || '').trim();
    out.push(measure ? `${measure} ${ing}` : ing);
  }
  return out;
}

// TheMealDB now labels some areas by country ("India"); use the cuisine name instead.
const AREA_NAMES = {
  'united states': 'American', usa: 'American', india: 'Indian', china: 'Chinese', japan: 'Japanese', italy: 'Italian',
  france: 'French', mexico: 'Mexican', thailand: 'Thai', vietnam: 'Vietnamese', 'united kingdom': 'British', uk: 'British',
  greece: 'Greek', spain: 'Spanish', malaysia: 'Southeast Asian', malaysian: 'Southeast Asian', philippines: 'Filipino',
  egypt: 'Middle Eastern', egyptian: 'Middle Eastern', turkey: 'Middle Eastern', turkish: 'Middle Eastern',
  morocco: 'North African', moroccan: 'North African', tunisia: 'North African', tunisian: 'North African',
  jamaica: 'Caribbean', jamaican: 'Caribbean', korea: 'Korean', 'south korea': 'Korean',
};
const areaTag = (a = '') => AREA_NAMES[a.toLowerCase()] || a;

export function mealCategory(meal) {
  // Our own rules know e.g. pancakes are breakfast; only fall back to TheMealDB's labels.
  const guess = guessCategory(meal.strMeal, mealIngredients(meal));
  if (guess !== 'Mains') return guess;
  const c = (meal.strCategory || '').toLowerCase();
  if (c === 'dessert') return 'Desserts';
  if (c === 'breakfast') return 'Breakfast';
  if (c === 'starter' || c === 'side') return 'Snacks & Sides';
  return 'Mains';
}

async function importMealDb(id) {
  const data = await cachedJson(`${MEALDB}/lookup.php?i=${encodeURIComponent(id)}`);
  const meal = data?.meals?.[0];
  if (!meal) throw httpError(404, 'Recipe not found on TheMealDB.');
  return finalize({
    name: meal.strMeal,
    ingredients: mealIngredients(meal),
    instructions: (meal.strInstructions || '').replace(/\r\n/g, '\n'),
    imageUrl: httpUrl(meal.strMealThumb),
    category: mealCategory(meal),
    hints: meal.strArea && meal.strArea !== 'Unknown' ? [areaTag(meal.strArea)] : [],
  }, meal.strSource || `https://www.themealdb.com/meal/${meal.idMeal}`);
}

// ---------------------------------------------------------------- web pages
async function importWebPage(rawUrl, { strict = false } = {}) {
  const res = await fetchPage(rawUrl);
  if (!res.ok) {
    console.error(`[import] ${res.url} answered HTTP ${res.status}`);
    throw httpError(502, FETCH_FAILED, 'blocked');
  }
  const html = res.body.toString('utf8');
  const recipe = parseRecipeHtml(html, res.url || rawUrl, { strict });
  if (!recipe) {
    throw httpError(422, "Couldn't find a recipe on that page. Try the Clip button, or paste the recipe text.", 'blocked');
  }
  return finalize(recipe, rawUrl);
}

// ---------------------------------------------------------------- YouTube
async function importYouTube(id) {
  const video = await fetchYouTubeVideo(id);
  const parsed = parseRecipeText(video.description);
  const out = {
    name: cleanVideoTitle(video.title, video.channel),
    ingredients: parsed.ingredients,
    instructions: parsed.steps.join('\n'),
    imageUrl: video.thumbnail,
    category: null,
    hints: [],
    notes: '',
    via: 'youtube',
    channel: video.channel,
  };

  // Many channels only link to the written recipe. Follow those links when the
  // description itself is missing the ingredients or the method.
  if (out.ingredients.length < 3 || !out.instructions) {
    for (const link of recipeLinks(video.description)) {
      try {
        const linked = await importWebPage(link, { strict: true });
        if (linked.ingredients.length >= 3) {
          if (out.ingredients.length < 3) out.ingredients = linked.ingredients;
          if (!out.instructions) out.instructions = linked.instructions;
          out.hints = linked.hints;
          out.category = linked.category;
          out.notes = `Written recipe: ${linked.sourceUrl}`;
          out.linkedRecipe = linked.sourceUrl;
          break;
        }
      } catch { /* try the next link */ }
    }
  }
  if (!out.instructions && parsed.chapters.length) out.instructions = parsed.chapters.join('\n');

  if (!out.ingredients.length) {
    out.warning = video.description
      ? "This video's description doesn't list the ingredients, so only the title and thumbnail were imported."
      : "Couldn't read this video's description, so only the title and thumbnail were imported.";
  }
  if (video.channel) out.notes = [`Video by ${video.channel}.`, out.notes].filter(Boolean).join(' ');
  return finalize(out, video.url);
}

// ---------------------------------------------------------------- entry points
/** Import from a link: YouTube, TheMealDB, or any recipe web page. */
export async function importRecipe(rawUrl) {
  const yt = youtubeId(rawUrl);
  if (yt) return importYouTube(yt);
  const mealdb = String(rawUrl).match(/themealdb\.com\/(?:meal\/|meal\.php\?c=|.*[?&]i=)(\d+)/i);
  if (mealdb) return importMealDb(mealdb[1]);
  return importWebPage(rawUrl);
}

/** Import from page HTML the user's own browser already loaded (the Clip bookmarklet). */
export function importFromHtml(html, pageUrl) {
  const recipe = parseRecipeHtml(String(html).slice(0, MAX_HTML), httpUrl(pageUrl) || undefined);
  if (!recipe) throw httpError(422, "Couldn't find a recipe on that page. Try pasting the recipe text instead.");
  return finalize(recipe, httpUrl(pageUrl));
}

/** Import from text the user pasted. */
export function importFromText(text, pageUrl = '') {
  const parsed = parseRecipeText(String(text).slice(0, 300000));
  if (!parsed.ingredients.length) {
    throw httpError(422, 'Couldn\'t spot an ingredient list. Make sure the text includes the "Ingredients" section.');
  }
  return finalize({ name: '', ingredients: parsed.ingredients, instructions: parsed.steps.join('\n'), imageUrl: '', category: null, hints: [] }, httpUrl(pageUrl));
}
