// Pull ingredients and method out of free text: a YouTube description, or text the
// user copied from a recipe page. Uses section headings first, then falls back to
// "looks like an ingredient" heuristics.

const ING_HEAD = /^\W*(?:recipe\s+)?(?:ingredients?|ingredient list|what you(?:'|’)?ll need|you(?:'|’)?ll need|you will need|shopping list)\b[^.!?]{0,40}$/i;
const METHOD_HEAD = /^\W*(?:method|instructions?|directions?|steps|preparation|procedure|how to make(?: it)?|recipe steps|cooking instructions|let(?:'|’)?s cook)\b[^.!?]{0,40}$/i;
const STOP_HEAD = /^\W*(?:notes?|recipe notes|tips|nutrition(?:al)?(?: info(?:rmation)?| facts)?|equipment|tools|video|did you make|tried this|comments?|leave a (?:comment|review)|rate this|reviews?|related|more recipes|you may also like|follow|subscribe|social|links?|music|products|shop|merch|business|contact|chapters|timestamps|affiliate|disclaimer|about me|connect|sponsor|storage|faq|serving suggestions)\b[^.!?]{0,40}$/i;
const SOCIAL_LINE = /\b(subscribe|instagram|facebook|tiktok|twitter|patreon|pinterest|follow me|my channel|business inquiries|affiliate link|use code|discount code)\b/i;
const NOISE = /^(?:units?\b|(?:us|metric|imperial)\b.{0,20}\b(?:metric|us|imperial)|\d+x(?:\s+\d+x)*|cook mode|prevent your screen|print(?: recipe)?|pin(?: recipe)?|save(?: recipe)?|jump to (?:recipe|video)|scale|servings?:?\s*\d*|serves:?\s*\d*|yield:?.*|prep time.*|cook time.*|total time.*|course:?.*|cuisine:?.*|keyword:?.*|author:?.*|calories:?.*|▢)$/i;
const TIMESTAMP = /^(?:\(?\d{1,2}:)?\d{1,2}:\d{2}\)?\s*[-–—:|]?\s*/;

const UNIT = /\b(?:\d+\s*)?(?:g|kg|mg|ml|l|cl|dl|cups?|c\.|tbsps?|tsps?|tbs|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|cloves?|pinch(?:es)?|handfuls?|cans?|tins?|slices?|sticks?|bunch(?:es)?|sprigs?|stalks?|pieces?|packets?|knobs?|dash(?:es)?|large|medium|small)\b/i;
const QTY_START = /^(?:\d+(?:[.,/]\d+)?(?:\s*-\s*\d+(?:[.,/]\d+)?)?|[½¼¾⅓⅔⅛⅜⅝⅞]|\d+\s*[½¼¾⅓⅔⅛]|a |an |one |two |three |four |five |half |a pinch|a handful|pinch|handful|salt|pepper)/i;

const URL_RE = /https?:\/\/\S+/g;
const BULLET = /^[\s\-–—•*·▪▫◦●○■□▢✔✓☐☑➤►▶→>]+/;
const LEADING_EMOJI = /^[\p{Extended_Pictographic}️‍\s]+/u;

export function cleanLine(line) {
  return line.replace(URL_RE, '').replace(BULLET, '').replace(LEADING_EMOJI, '').replace(/\s+/g, ' ').trim()
    .replace(/[:\-–—|]+$/, (m) => (m.includes(':') ? ':' : '')).trim();
}

export const looksLikeIngredient = (l) => l.length <= 160 && (QTY_START.test(l) || UNIT.test(l)) && !TIMESTAMP.test(l);

const isHeading = (l) => l.length < 60 && (ING_HEAD.test(l) || METHOD_HEAD.test(l) || STOP_HEAD.test(l));

/** Collect lines after index `start` until the next top-level heading. */
function collectSection(lines, start, kind) {
  const out = [];
  for (let i = start; i < lines.length && out.length < 80; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (isHeading(raw.trim()) && !(kind === 'ing' && ING_HEAD.test(raw.trim()) && out.length === 0)) break;
    if (SOCIAL_LINE.test(raw) && !looksLikeIngredient(cleanLine(raw))) { if (out.length) break; else continue; }
    const l = cleanLine(raw);
    if (!l || NOISE.test(l)) continue;
    // "Watch this in Spanish: https://…" -> only a label is left once the link is gone.
    if (/https?:\/\//.test(raw) && (l.length < 60 || /:$/.test(l))) continue;
    if (kind === 'ing' && l.length > 200) continue;
    if (kind === 'method' && l.length > 1500) continue;
    out.push(kind === 'method' ? l.replace(/^(?:step\s*)?\d+\s*[.):-]\s*/i, '').replace(/^step\s*\d+\s*/i, '') : l);
  }
  return out.filter(Boolean);
}

/**
 * @returns {{ingredients: string[], steps: string[], chapters: string[]}}
 */
export function parseRecipeText(text = '') {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim());

  // 1. Section headings. Pages often mention "Ingredients" several times (jump links,
  //    article prose), so score each candidate section and keep the best one.
  let best = { score: 0, ingredients: [], end: -1 };
  lines.forEach((l, i) => {
    if (l.length < 60 && ING_HEAD.test(l)) {
      const items = collectSection(lines, i + 1, 'ing');
      const score = items.filter(looksLikeIngredient).length + items.length * 0.1;
      if (score > best.score) best = { score, ingredients: items, end: i };
    }
  });
  let ingredients = best.score >= 1 ? best.ingredients : [];

  // 2. No usable heading: take the longest run of ingredient-looking lines.
  if (!ingredients.length) {
    let run = [];
    let bestRun = [];
    for (const raw of lines) {
      const l = cleanLine(raw);
      if (l && looksLikeIngredient(l) && !SOCIAL_LINE.test(raw)) run.push(l);
      else if (l) { if (run.length > bestRun.length) bestRun = run; run = []; }
    }
    if (run.length > bestRun.length) bestRun = run;
    if (bestRun.length >= 3) ingredients = bestRun;
  }

  // Method: the first method heading after the ingredients (or anywhere).
  let steps = [];
  const from = Math.max(best.end, 0);
  const idx = lines.findIndex((l, i) => i >= from && l.length < 60 && METHOD_HEAD.test(l));
  const anyIdx = idx >= 0 ? idx : lines.findIndex((l) => l.length < 60 && METHOD_HEAD.test(l));
  if (anyIdx >= 0) steps = collectSection(lines, anyIdx + 1, 'method');

  // YouTube chapter markers ("2:15 Making the sauce") work as a rough method.
  const chapters = lines.filter((l) => TIMESTAMP.test(l) && /^\(?\d/.test(l))
    .map((l) => cleanLine(l.replace(TIMESTAMP, '')))
    .filter((l) => l && !/^(intro(duction)?|outro|ending|end screen|thanks for watching|subscribe)\b/i.test(l));

  return { ingredients: [...new Set(ingredients)].slice(0, 120), steps: steps.slice(0, 80), chapters: chapters.length >= 3 ? chapters : [] };
}
