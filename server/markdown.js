// Markdown import/export.
//
// Export layout (modelled on a hand-kept "Food" notes folder):
//   README.md                  overview + how to re-import
//   main.md                    "Food Journey" journal of savoury dishes (## What I have made / ## Wishlist)
//   dessert.md                 the same for baking & desserts
//   Categories/*.md            themed lists (per category, by cuisine, by main ingredient, all tags)
//   Recipes/<dish>.md          one full recipe per entry; YAML front matter keeps every field so a
//                              re-import is lossless
//   Pictures/<Dish>/NN.jpg     the entry's photos
//
// Import understands that layout and the hand-written conventions it came from:
//   "- [*] Dish"            favourite      "  - [*] https://…"   the source actually used
//   bullets under a link    notes on that source
//   Ingredients / Steps / Method / Personal notes sub-lists
//   "## Wishlist", "## KIV …"  dishes to try        "Refer to markdown" / "foo.md"  a full recipe file
//   Pictures/<Dish>/001/20240818_130813.jpg   one folder per attempt, dated by file name
import path from 'node:path';
import { CATEGORIES, guessCategory, suggestTags, MEAT_TAGS, isCuisineTag } from './tagger.js';
import { parseRecipeText } from './textParse.js';

export const SWEET_CATEGORIES = new Set(['Baking', 'Desserts']);
const MARK = (kind) => `<!-- kitchen-journal:${kind} -->`;

// ============================================================ small helpers
export function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'recipe';
}

export function folderName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'Untitled';
}

/** Names compared loosely: case, punctuation, [*], and simple plurals don't matter. */
export function normName(s) {
  return String(s).toLowerCase().replace(/\[[*?]+\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}
/** Same, ignoring anything in brackets: "Braised pork belly (东坡肉)" -> "braised pork belly". */
const baseName = (s) => normName(String(s).replace(/\([^)]*\)|（[^）]*）/g, ' '));

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
// ---- loose name matching for photo folders vs dish names
const FILLER = new Set(['al', 'alla', 'all', 'ai', 'agli', 'alle', 'di', 'e', 'and', 'n', 'with', 'the', 'a', 'of', 'l', 'la', 'le', 'de', 'du', 'style']);
const stem = (w) => (w.length > 5 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const PASTA_SHAPES = /^(spaghetti|spaghettoni|bucatini|linguine|linguini|fettuccine|fettucine|tagliatelle|pappardelle|penne|rigatoni|fusilli|farfalle|orecchiette|paccheri|casarecce|caserecce|mafaldine|ziti|tonnarelli)$/;
const tokens = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
  .filter((w) => w && !FILLER.has(w)).map((w) => (PASTA_SHAPES.test(w) ? 'pasta' : stem(w)));
const tokenKey = (s) => [...tokens(s)].sort().join(' ');
const cjkIn = (s) => (String(s).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu) || []);
const fuzzyTokensEqual = (a, b) => {
  const x = tokens(a); const y = tokens(b);
  return x.length === y.length && x.length > 0 && x.every((w, i) => w === y[i] || (w.length >= 6 && y[i].length >= 6 && levenshtein(w, y[i]) <= (w.length >= 8 ? 2 : 1)));
};
const subsetMatch = (a, b) => {
  const x = new Set(tokens(String(a).replace(/\([^)]*\)/g, ' ')));
  const y = new Set(tokens(String(b).replace(/\([^)]*\)/g, ' ')));
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return small.size >= 2 && big.size - small.size <= 1 && [...small].every((w) => big.has(w));
};
/** Folder-vs-dish predicates, strictest first. */
const MATCH_PASSES = [
  (f, n) => normName(f) === normName(n),
  (f, n) => baseName(f) === baseName(n),
  (f, n) => tokenKey(f) === tokenKey(n) || tokenKey(f) === tokenKey(String(n).replace(/\([^)]*\)/g, ' ')),
  (f, n) => tokens(f).join('') === tokens(String(n).replace(/\([^)]*\)/g, ' ')).join(''), // "Butadon" = "Buta don"
  (f, n) => cjkIn(f).some((c) => c.length >= 2 && cjkIn(n).some((d) => d === c || (c.length >= 3 && d.includes(c)))),
  (f, n) => fuzzyTokensEqual(f, n) || fuzzyTokensEqual(f, String(n).replace(/\([^)]*\)/g, ' ')),
  (f, n) => subsetMatch(f, n),
];

const similarNames = (a, b) => {
  const x = baseName(a); const y = baseName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x) || levenshtein(x, y) <= Math.max(2, Math.floor(Math.min(x.length, y.length) * 0.15));
};

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const cmpName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// ============================================================ front matter (a JSON-valued subset of YAML)
function toFrontMatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    lines.push(`${k}: ${typeof v === 'boolean' ? v : JSON.stringify(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseFrontMatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: null, body: String(text) };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(parseScalar(item[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2] === '') { listKey = kv[1]; data[listKey] = []; continue; }
    listKey = null;
    data[kv[1]] = parseScalar(kv[2]);
  }
  return { data, body: String(text).slice(m[0].length) };
}
function parseScalar(raw) {
  const s = raw.trim();
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^[["{]/.test(s)) { try { return JSON.parse(s); } catch { /* fall through */ } }
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return s.replace(/^['"]|['"]$/g, '');
}

// ============================================================ EXPORT
/**
 * Plan file names for every entry (unique recipe slugs and picture folders).
 * @param entries API-shaped entries (with photos[] carrying {url, file})
 */
export function planExport(entries) {
  const slugs = new Set();
  const folders = new Set();
  return entries.map((e) => {
    let slug = slugify(e.name);
    for (let i = 2; slugs.has(slug); i++) slug = `${slugify(e.name)}_${i}`;
    slugs.add(slug);
    let folder = folderName(e.name);
    for (let i = 2; folders.has(folder.toLowerCase()); i++) folder = `${folderName(e.name)} (${i})`;
    folders.add(folder.toLowerCase());
    const pictures = e.photos.map((p, i) => ({
      src: p.file,
      zipPath: `Pictures/${folder}/${String(i + 1).padStart(2, '0')}${path.extname(p.file).toLowerCase() || '.jpg'}`,
    }));
    return { entry: e, slug, recipePath: `Recipes/${slug}.md`, pictures };
  });
}

export function recipeMarkdown(e, { photoLinks = [], absolutePhotos = false } = {}) {
  const fm = toFrontMatter({
    name: e.name,
    category: e.category,
    status: e.status,
    favorite: e.favorite,
    tags: e.tags,
    made_on: e.madeOn || null,
    source: e.recipeUrl || null,
    image: e.imageUrl || null,
    photos: photoLinks,
    created: e.createdAt,
    updated: e.updatedAt,
  });
  const meta = [
    `**${e.category}**`,
    e.status === 'wishlist' ? '📝 Want to try' : (e.madeOn ? `Made ${fmtDate(e.madeOn)}` : ''),
    e.tags.length ? e.tags.join(' · ') : '',
  ].filter(Boolean).join(' · ');
  const out = [fm, '', `# ${e.name}${e.favorite ? ' ⭐' : ''}`, '', meta];
  if (e.recipeUrl) out.push('', `Source: [${hostOf(e.recipeUrl)}](${e.recipeUrl})`);
  const cover = photoLinks[0] || e.imageUrl;
  if (cover) out.push('', `![${e.name}](${absolutePhotos || /^https?:/.test(cover) ? cover : encodePath(cover)})`);

  out.push('', '## Ingredients', '');
  out.push(...(e.ingredients.length ? e.ingredients.map((l) => `- ${l}`) : ['_None recorded._']));

  const steps = e.instructions.split('\n').map((s) => s.trim()).filter(Boolean);
  out.push('', '## Method', '');
  out.push(...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['_None recorded._']));

  if (photoLinks.length > 1) {
    out.push('', '## Photos', '');
    out.push(...photoLinks.slice(1).map((p, i) => `![Photo ${i + 2}](${absolutePhotos ? p : encodePath(p)})`));
  }
  // Notes go last so free-form text (which may contain its own headings) can't swallow other sections.
  out.push('', '## Notes', '', e.notes.trim() || '_No notes._', '');
  return out.join('\n');
}

function noteBullets(notes, indent) {
  const pad = ' '.repeat(indent);
  return notes.split('\n').filter((l) => l.trim()).map((l) => {
    const m = l.match(/^(\s*)[-*+]\s+(.*)$/);
    return m ? `${pad}${m[1]}- ${m[2]}` : `${pad}- ${l.trim()}`;
  });
}

/** A "Food Journey" journal in the hand-written style: one bullet per dish, sources and notes nested. */
export function journalMarkdown(title, plans) {
  const made = plans.filter((p) => p.entry.status !== 'wishlist').sort((a, b) => cmpName(a.entry, b.entry));
  const wish = plans.filter((p) => p.entry.status === 'wishlist').sort((a, b) => cmpName(a.entry, b.entry));
  const item = ({ entry: e, recipePath }) => {
    // Same shape as the hand-kept journal: the source you used, with your notes nested under it.
    const lines = [`- ${e.favorite ? '[*] ' : ''}${e.name}`];
    if (e.recipeUrl) {
      lines.push(`  - [*] ${e.recipeUrl}`);
      if (e.notes.trim()) lines.push(...noteBullets(e.notes, 4));
    } else if (e.notes.trim()) {
      lines.push(...noteBullets(e.notes, 2));
    }
    const meta = [e.madeOn && e.status !== 'wishlist' ? `Made ${fmtDate(e.madeOn)}` : '', e.tags.length ? `Tags: ${e.tags.join(', ')}` : ''].filter(Boolean).join(' · ');
    lines.push(`  - Recipe: [${path.basename(recipePath)}](${encodePath(recipePath)})${meta ? ` · ${meta}` : ''}`);
    return lines.join('\n');
  };
  return [
    MARK('journal'),
    '# Food Journey', '', `_${title} · ${made.length} made, ${wish.length} on the wishlist_`, '',
    '## What I have made', made.map(item).join('\n') || '_Nothing yet._', '', '',
    '## Wishlist', wish.map(item).join('\n') || '_Nothing yet._', '',
  ].join('\n');
}

function groupedList(title, groups, intro = '') {
  const out = [MARK('category'), `# ${title}`, ''];
  if (intro) out.push(intro, '');
  for (const [heading, plans] of Object.entries(groups).sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))) {
    out.push(`## ${heading}`);
    for (const p of [...plans].sort((a, b) => cmpName(a.entry, b.entry))) {
      out.push(`- ${p.entry.favorite ? '[*] ' : ''}[${p.entry.name}](../${encodePath(p.recipePath)})${p.entry.status === 'wishlist' ? ' _(want to try)_' : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}
const groupBy = (plans, keysOf) => {
  const groups = {};
  for (const p of plans) for (const k of keysOf(p.entry)) (groups[k] ||= []).push(p);
  return groups;
};
const mainIngredient = (e) => {
  const t = e.tags.find((x) => MEAT_TAGS.includes(x))
    || e.tags.find((x) => ['Tofu', 'Egg', 'Pasta', 'Noodles', 'Rice', 'Bread', 'Chocolate', 'Mushroom', 'Cheese'].includes(x));
  return [t || 'Other'];
};

/** Every non-binary file of the export, as [zipPath, text] pairs. */
export function exportTextFiles(plans, { username, includePhotos }) {
  const files = [];
  const savoury = plans.filter((p) => !SWEET_CATEGORIES.has(p.entry.category));
  const sweet = plans.filter((p) => SWEET_CATEGORIES.has(p.entry.category));
  files.push(['main.md', journalMarkdown('Savoury dishes', savoury)]);
  files.push(['dessert.md', journalMarkdown('Baking & desserts', sweet)]);

  for (const cat of CATEGORIES) {
    const inCat = plans.filter((p) => p.entry.category === cat);
    if (inCat.length) files.push([`Categories/${slugify(cat)}.md`, groupedList(cat, groupBy(inCat, mainIngredient))]);
  }
  files.push(['Categories/by_cuisine.md', groupedList('By cuisine', groupBy(plans, (e) => {
    const c = e.tags.filter(isCuisineTag); return c.length ? c : ['Other'];
  }))]);
  files.push(['Categories/by_main_ingredient.md', groupedList('By main ingredient', groupBy(plans, mainIngredient))]);
  files.push(['Categories/all_tags.md', groupedList('All tags', groupBy(plans, (e) => (e.tags.length ? e.tags : ['Other'])))]);
  const favs = plans.filter((p) => p.entry.favorite);
  if (favs.length) files.push(['Categories/favourites.md', groupedList('Favourites ⭐', groupBy(favs, (e) => [e.category]))]);

  for (const p of plans) {
    files.push([p.recipePath, recipeMarkdown(p.entry, { photoLinks: includePhotos ? p.pictures.map((x) => `../${x.zipPath}`) : [] })]);
  }

  const made = plans.filter((p) => p.entry.status !== 'wishlist').length;
  files.push(['README.md', [
    MARK('readme'),
    `# ${username}'s Kitchen Journal`, '',
    `Exported ${fmtDate(new Date().toISOString().slice(0, 10))}: ${plans.length} entries (${made} made, ${plans.length - made} on the wishlist, ${favs.length} favourites).`, '',
    '## What\'s in here', '',
    '| Path | Contents |', '|---|---|',
    '| `main.md` | Journal of savoury dishes: what you\'ve made and your wishlist |',
    '| `dessert.md` | The same for baking and desserts |',
    '| `Categories/` | Lists by category, cuisine, main ingredient, tag and favourites |',
    '| `Recipes/` | One file per dish with ingredients, method and notes |',
    includePhotos ? '| `Pictures/` | Your photos, one folder per dish |' : '| `Pictures/` | _Not included in this export_ |',
    '', '## Conventions', '',
    '- `[*]` before a dish marks a favourite; `[*]` before a link marks the source you used.',
    '- Each recipe file starts with a `---` block of fields (category, tags, dates…). Keep it if you want a lossless re-import.',
    '- You can edit any of these files by hand. Re-import the folder or a zip of it from **Import & export** in Kitchen Journal.', '',
  ].join('\n')]);
  files.push(['.gitignore', '# Photos are large; remove this line if you want them in git\nPictures/\n']);
  return files;
}

// ============================================================ IMPORT: shared bits
const URL_ONLY = /^<?(https?:\/\/[^\s>]+)>?$/;
const MD_LINK_ONLY = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;
const STAR = /^\[\*\]\s*/;
const stripMd = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').trim();

function parseListTree(lines) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const m = line.match(/^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/);
    if (!m) {
      const t = line.trim();
      const last = stack[stack.length - 1];
      if (t && last !== root) last.text += ` ${t}`; // wrapped continuation line
      continue;
    }
    const node = { indent: m[1].length, text: m[3].trim(), numbered: !!m[2], children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= node.indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function renderTree(nodes, depth = 0) {
  const out = [];
  for (const n of nodes) {
    out.push(`${'  '.repeat(depth)}- ${n.text}`);
    out.push(...renderTree(n.children, depth + 1));
  }
  return out;
}

function flattenLeaves(nodes) {
  const out = [];
  for (const n of nodes) {
    const t = stripMd(n.text.replace(STAR, ''));
    if (n.children.length) { out.push(/[:：]$/.test(t) ? t : `${t}:`); out.push(...flattenLeaves(n.children)); }
    else out.push(t);
  }
  return out.filter(Boolean);
}

const ING_LABEL = /^(?:ingredients?(?: used| list)?|what you(?:'|’)?ll need|you(?:'|’)?ll need)\s*(?:\(.*\))?\s*:?$/i;
const METHOD_LABEL = /^(?:steps|method|instructions?|directions|procedure|how to make(?: it)?)\s*:?$/i;
const NOTES_LABEL = /^(?:(?:personal |my )?notes?|tips|pro[- ]?tips|remarks)\s*:?$/i;
const MADE_SECTION = /\b(made|cooked|baked|tried|done|journal|recipes?)\b/i;
const WISH_SECTION = /\b(wish ?list|kiv|future|to try|to make|todo|to-do|someday|later|ideas?|bucket)\b/i;

// ============================================================ IMPORT: hand-written journal (main.md / dessert.md)
/**
 * @returns {{dishes: object[], skipped: string[]}}
 */
export function parseJournal(text, filePath) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length >= 2) { current = { title: stripMd(h[2]), lines: [] }; sections.push(current); }
      continue;
    }
    if (current) current.lines.push(line);
  }

  const sweetFile = /dessert|bak|sweet|cake|pastr|bread/i.test(path.basename(filePath));
  const dishes = [];
  const skipped = [];
  for (const sec of sections) {
    const status = WISH_SECTION.test(sec.title) ? 'wishlist' : MADE_SECTION.test(sec.title) ? 'made' : null;
    if (!status) { skipped.push(`${filePath} › ${sec.title}`); continue; }
    for (const node of parseListTree(sec.lines)) {
      const d = dishFromNode(node, status, sweetFile);
      if (d) dishes.push({ ...d, source: `${filePath} › ${sec.title}` });
    }
  }
  return { dishes, skipped };
}

function dishFromNode(node, status, sweetFile) {
  let name = node.text;
  const favorite = STAR.test(name);
  name = stripMd(name.replace(STAR, ''));
  const sources = [];
  const link = name.match(MD_LINK_ONLY);
  if (link) { name = link[1]; sources.push({ url: link[2], star: true }); }
  if (!name || URL_ONLY.test(name)) return null;

  const acc = { ingredients: [], steps: [], notes: [], leaves: [], refs: [] };
  absorb(node.children, acc, sources);
  // References to recipe files can sit anywhere in the notes ("…refer to beef_bourguignon.md").
  (function scan(nodes) {
    for (const n of nodes) {
      const f = n.text.match(/([\w.-]+\.md)\b/)?.[1];
      if (f) acc.refs.push(f);
      if (/refer to (?:the )?markdown/i.test(n.text)) acc.refs.push('@self');
      scan(n.children);
    }
  }(node.children));
  acc.refs = [...new Set(acc.refs)];

  // A bare list of short words with no link ("Burrito: Bacon, Cheese, …") is an ingredient list.
  if (!acc.ingredients.length && !sources.length && acc.leaves.length >= 2 && acc.leaves.every((l) => l.length <= 40 && !/[.!?]$/.test(l))) {
    acc.ingredients = acc.leaves.map(stripMd);
  } else {
    acc.notes.unshift(...acc.leaves.map((l) => `- ${l}`));
  }

  const preferred = sources.find((s) => s.star) || sources[0];
  const others = sources.filter((s) => s !== preferred);
  if (others.length) {
    acc.notes.push('- Other sources:');
    for (const s of others) {
      acc.notes.push(`  - ${s.url}`);
      acc.notes.push(...(s.notes || []).map((l) => `    ${l}`));
    }
  }
  const notes = [...(preferred?.notes || []), ...acc.notes].join('\n').trim();

  let category = guessCategory(name, acc.ingredients);
  if (sweetFile && !['Baking', 'Desserts', 'Drinks', 'Breakfast'].includes(category)) category = 'Desserts';
  // In the savoury journal a "cake" is usually e.g. fried carrot cake, not a bake.
  if (!sweetFile && category === 'Desserts') category = 'Mains';
  if (!sweetFile && category === 'Baking' && !/bread|bun|naan|pizza|focaccia|roll|loaf|bagel|pastry|pie|quiche|tart|biscuit|scone|pretzel/i.test(name)) category = 'Mains';
  return {
    name, favorite, status, category,
    recipeUrl: preferred?.url || '',
    ingredients: acc.ingredients,
    instructions: acc.steps.join('\n'),
    notes,
    refs: acc.refs,
  };
}

/** Sort a dish's (or a source's) child bullets into ingredients / steps / notes / sources. */
function absorb(children, acc, sources, currentSource = null) {
  for (const child of children) {
    const star = STAR.test(child.text);
    const t = child.text.replace(STAR, '').trim();
    const plain = stripMd(t);
    const url = t.match(URL_ONLY)?.[1] || t.match(MD_LINK_ONLY)?.[2];
    const ref = t.match(/([\w.-]+\.md)\b/)?.[1] || (/refer to (?:the )?markdown/i.test(t) ? '@self' : null);
    if (ref) acc.refs.push(ref);

    if (url && !currentSource) {
      const src = { url, star, notes: [] };
      sources.push(src);
      // Notes under a link describe making it from that source; they may also hold a full recipe.
      const sub = { ingredients: [], steps: [], notes: [], leaves: [], refs: [] };
      absorb(child.children, sub, sources, src);
      acc.ingredients.push(...sub.ingredients);
      acc.steps.push(...sub.steps);
      acc.refs.push(...sub.refs);
      src.notes.push(...sub.leaves.map((l) => `- ${l}`), ...sub.notes);
    } else if (ING_LABEL.test(plain)) {
      acc.ingredients.push(...flattenLeaves(child.children));
    } else if (METHOD_LABEL.test(plain)) {
      acc.steps.push(...flattenLeaves(child.children));
    } else if (NOTES_LABEL.test(plain)) {
      acc.notes.push(...renderTree(child.children));
    } else if (!child.children.length) {
      if (ref === '@self' && /^refer to (?:the )?markdown\.?$/i.test(plain)) continue; // pure pointer, resolved later
      acc.leaves.push(t);
    } else {
      // A named sub-part ("Chocolate glaze", "Pro-tips"): keep it as nested notes.
      acc.notes.push(`- ${t}`, ...renderTree(child.children, 1));
    }
  }
}

// ============================================================ IMPORT: a single recipe document
const humanise = (file) => {
  const s = path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Our own exported recipe files (front matter) or any free-form recipe markdown. */
export function parseRecipeDoc(text, filePath) {
  const { data, body } = parseFrontMatter(text);
  const sections = splitSections(body);

  if (data?.name) {
    const get = (re) => sections.find((s) => re.test(s.title));
    const ingSec = get(/^ingredients?$/i);
    const methodSec = get(/^method$/i);
    const notesIdx = sections.findIndex((s) => /^notes$/i.test(s.title));
    const notes = notesIdx >= 0
      ? body.split(/\r?\n/).slice(sections[notesIdx].start + 1).join('\n').trim().replace(/^_No notes\._$/, '')
      : '';
    const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
    return {
      name: String(data.name),
      category: CATEGORIES.includes(data.category) ? data.category : null,
      status: data.status === 'wishlist' ? 'wishlist' : 'made',
      favorite: data.favorite === true,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      madeOn: typeof data.made_on === 'string' ? data.made_on : '',
      recipeUrl: typeof data.source === 'string' ? data.source : '',
      imageUrl: typeof data.image === 'string' ? data.image : '',
      ingredients: (ingSec?.lines || []).map((l) => l.replace(/^\s*[-*+]\s+/, '').trim()).filter((l) => l && !/^_None recorded\._$/.test(l)),
      instructions: (methodSec?.lines || []).map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim()).filter((l) => l && !/^_None recorded\._$/.test(l)).join('\n'),
      notes,
      photoRefs: (Array.isArray(data.photos) ? data.photos : []).map((p) => path.posix.normalize(path.posix.join(dir, String(p)))),
      createdAt: typeof data.created === 'string' ? data.created : null,
      updatedAt: typeof data.updated === 'string' ? data.updated : null,
      origin: 'export',
    };
  }

  // ---- free-form recipe markdown
  const title = stripMd((body.match(/^#\s+(.+)$/m)?.[1] || humanise(filePath)).replace(/[⭐\p{Extended_Pictographic}]/gu, ''));
  const ingIdx = sections.findIndex((s) => /ingredient/i.test(s.title));
  const methodIdx = sections.findIndex((s) => /instruction|method|direction|steps|procedure|how to make/i.test(s.title));
  let ingredients = [];
  let steps = [];
  const notes = [];

  const sectionBlock = (idx) => {
    // The section plus any deeper sub-sections ("#### Coffee Syrup") that follow it.
    const out = [];
    const lvl = sections[idx].level;
    for (let i = idx; i < sections.length; i++) {
      if (i > idx && sections[i].level <= lvl) break;
      if (i > idx) out.push({ head: stripMd(sections[i].title) });
      out.push(...sections[i].lines.map((l) => ({ line: l })));
    }
    return out;
  };
  const used = new Set();
  const markUsed = (idx) => { const lvl = sections[idx].level; for (let i = idx; i < sections.length; i++) { if (i > idx && sections[i].level <= lvl) break; used.add(i); } };

  if (ingIdx >= 0) {
    for (const b of sectionBlock(ingIdx)) {
      if (b.head) { ingredients.push(/:$/.test(b.head) ? b.head : `${b.head}:`); continue; }
      const l = stripMd(b.line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^▢\s*/, ''));
      if (l && l !== '---') ingredients.push(l);
    }
    markUsed(ingIdx);
  }
  if (methodIdx >= 0) {
    for (const b of sectionBlock(methodIdx)) {
      if (b.head) { const h = b.head.replace(/^\d+[.)]\s*/, ''); steps.push(/[:.]$/.test(h) ? h : `${h}:`); continue; }
      const l = stripMd(b.line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
      if (l && l !== '---') steps.push(l);
    }
    markUsed(methodIdx);
  }
  if (ingIdx < 0 && methodIdx < 0) {
    // No markdown headings (e.g. "📦 Ingredients:" style): use the plain-text parser.
    const parsed = parseRecipeText(body.replace(/^#.*$/gm, '').replace(/\*\*/g, ''));
    ingredients = parsed.ingredients;
    steps = parsed.steps;
    const noteStart = body.split(/\r?\n/).findIndex((l) => /^\W*notes?\s*:?\s*$/i.test(l));
    if (noteStart >= 0) {
      for (const l of body.split(/\r?\n/).slice(noteStart + 1)) {
        if (/^\s*---\s*$/.test(l)) break;
        if (l.trim()) notes.push(`- ${stripMd(l.replace(/^\s*[-*+]\s+/, ''))}`);
      }
    }
  } else {
    // Preamble ("Serves: 4–6", "Prep Time: …") and any other sections become notes.
    const pre = sections[0]?.level === 0 ? sections[0].lines.map((l) => l.trim()).filter((l) => l && l !== '---') : [];
    notes.push(...pre.map((l) => (/^[-*+]\s/.test(l) ? l : `- ${stripMd(l)}`)));
    sections.forEach((s, i) => {
      if (used.has(i) || s.level === 0 || s.level === 1) return;
      const content = s.lines.map((l) => l.trimEnd()).filter((l) => l.trim() && l.trim() !== '---');
      if (!content.length) return;
      notes.push(`- ${stripMd(s.title)}`, ...content.map((l) => (/^\s*[-*+]\s/.test(l) ? `  ${l.trim()}` : `  - ${stripMd(l.trim())}`)));
    });
  }

  return {
    name: title || humanise(filePath),
    category: null,
    status: 'made',
    favorite: false,
    tags: [],
    madeOn: '',
    recipeUrl: '',
    imageUrl: '',
    ingredients: ingredients.filter(Boolean),
    instructions: steps.filter(Boolean).join('\n'),
    notes: notes.join('\n'),
    photoRefs: [],
    origin: 'recipe',
  };
}

function splitSections(body) {
  const lines = String(body).split(/\r?\n/);
  const sections = [{ level: 0, title: '', lines: [], start: -1 }];
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) sections.push({ level: h[1].length, title: stripMd(h[2]).replace(/^[\p{Extended_Pictographic}️\s]+/u, ''), lines: [], start: i });
    else sections[sections.length - 1].lines.push(line);
  });
  return sections;
}

// ============================================================ IMPORT: photos
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
export const isImagePath = (p) => IMAGE_EXT.test(p);

/**
 * Group image paths by dish folder: …/Pictures/<Dish>/[<attempt>/]<file>.
 * Also reads dates from camera-style file names (20240818_130813.jpg, IMG_20240818…).
 */
function photoFolders(imagePaths) {
  const map = new Map();
  for (const p of imagePaths) {
    const parts = p.replace(/\\/g, '/').split('/');
    const i = parts.findIndex((s) => /^(pictures|photos|images)$/i.test(s));
    if (i < 0 || parts.length < i + 3) continue;
    const dish = parts[i + 1];
    const attempt = parts.length > i + 3 ? parts[i + 2] : null;
    const d = parts[parts.length - 1].match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[_\-T ]|\d{6}|\.)/);
    const date = d && +d[2] >= 1 && +d[2] <= 12 && +d[3] >= 1 && +d[3] <= 31 ? `${d[1]}-${d[2]}-${d[3]}` : null;
    if (!map.has(dish)) map.set(dish, { dish, files: [] });
    map.get(dish).files.push({ path: p, attempt, date });
  }
  for (const f of map.values()) f.files.sort((a, b) => a.path.localeCompare(b.path));
  return map;
}

/** Up to `cap` photos spread evenly over all attempts, always keeping the last one. */
function samplePhotos(files, cap) {
  if (!cap || files.length <= cap) return files.map((f) => f.path);
  const out = [];
  for (let i = 0; i < cap; i++) out.push(files[Math.round((i * (files.length - 1)) / (cap - 1))].path);
  return [...new Set(out)];
}

function madeHistory(files) {
  const byAttempt = new Map();
  for (const f of files) {
    const key = f.attempt || f.date || 'x';
    const cur = byAttempt.get(key);
    if (f.date && (!cur || f.date < cur)) byAttempt.set(key, f.date);
    else if (!byAttempt.has(key)) byAttempt.set(key, null);
  }
  const dates = [...byAttempt.values()].filter(Boolean).sort();
  return { times: byAttempt.size, dates, last: dates[dates.length - 1] || null };
}

// ============================================================ IMPORT: putting it together
/**
 * @param files      [{path, text}] markdown files (paths relative to the chosen folder/zip)
 * @param imagePaths every image path that came with them
 * @param existing   the user's current entries (for duplicate detection)
 * @param maxPhotos  photos to keep per dish (0 = all)
 */
export function buildImportPreview({ files, imagePaths = [], existing = [], maxPhotos = 12 }) {
  const skipped = [];
  const journals = [];
  const recipeDocs = [];

  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    const text = String(f.text);
    if (text.includes(MARK('readme')) || text.includes(MARK('category')) || /(^|\/)categories\//i.test(p) || /(^|\/)readme\.md$/i.test(p)) {
      skipped.push(`${p} (index/category list; nothing to import)`);
      continue;
    }
    const { data } = parseFrontMatter(text);
    const isRecipeFolder = /(^|\/)recipes?( in markdown)?\//i.test(p);
    const hasDishSections = /^##\s+.*\b(made|cooked|baked|wish ?list|kiv|to try)\b/im.test(text);
    if (data?.name || (isRecipeFolder && !hasDishSections)) recipeDocs.push({ path: p, doc: parseRecipeDoc(text, p) });
    else if (hasDishSections || text.includes(MARK('journal'))) journals.push({ path: p, ...parseJournal(text, p) });
    else if (/^#{2,}\s+.*ingredient/im.test(text) || /^\W*ingredients?\s*:?\s*$/im.test(text)) recipeDocs.push({ path: p, doc: parseRecipeDoc(text, p) });
    else skipped.push(`${p} (no recipes or dish lists found)`);
  }

  const items = [];
  const exportDocs = recipeDocs.filter((r) => r.doc.origin === 'export');
  const freeDocs = recipeDocs.filter((r) => r.doc.origin !== 'export');
  const usedDocs = new Set();

  // Our own export: the recipe files are the full record; journal bullets just point at them.
  for (const r of exportDocs) items.push({ ...r.doc, source: r.path });

  for (const j of journals) {
    skipped.push(...j.skipped.map((s) => `${s} (section isn't a list of dishes)`));
    for (const d of j.dishes) {
      if (exportDocs.some((r) => d.refs.some((ref) => r.path.endsWith(ref)) || r.doc.name === d.name)) continue;
      // "Refer to markdown" / "beef_bourguignon.md": pull in the full recipe when it's the same dish.
      const doc = freeDocs.find((r) => !usedDocs.has(r) && (
        d.refs.some((ref) => ref !== '@self' && path.posix.basename(r.path).toLowerCase() === ref.toLowerCase() && similarNames(r.doc.name, d.name))
        || (d.refs.includes('@self') && (similarNames(r.doc.name, d.name) || slugify(path.posix.basename(r.path, '.md')) === slugify(d.name)))
        || (d.refs.length && similarNames(r.doc.name, d.name))
        // Same dish name with no explicit pointer (e.g. "Genmaicha panna cotta" + genmaicha_panna_cotta.md).
        || normName(r.doc.name) === normName(d.name)));
      const item = { ...d, source: d.source };
      if (doc) {
        usedDocs.add(doc);
        if (!item.ingredients.length) item.ingredients = doc.doc.ingredients;
        if (!item.instructions) item.instructions = doc.doc.instructions;
        item.notes = [item.notes, doc.doc.notes && `Notes from ${path.posix.basename(doc.path)}:\n${doc.doc.notes}`].filter(Boolean).join('\n');
        item.source += ` + ${doc.path}`;
      }
      delete item.refs;
      items.push(item);
    }
  }
  for (const r of freeDocs) if (!usedDocs.has(r)) items.push({ ...r.doc, source: r.path });

  // ---- photos
  const folders = photoFolders(imagePaths);
  const imageSet = new Set(imagePaths.map((p) => p.replace(/\\/g, '/')));
  const claimed = new Set();
  for (const item of items) {
    if (item.photoRefs?.length) {
      item.photos = item.photoRefs.filter((p) => imageSet.has(p) || [...imageSet].some((x) => x.endsWith('/' + p)))
        .map((p) => (imageSet.has(p) ? p : [...imageSet].find((x) => x.endsWith('/' + p))));
      item.photos.forEach((p) => claimed.add(p.split('/').slice(0, -1).join('/')));
      for (const f of folders.values()) if (f.files.some((x) => item.photos.includes(x.path))) f.claimed = true;
      continue;
    }
    item.photos = [];
  }
  // Match photo folders to dishes pass by pass (strict first); a folder only matches when
  // exactly one dish without photos fits, so "Cannoli" never lands on "Cannelloni".
  for (const pass of MATCH_PASSES) {
    for (const folder of folders.values()) {
      if (folder.claimed) continue;
      const hits = items.filter((it) => !it.photos.length && !it.photoClaimed && pass(folder.dish, it.name));
      if (hits.length !== 1) continue;
      folder.claimed = true;
      hits[0].photoClaimed = true;
      applyPhotoFolder(hits[0], folder, maxPhotos);
      if (normName(folder.dish) !== normName(hits[0].name)) hits[0].photoFolder = folder.dish;
    }
  }
  // Dishes that only exist as a photo folder.
  for (const f of folders.values()) {
    if (f.claimed) continue;
    const item = { name: f.dish, category: guessCategory(f.dish, []), status: 'made', favorite: false, tags: [], madeOn: '', recipeUrl: '', imageUrl: '', ingredients: [], instructions: '', notes: '', source: `Pictures/${f.dish} (photos only)`, origin: 'photos', photos: [] };
    applyPhotoFolder(item, f, maxPhotos);
    items.push(item);
  }

  // ---- finishing touches + duplicates
  const existingByName = new Map(existing.map((e) => [normName(e.name), e]));
  const seen = new Map();
  items.forEach((item, i) => {
    item.key = `i${i}`;
    if (!item.category || !CATEGORIES.includes(item.category)) item.category = guessCategory(item.name, item.ingredients);
    if (!item.tags?.length) item.tags = suggestTags({ name: item.name, ingredients: item.ingredients });
    const dup = existingByName.get(normName(item.name));
    item.duplicateOf = dup ? { id: dup.id, name: dup.name } : null;
    const twin = seen.get(normName(item.name));
    item.duplicateInImport = twin || null;
    if (!twin) seen.set(normName(item.name), item.name);
    delete item.photoRefs;
    delete item.photoClaimed;
  });
  return { items, skipped };
}

function applyPhotoFolder(item, folder, maxPhotos) {
  item.photos = samplePhotos(folder.files, maxPhotos);
  item.photoTotal = folder.files.length;
  const h = madeHistory(folder.files);
  if (!item.madeOn && h.last) item.madeOn = h.last;
  if (h.times > 1 && h.dates.length) {
    item.notes = [item.notes, `- Made ${h.times} times (from photo dates): ${h.dates.map(fmtDate).join(', ')}`].filter(Boolean).join('\n');
  }
}
