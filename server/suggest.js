// "What can I cook?" — rank the user's own entries and online recipes (TheMealDB)
// by how well they use the ingredients the user has on hand.
import { cachedJson, mealIngredients } from './recipeImport.js';

const MEALDB = 'https://www.themealdb.com/api/json/v1/1';

/** Lower-case, de-duplicated list of on-hand items. Accepts an array or a comma/newline string. */
export function normalizeItems(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,\n;]+/);
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const s = String(r).toLowerCase().replace(/\s+/g, ' ').trim();
    if (s && s.length <= 60 && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.slice(0, 20);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Singular/plural tolerant word match: "tomatoes" matches "tomato" and vice versa. */
function stem(item) {
  if (item.endsWith('oes')) return item.slice(0, -2);
  if (item.endsWith('ies')) return item.slice(0, -3) + 'y';
  if (item.endsWith('s') && !item.endsWith('ss')) return item.slice(0, -1);
  return item;
}
export function itemMatcher(item) {
  const s = escapeRe(stem(item));
  const tail = s.endsWith('y') ? `(?:y|ies)` : `(?:s|es)?`;
  const base = s.endsWith('y') ? s.slice(0, -1) : s;
  return new RegExp(`\\b${base}${tail}\\b`, 'i');
}

const STAPLE = /\b(salt|black pepper|white pepper|salt and pepper|water|ice|cooking spray|(olive|vegetable|canola|neutral|cooking|sunflower|rapeseed) oil|oil)\b/i;
const BARE_SEASONING = /^(to taste|a pinch( of)?|pinch( of)?|some)?\s*(salt|pepper|salt (and|&) pepper)(,? to taste)?$/i;
const isStaple = (line) => BARE_SEASONING.test(line.trim()) || (STAPLE.test(line) && line.split(/\s+/).length <= 7);

export function rankMyEntries(entries, items) {
  const matchers = items.map((it) => [it, itemMatcher(it)]);
  return entries.map((e) => {
    const hay = [e.name, ...e.tags, ...e.ingredients].join(' \n ');
    const matched = matchers.filter(([, re]) => re.test(hay)).map(([it]) => it);
    if (!matched.length) return null;
    const relevant = e.ingredients.filter((l) => !isStaple(l));
    const missing = relevant.filter((l) => !matchers.some(([, re]) => re.test(l)));
    const coverage = relevant.length ? (relevant.length - missing.length) / relevant.length : 0;
    return { entry: e, matched, missing: missing.slice(0, 8), missingCount: missing.length, coverage };
  })
    .filter(Boolean)
    .sort((a, b) => b.matched.length - a.matched.length || b.coverage - a.coverage)
    .slice(0, 24);
}

export async function searchOnline(items) {
  const queries = [];
  for (const it of items.slice(0, 8)) {
    queries.push([it, it]);
    if (stem(it) !== it) queries.push([it, stem(it)]);
  }
  const results = await Promise.allSettled(queries.map(([, q]) =>
    cachedJson(`${MEALDB}/filter.php?i=${encodeURIComponent(q.replace(/\s+/g, '_'))}`)));

  const byId = new Map();
  let anyOk = false;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    anyOk = true;
    for (const m of r.value?.meals || []) {
      const cur = byId.get(m.idMeal) || { meal: m, matched: new Set() };
      cur.matched.add(queries[i][0]);
      byId.set(m.idMeal, cur);
    }
  });
  if (!anyOk && results.length) throw new Error('Online recipe search is unavailable right now.');

  const top = [...byId.values()].sort((a, b) => b.matched.size - a.matched.size).slice(0, 12);
  const matchers = items.map((it) => [it, itemMatcher(it)]);
  const detailed = await Promise.allSettled(top.map((t) => cachedJson(`${MEALDB}/lookup.php?i=${t.meal.idMeal}`)));

  return top.map((t, i) => {
    const full = detailed[i].status === 'fulfilled' ? detailed[i].value?.meals?.[0] : null;
    const ingredients = full ? mealIngredients(full) : [];
    // Re-check matches against the full ingredient list (catches items found via other queries).
    const matched = new Set(t.matched);
    for (const [it, re] of matchers) if (ingredients.some((l) => re.test(l))) matched.add(it);
    const missing = ingredients.filter((l) => !isStaple(l) && !matchers.some(([, re]) => re.test(l)));
    return {
      id: t.meal.idMeal,
      name: t.meal.strMeal,
      thumb: t.meal.strMealThumb,
      url: `https://www.themealdb.com/meal/${t.meal.idMeal}`,
      area: full?.strArea || '',
      category: full?.strCategory || '',
      matched: [...matched],
      missing: missing.slice(0, 8),
      missingCount: missing.length,
      ingredientCount: ingredients.length,
    };
  }).sort((a, b) => b.matched.length - a.matched.length || a.missingCount - b.missingCount);
}
