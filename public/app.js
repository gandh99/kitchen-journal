// Kitchen Journal — single-page frontend (no build step).
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');

const state = {
  user: null,
  categories: [],
  query: '',
  tab: 'All',
  pendingImport: null, // recipe URL to auto-import when the editor opens
  pendingRecipe: null, // already-parsed recipe (from the Clip bookmarklet) for the editor
  afterLogin: null,    // hash to return to after signing in
};

const EMOJI = { Mains: '🍲', Baking: '🥖', Desserts: '🍰', 'Soups & Salads': '🥗', Breakfast: '🥞', 'Snacks & Sides': '🥟', Drinks: '🍹', Other: '🍽️' };

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    if (res.status === 401 && state.user && !path.startsWith('/auth')) { state.user = null; location.hash = '#/login'; }
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${label}`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function youtubeId(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function coverImg(e) {
  const src = e.photos?.[0]?.url || e.imageUrl;
  return src
    ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(EMOJI[e.category] || '🍽️')}">`
    : (EMOJI[e.category] || '🍽️');
}

// Broken external image -> category emoji.
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img.tagName === 'IMG' && img.dataset.fallback) {
    const span = document.createElement('span');
    span.textContent = img.dataset.fallback;
    img.replaceWith(span);
  }
}, true);

// Lightbox
const lightbox = document.getElementById('lightbox');
lightbox.addEventListener('click', () => { lightbox.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lightbox.hidden = true; });
function openLightbox(src) { lightbox.querySelector('img').src = src; lightbox.hidden = false; }

// ------------------------------------------------------------------ layout
function renderTopbar(active) {
  topbar.hidden = false;
  if (!state.user) {
    topbar.innerHTML = `<div class="topbar-inner">
      <a class="brand" href="#/">🍳 Kitchen Journal</a><div class="nav"></div>
      <div class="user-menu"><a class="btn btn-sm" href="#/login">Sign in</a><a class="btn btn-sm btn-primary" href="#/register">Create account</a></div>
    </div>`;
    topbar.querySelectorAll('.user-menu a').forEach((a) => a.addEventListener('click', () => { state.afterLogin = location.hash; }));
    return;
  }
  const link = (href, key, label) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  topbar.innerHTML = `<div class="topbar-inner">
    <a class="brand" href="#/">🍳 Kitchen Journal</a>
    <nav class="nav">
      ${link('#/', 'kitchen', 'My Kitchen')}
      ${link('#/spotlight', 'spotlight', '🌟 Spotlight')}
      ${link('#/cook', 'cook', 'What can I cook?')}
      ${link('#/community', 'community', 'Community')}
    </nav>
    <div class="user-menu"><a href="#/data" class="${active === 'data' ? 'active' : ''}" title="Import & export Markdown">⇅ Import / Export</a><span>@${esc(state.user.username)}</span><button class="btn-sm btn-ghost" id="logout">Sign out</button></div>
  </div>`;
  topbar.querySelector('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null; state.query = ''; state.tab = 'All';
    location.hash = '#/login';
  });
}

function entryCard(e, href) {
  return `<a class="entry-card" href="${href}">
    <div class="cover">${coverImg(e)}${e.favorite ? '<span class="fav-badge" title="Favourite">⭐</span>' : ''}${e.status === 'wishlist' ? '<span class="wish-badge">📝 Want to try</span>' : ''}</div>
    <div class="body">
      <h3>${esc(e.name)}</h3>
      <div class="meta">${esc(e.category)}${e.madeOn && e.status !== 'wishlist' ? ` · made ${esc(fmtDate(e.madeOn))}` : ''}</div>
      <div class="tags">${e.tags.slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
  </a>`;
}

/** Category tabs + grid; used by "My Kitchen" and shared collections. */
function paintCollection({ tabsEl, resultsEl, entries, hrefFor, emptyHtml }) {
  // Two filter tabs on top of the category tabs.
  const SPECIAL = { '★': { label: '⭐ Favourites', test: (e) => e.favorite }, wishlist: { label: '📝 Want to try', test: (e) => e.status === 'wishlist' } };
  const counts = { All: entries.length };
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  for (const [k, s] of Object.entries(SPECIAL)) counts[k] = entries.filter(s.test).length;
  if (state.tab !== 'All' && !counts[state.tab]) state.tab = 'All';
  const tabs = ['All', ...Object.keys(SPECIAL).filter((k) => counts[k]), ...state.categories.filter((c) => counts[c])];
  tabsEl.innerHTML = tabs.map((t) => `<button class="tab ${state.tab === t ? 'active' : ''} ${SPECIAL[t] ? 'special' : ''}" data-tab="${esc(t)}">
    ${t === 'All' ? 'All' : SPECIAL[t] ? SPECIAL[t].label : `${EMOJI[t] || ''} ${esc(t)}`} <span class="n">${counts[t] || 0}</span></button>`).join('');
  tabsEl.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    paintCollection({ tabsEl, resultsEl, entries, hrefFor, emptyHtml });
  }));
  const shown = state.tab === 'All' ? entries
    : SPECIAL[state.tab] ? entries.filter(SPECIAL[state.tab].test)
      : entries.filter((e) => e.category === state.tab);
  resultsEl.innerHTML = shown.length
    ? `<div class="grid">${shown.map((e) => entryCard(e, hrefFor(e))).join('')}</div>`
    : emptyHtml;
}

// ------------------------------------------------------------------ router
let navId = 0;
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, qs] = raw.split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(qs || '') };
}

async function router() {
  const my = ++navId;
  const alive = () => my === navId;
  const { parts, params } = parseHash();
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 's' && parts[1]) {
      return parts[2] ? await renderSharedEntry(parts[1], parts[2], alive) : await renderShared(parts[1], params, alive);
    }
    if (!state.user) {
      if (!['login', 'register'].includes(parts[0])) { state.afterLogin = location.hash; location.hash = '#/login'; return; }
      return renderAuth(parts[0]);
    }
    switch (parts[0]) {
      case undefined: return await renderKitchen(params, alive);
      case 'login': case 'register': location.hash = '#/'; return;
      case 'new': return await renderEditor(null, alive, params);
      case 'entry': return parts[2] === 'edit' ? await renderEditor(parts[1], alive, params) : await renderEntry(parts[1], alive);
      case 'clip': return renderClip(alive);
      case 'data': return renderData(alive);
      case 'spotlight':
        return parts[2] === 's' && parts[3]
          ? await renderSubmission(parts[1], parts[3], alive)
          : await renderSpotlight(parts[1], alive);
      case 'cook': return renderCook();
      case 'community': return await renderCommunity(alive);
      default: location.hash = '#/';
    }
  } catch (err) {
    if (!alive()) return;
    app.innerHTML = `<div class="empty"><div class="big">🥄</div><h2>${esc(err.message)}</h2><p><a href="#/">Back to my kitchen</a></p></div>`;
  }
}

// ------------------------------------------------------------------ auth
function renderAuth(mode) {
  const isLogin = mode !== 'register';
  topbar.hidden = true;
  app.innerHTML = `<div class="auth-wrap"><div class="card auth-card stack">
    <div class="auth-hero">🍳</div>
    <h1 class="center">${isLogin ? 'Welcome back' : 'Start your kitchen journal'}</h1>
    <p class="muted center">Track everything you cook and bake.</p>
    <form id="auth-form" class="stack">
      <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required minlength="3" maxlength="30"></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="${isLogin ? 1 : 8}">
        ${isLogin ? '' : '<div class="hint">At least 8 characters.</div>'}</label>
      <button class="btn-primary" style="width:100%;justify-content:center">${isLogin ? 'Sign in' : 'Create account'}</button>
    </form>
    <p class="center muted">${isLogin ? 'New here? <a href="#/register">Create an account</a>' : 'Already have an account? <a href="#/login">Sign in</a>'}</p>
  </div></div>`;
  const form = app.querySelector('#auth-form');
  form.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    await busy(btn, async () => {
      try {
        const { user } = await api(`/auth/${isLogin ? 'login' : 'register'}`, {
          method: 'POST', body: { username: form.username.value, password: form.password.value },
        });
        state.user = user;
        const dest = state.afterLogin && !/^#\/(login|register)/.test(state.afterLogin) ? state.afterLogin : '#/';
        state.afterLogin = null;
        if (location.hash === dest) router(); else location.hash = dest;
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ------------------------------------------------------------------ my kitchen
async function renderKitchen(params, alive) {
  if (params.has('q')) { state.query = params.get('q'); state.tab = 'All'; history.replaceState(null, '', '#/'); }
  renderTopbar('kitchen');
  app.innerHTML = `<div class="stack">
    <div class="row spread">
      <div><h1>My Kitchen</h1><p class="muted" id="subtitle" style="margin:0">&nbsp;</p></div>
      <a class="btn btn-primary" href="#/new">＋ New entry</a>
    </div>
    <div class="search"><input type="search" id="q" placeholder="Search dishes, ingredients or tags, e.g. Chicken" value="${esc(state.query)}" aria-label="Search"></div>
    <div class="tabs" id="tabs"></div>
    <div id="results"><p class="muted center pad">Loading…</p></div>
  </div>`;
  const q = app.querySelector('#q');

  const load = async () => {
    const { entries } = await api(`/entries?q=${enc(state.query)}`);
    if (!alive()) return;
    app.querySelector('#subtitle').textContent = state.query
      ? `${entries.length} result${entries.length === 1 ? '' : 's'} for “${state.query}”`
      : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
    paintCollection({
      tabsEl: app.querySelector('#tabs'),
      resultsEl: app.querySelector('#results'),
      entries,
      hrefFor: (e) => `#/entry/${e.id}`,
      emptyHtml: state.query
        ? `<div class="empty"><div class="big">🔍</div><p>Nothing matches “${esc(state.query)}”.</p>
            <p>Want ideas instead? <a href="#/cook">Find recipes by ingredient</a></p></div>`
        : `<div class="empty"><div class="big">🧑‍🍳</div><h2>Your kitchen journal is empty</h2>
            <p>Log the first thing you cooked or baked. Paste a recipe link and the ingredients and tags fill themselves in.</p>
            <p><a class="btn btn-primary" href="#/new">＋ Add your first entry</a></p></div>`,
    });
  };
  q.addEventListener('input', debounce(() => { state.query = q.value.trim(); load().catch((e) => toast(e.message, 'error')); }, 250));
  if (state.query) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  await load();
}

// ------------------------------------------------------------------ entry detail
function entryDetailHtml(e, { back, actions = '', tagHref, banner = '', favToggle = false }) {
  const video = youtubeId(e.recipeUrl);
  // With a video, the YouTube thumbnail would just duplicate the player.
  const images = [...e.photos.map((p) => p.url), ...(e.imageUrl && !video ? [e.imageUrl] : [])];
  const steps = e.instructions.split('\n').map((s) => s.trim()).filter(Boolean);
  const spot = e.spotlight || { featured: [], submitted: [] };
  const spotBadges = [
    ...spot.featured.map((s) => `<a class="tag gold" href="#/spotlight/${esc(s.week)}">🌟 Featured in Spotlight · ${esc(s.label)}</a>`),
    ...spot.submitted.map((s) => `<a class="tag gold" href="#/spotlight/${esc(s.week)}">🍳 Cook-along: ${esc(s.name)}</a>`),
  ].join('');
  return `<a class="back" href="${back.href}">← ${esc(back.label)}</a>
  <div class="stack">
    <div class="detail-head">
      <div>
        <h1>${esc(e.name)}${favToggle === false && e.favorite ? ' <span title="Favourite">⭐</span>' : ''}</h1>
        <div class="row meta">
          <span class="tag plain">${EMOJI[e.category] || ''} ${esc(e.category)}</span>
          ${e.status === 'wishlist' ? '<span class="tag gold">📝 Want to try</span>' : ''}
          ${e.madeOn && e.status !== 'wishlist' ? `<span>Made ${esc(fmtDate(e.madeOn))}</span>` : ''}
          <span>Updated ${esc(fmtDate(e.updatedAt))}</span>
        </div>
      </div>
      <div class="row">${actions}</div>
    </div>
    ${banner}
    ${spotBadges ? `<div class="tags">${spotBadges}</div>` : ''}
    ${e.tags.length ? `<div class="tags">${e.tags.map((t) => `<a class="tag" href="${tagHref(t)}" title="Show everything tagged ${esc(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
    ${images.length ? `<div class="gallery">
      <div class="main"><img id="main-img" src="${esc(images[0])}" alt="${esc(e.name)}" referrerpolicy="no-referrer" data-fallback="${esc(EMOJI[e.category] || '🍽️')}"></div>
      ${images.length > 1 ? `<div class="thumbs">${images.map((src, i) => `<img src="${esc(src)}" alt="" class="${i === 0 ? 'on' : ''}" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
    </div>` : ''}
    ${video ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${video}" title="Recipe video" loading="lazy"
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>` : ''}
    <div class="detail-grid">
      <div class="card">
        <h2>Ingredients</h2>
        ${e.ingredients.length
          ? `<ul class="ingredients">${e.ingredients.map((i) => `<li><label><input type="checkbox"><span>${esc(i)}</span></label></li>`).join('')}</ul>`
          : '<p class="muted">No ingredients recorded.</p>'}
      </div>
      <div class="stack">
        ${steps.length ? `<div class="card"><h2>Method</h2>${steps.length > 1
          ? `<ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : `<p class="prose">${esc(steps[0])}</p>`}</div>` : ''}
        ${e.notes ? `<div class="card"><h2>My notes</h2><p class="prose">${esc(e.notes)}</p></div>` : ''}
        ${e.recipeUrl ? `<div class="card"><h3>${video ? 'Original video' : 'Original recipe'}</h3><a href="${esc(e.recipeUrl)}" target="_blank" rel="noopener noreferrer">${esc(new URL(e.recipeUrl).hostname.replace(/^www\./, ''))} ↗</a></div>` : ''}
      </div>
    </div>
  </div>`;
}

function wireGallery() {
  const main = app.querySelector('#main-img');
  if (!main) return;
  main.parentElement.addEventListener('click', () => openLightbox(main.src));
  app.querySelectorAll('.gallery .thumbs img').forEach((t) => t.addEventListener('click', () => {
    main.src = t.src;
    app.querySelectorAll('.gallery .thumbs img').forEach((x) => x.classList.toggle('on', x === t));
  }));
}

async function renderEntry(id, alive) {
  renderTopbar('kitchen');
  const { entry } = await api(`/entries/${enc(id)}`);
  if (!alive()) return;
  app.innerHTML = entryDetailHtml(entry, {
    back: { href: '#/', label: 'My Kitchen' },
    actions: `<button class="fav-toggle ${entry.favorite ? 'on' : ''}" id="fav" aria-pressed="${entry.favorite}" title="Favourite">${entry.favorite ? '⭐ Favourite' : '☆ Favourite'}</button>
      <a class="btn btn-ghost" href="/api/entries/${entry.id}/markdown" download title="Download this recipe as a Markdown file">⬇ .md</a>
      <button class="btn-ghost btn-danger" id="del">Delete</button><a class="btn btn-primary" href="#/entry/${entry.id}/edit">✎ Edit</a>`,
    tagHref: (t) => `#/?q=${enc(t)}`,
    favToggle: true,
  });
  wireGallery();
  const favBtn = app.querySelector('#fav');
  favBtn.addEventListener('click', async () => {
    const next = !entry.favorite;
    try {
      await api(`/entries/${entry.id}/favorite`, { method: 'PATCH', body: { favorite: next } });
      entry.favorite = next;
      favBtn.classList.toggle('on', next);
      favBtn.setAttribute('aria-pressed', next);
      favBtn.textContent = next ? '⭐ Favourite' : '☆ Favourite';
    } catch (e) { toast(e.message, 'error'); }
  });
  app.querySelector('#del').addEventListener('click', async () => {
    if (!confirm(`Delete “${entry.name}”? Its photos will be removed too. This can't be undone.`)) return;
    try { await api(`/entries/${entry.id}`, { method: 'DELETE' }); toast('Entry deleted'); location.hash = '#/'; }
    catch (e) { toast(e.message, 'error'); }
  });
}

// ------------------------------------------------------------------ editor (create + update)
async function shrinkImage(file) {
  // Phone photos are huge; downscale big JPEG/PNG/WebP to max 2000px before upload.
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

/** javascript: bookmark that sends the current page (already loaded by the user's own browser) to the app. */
function bookmarkletHref() {
  const code = `(()=>{const A=${JSON.stringify(location.origin)};const w=window.open(A+'/#/clip','kjclip');`
    + `if(!w){alert('Please allow pop-ups for this site, then click the bookmark again.');return}`
    + `const ld=[...document.querySelectorAll('script[type="application/ld+json"]')].map(s=>s.outerHTML).join('');`
    + `const d={type:'kj-clip',url:location.href,html:ld+document.documentElement.outerHTML.slice(0,5e6)};let n=0;`
    + `const t=setInterval(()=>{try{w.postMessage(d,A)}catch(e){}if(++n>80)clearInterval(t)},250);`
    + `addEventListener('message',e=>{if(e.origin===A&&e.data==='kj-clip-ok')clearInterval(t)})})()`;
  return 'javascript:' + encodeURIComponent(code);
}

function clipHelpHtml() {
  return `<ol class="clip-steps">
    <li>Drag this button to your browser's bookmarks bar (press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> if the bar is hidden):
      <a class="btn btn-sm btn-primary bookmarklet" href="${bookmarkletHref()}" onclick="event.preventDefault();alert('Drag this button to your bookmarks bar instead of clicking it.')">📌 Clip to Kitchen Journal</a></li>
    <li>Open any recipe page in your browser as normal.</li>
    <li>Click the bookmark. A Kitchen Journal tab opens with the recipe filled in, ready to review and save.</li>
  </ol>
  <p class="hint">Because your own browser has already opened the page, this works on sites that block automatic imports.</p>`;
}

async function renderEditor(id, alive, params = new URLSearchParams()) {
  renderTopbar('kitchen');
  const entry = id ? (await api(`/entries/${enc(id)}`)).entry : null;
  if (!alive()) return;
  const spotWeek = /^\d{4}-W\d{2}$/.test(params.get('spotlight') || '') ? params.get('spotlight') : null;

  const ed = {
    suggested: [],
    added: entry ? [...entry.tags] : [],
    removed: new Set(),
    categoryTouched: !!entry,
    photos: entry ? entry.photos.map((p) => ({ ...p, remove: false })) : [],
    newFiles: [],
    imageUrl: entry?.imageUrl || '',
  };
  const currentTags = () => {
    const seen = new Set();
    return [...ed.added, ...ed.suggested.filter((t) => !ed.removed.has(t.toLowerCase()))]
      .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  };

  app.innerHTML = `<a class="back" href="${entry ? `#/entry/${entry.id}` : '#/'}">← ${entry ? 'Back to entry' : 'My Kitchen'}</a>
  <h1>${entry ? 'Edit entry' : 'New entry'}</h1>
  <form id="ed" class="stack" autocomplete="off">
    ${spotWeek ? `<div class="banner spot-banner stack">
      <div><strong>🌟 Cooking along with the Spotlight.</strong> Add photos of <em>your</em> version and tweak anything you changed. When you save, it's submitted to the Spotlight, where everyone signed in can see it.</div>
      <label class="field"><span>Caption for your submission <span class="muted" style="font-weight:400">(optional)</span></span>
        <input type="text" name="spotCaption" maxlength="280" placeholder="e.g. Added extra chilli and it was great"></label>
    </div>` : ''}
    <div class="import-box">
      <label class="field"><span>🔗 Recipe link or YouTube video <span class="muted" style="font-weight:400">(optional)</span></span></label>
      <div class="row">
        <input type="url" name="recipeUrl" placeholder="https://… paste a recipe page or YouTube link" value="${esc(entry?.recipeUrl || '')}">
        <button type="button" class="btn-primary" id="import">Import</button>
      </div>
      <div class="hint">Works with most recipe sites and with YouTube cooking videos (read from the description, or from the recipe page it links to).</div>
      <div id="import-help" class="import-help" hidden></div>
      <div class="row" style="margin-top:10px;gap:6px">
        <button type="button" class="btn-sm" id="show-paste">📋 Paste recipe text</button>
        <button type="button" class="btn-sm" id="show-clip">📌 Clip from your browser</button>
      </div>
      <div id="paste-panel" class="stack" style="margin-top:12px" hidden>
        <textarea id="paste-text" rows="8" placeholder="On the recipe page, select the ingredients and method (or press Ctrl+A to select the whole page), copy, then paste here."></textarea>
        <div class="row"><button type="button" class="btn-primary btn-sm" id="paste-go">Read ingredients from text</button></div>
      </div>
      <div id="clip-panel" style="margin-top:12px" hidden>${clipHelpHtml()}</div>
    </div>
    <div class="editor">
      <label class="field"><span>Name of the dish *</span><input type="text" name="name" required maxlength="200" placeholder="e.g. Pasta alla Bolognese" value="${esc(entry?.name || '')}"></label>
      <div class="row" style="gap:12px;align-items:flex-end">
        <label class="field" style="flex:1"><span>Category</span>
          <select name="category">${state.categories.map((c) => `<option ${c === (entry?.category || 'Mains') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field" style="flex:1"><span>Date made</span><input type="date" name="madeOn" value="${esc(entry?.madeOn || '')}"></label>
      </div>
      <div class="row full" style="gap:18px">
        <div class="seg" role="radiogroup" aria-label="Status">
          <label><input type="radio" name="status" value="made" ${entry?.status !== 'wishlist' ? 'checked' : ''}><span>🍳 Made it</span></label>
          <label><input type="radio" name="status" value="wishlist" ${entry?.status === 'wishlist' ? 'checked' : ''}><span>📝 Want to try</span></label>
        </div>
        <label class="check"><input type="checkbox" name="favorite" ${entry?.favorite ? 'checked' : ''}> ⭐ Favourite</label>
      </div>
      <div class="field full">
        <span style="display:block;font-weight:600;font-size:.88rem;margin-bottom:6px">Tags <span class="muted" style="font-weight:400">· suggested automatically, click × to remove, type to add</span></span>
        <div class="tag-editor" id="tag-editor"></div>
      </div>
      <label class="field"><span>Ingredients <span class="muted" style="font-weight:400">(one per line)</span></span>
        <textarea name="ingredients" rows="10" placeholder="500g beef mince&#10;200g pancetta&#10;1 onion…">${esc(entry?.ingredients.join('\n') || '')}</textarea></label>
      <label class="field"><span>Method</span>
        <textarea name="instructions" rows="10" placeholder="One step per line">${esc(entry?.instructions || '')}</textarea></label>
      <label class="field full"><span>My notes</span>
        <textarea name="notes" rows="3" placeholder="How did it turn out? What would you change next time?">${esc(entry?.notes || '')}</textarea></label>
      <div class="field full">
        <span style="display:block;font-weight:600;font-size:.88rem;margin-bottom:6px">Photos</span>
        <div class="photo-strip" id="photos"></div>
        <input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple hidden>
      </div>
    </div>
    <div class="sticky-actions row spread">
      <a class="btn btn-ghost" href="${entry ? `#/entry/${entry.id}` : '#/'}">Cancel</a>
      <button class="btn-primary" id="save">${entry ? 'Save changes' : 'Save entry'}</button>
    </div>
  </form>`;

  const form = app.querySelector('#ed');
  const tagEl = app.querySelector('#tag-editor');
  const photosEl = app.querySelector('#photos');
  const fileInput = app.querySelector('#file');

  // ---- tags
  function paintTags() {
    tagEl.innerHTML = currentTags().map((t) => `<span class="tag">${esc(t)}<button type="button" data-t="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')
      + '<input type="text" id="tag-input" placeholder="Add a tag…" maxlength="40">';
    tagEl.querySelectorAll('button[data-t]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.t.toLowerCase();
      ed.added = ed.added.filter((x) => x.toLowerCase() !== t);
      ed.removed.add(t);
      paintTags();
    }));
    const input = tagEl.querySelector('#tag-input');
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
        e.preventDefault();
        const t = input.value.trim().replace(/,$/, '');
        ed.added.push(t); ed.removed.delete(t.toLowerCase());
        paintTags();
        tagEl.querySelector('#tag-input').focus();
      } else if (e.key === 'Backspace' && !input.value) {
        const last = currentTags().pop();
        if (last) { ed.added = ed.added.filter((x) => x !== last); ed.removed.add(last.toLowerCase()); paintTags(); tagEl.querySelector('#tag-input').focus(); }
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) { ed.added.push(input.value.trim()); ed.removed.delete(input.value.trim().toLowerCase()); paintTags(); }
    });
  }
  paintTags();

  const lines = () => form.ingredients.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const refreshSuggestions = debounce(async () => {
    if (!form.name.value.trim() && !lines().length) return;
    try {
      const { tags, category } = await api('/tags/suggest', { method: 'POST', body: { name: form.name.value, ingredients: lines() } });
      ed.suggested = tags;
      if (!ed.categoryTouched) form.category.value = category;
      paintTags();
    } catch { /* non-critical */ }
  }, 450);
  form.name.addEventListener('input', refreshSuggestions);
  form.ingredients.addEventListener('input', refreshSuggestions);
  form.category.addEventListener('change', () => { ed.categoryTouched = true; });

  // ---- photos
  function paintPhotos() {
    const existing = ed.photos.map((p, i) => `<div class="photo-thumb ${p.remove ? 'removed' : ''}">
      <img src="${esc(p.url)}" alt=""><button type="button" data-ex="${i}" title="${p.remove ? 'Undo remove' : 'Remove photo'}">${p.remove ? '↺' : '×'}</button></div>`);
    const added = ed.newFiles.map((f, i) => `<div class="photo-thumb"><img src="${f.preview}" alt=""><button type="button" data-new="${i}" title="Remove">×</button></div>`);
    const recipe = ed.imageUrl ? [`<div class="photo-thumb" title="Photo from the recipe site"><img src="${esc(ed.imageUrl)}" alt="" referrerpolicy="no-referrer"><button type="button" data-recipe title="Remove">×</button></div>`] : [];
    photosEl.innerHTML = [...existing, ...added, ...recipe].join('')
      + '<div class="dropzone" id="drop" tabindex="0" role="button">📷<br>Add photos<br><small>or drop here</small></div>';
    photosEl.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => { const p = ed.photos[b.dataset.ex]; p.remove = !p.remove; paintPhotos(); }));
    photosEl.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => { URL.revokeObjectURL(ed.newFiles[b.dataset.new].preview); ed.newFiles.splice(b.dataset.new, 1); paintPhotos(); }));
    photosEl.querySelector('[data-recipe]')?.addEventListener('click', () => { ed.imageUrl = ''; paintPhotos(); });
    const drop = photosEl.querySelector('#drop');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  }
  function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast(`${f.name} isn't an image`, 'error'); continue; }
      f.preview = URL.createObjectURL(f);
      ed.newFiles.push(f);
    }
    paintPhotos();
  }
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  paintPhotos();

  // ---- importing (link, YouTube, pasted text, or clipped page)
  const importBtn = app.querySelector('#import');
  const helpEl = app.querySelector('#import-help');
  const pastePanel = app.querySelector('#paste-panel');
  const clipPanel = app.querySelector('#clip-panel');

  function applyRecipe(recipe) {
    if (recipe.name && (!form.name.value.trim() || (form.name.value.trim() !== recipe.name && confirm(`Replace the name with “${recipe.name}”?`)))) {
      form.name.value = recipe.name;
    }
    if (recipe.ingredients.length) form.ingredients.value = recipe.ingredients.join('\n');
    if (recipe.instructions && !form.instructions.value.trim()) form.instructions.value = recipe.instructions;
    if (recipe.notes && !form.notes.value.trim()) form.notes.value = recipe.notes;
    if (recipe.sourceUrl) form.recipeUrl.value = recipe.sourceUrl;
    if (recipe.imageUrl) ed.imageUrl = recipe.imageUrl;
    if (!ed.categoryTouched && recipe.category) form.category.value = recipe.category;
    if (recipe.tags?.length) ed.suggested = recipe.tags;
    paintTags(); paintPhotos();
    helpEl.hidden = true;
    if (recipe.warning) toast(recipe.warning, 'error');
    else toast(`Imported ${recipe.ingredients.length} ingredients${recipe.linkedRecipe ? ' from the recipe linked under the video' : ''}`);
    if (!recipe.ingredients.length || !recipe.name) refreshSuggestions();
  }

  async function doImport() {
    const url = form.recipeUrl.value.trim();
    if (!url) { toast('Paste a recipe link first', 'error'); form.recipeUrl.focus(); return; }
    helpEl.hidden = true;
    await busy(importBtn, async () => {
      try {
        applyRecipe((await api('/import', { method: 'POST', body: { url } })).recipe);
      } catch (e) {
        if (e.code === 'blocked') {
          helpEl.innerHTML = `<strong>⚠️ ${esc(e.message)}</strong>`;
          helpEl.hidden = false;
          clipPanel.hidden = false;
          pastePanel.hidden = false;
        } else toast(e.message, 'error');
      }
    });
  }
  importBtn.addEventListener('click', doImport);
  form.recipeUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doImport(); } });
  app.querySelector('#show-paste').addEventListener('click', () => { pastePanel.hidden = !pastePanel.hidden; if (!pastePanel.hidden) app.querySelector('#paste-text').focus(); });
  app.querySelector('#show-clip').addEventListener('click', () => { clipPanel.hidden = !clipPanel.hidden; });
  app.querySelector('#paste-go').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    const text = app.querySelector('#paste-text').value;
    try {
      applyRecipe((await api('/import/text', { method: 'POST', body: { text, url: form.recipeUrl.value.trim() } })).recipe);
      pastePanel.hidden = true;
      app.querySelector('#paste-text').value = '';
    } catch (e) { toast(e.message, 'error'); }
  }));

  if (!entry && state.pendingRecipe) {
    const r = state.pendingRecipe;
    state.pendingRecipe = null;
    applyRecipe(r);
  } else if (state.pendingImport && !entry) {
    form.recipeUrl.value = state.pendingImport;
    state.pendingImport = null;
    doImport();
  }

  // ---- save
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tagInput = tagEl.querySelector('#tag-input');
    if (tagInput?.value.trim()) { ed.added.push(tagInput.value.trim()); tagInput.value = ''; }
    const body = {
      name: form.name.value, category: form.category.value, madeOn: form.madeOn.value,
      status: form.status.value, favorite: form.favorite.checked,
      recipeUrl: form.recipeUrl.value.trim(), imageUrl: ed.imageUrl,
      ingredients: lines(), instructions: form.instructions.value, notes: form.notes.value, tags: currentTags(),
    };
    await busy(app.querySelector('#save'), async () => {
      let saved;
      try {
        saved = (entry
          ? await api(`/entries/${entry.id}`, { method: 'PUT', body })
          : await api('/entries', { method: 'POST', body })).entry;
      } catch (err) { toast(err.message, 'error'); return; }
      try {
        for (const p of ed.photos.filter((x) => x.remove)) await api(`/entries/${saved.id}/photos/${p.id}`, { method: 'DELETE' });
        if (ed.newFiles.length) {
          const fd = new FormData();
          for (const f of ed.newFiles) fd.append('photos', await shrinkImage(f));
          await api(`/entries/${saved.id}/photos`, { method: 'POST', form: fd });
        }
      } catch (err) {
        toast(`Entry saved, but photos failed: ${err.message}`, 'error');
        location.hash = `#/entry/${saved.id}/edit${spotWeek ? `?spotlight=${spotWeek}` : ''}`;
        return;
      }
      if (spotWeek) {
        try {
          await api(`/spotlight/${spotWeek}/submissions`, { method: 'POST', body: { entryId: saved.id, caption: form.spotCaption?.value || '' } });
          toast('Saved and submitted to the Spotlight 🌟');
          location.hash = `#/spotlight/${spotWeek}`;
        } catch (err) {
          toast(`Entry saved, but the Spotlight submission failed: ${err.message}`, 'error');
          location.hash = `#/entry/${saved.id}`;
        }
        return;
      }
      toast(entry ? 'Changes saved' : 'Entry added to your kitchen 🎉');
      location.hash = `#/entry/${saved.id}`;
    });
  });

  if (!entry) form.name.focus();
}

// ------------------------------------------------------------------ what can I cook?
function renderCook() {
  renderTopbar('cook');
  let items = store.get('kj:onhand', []);
  app.innerHTML = `<div class="stack">
    <div><h1>What can I cook?</h1><p class="muted">List what's in your fridge and pantry. We'll check your own entries and search online recipes.</p></div>
    <div class="card stack">
      <div class="tag-editor" id="items"></div>
      <div class="row spread">
        <span class="hint">Press Enter or comma after each ingredient. Salt, pepper, oil and water are assumed.</span>
        <div class="row"><button class="btn-ghost btn-sm" id="clear">Clear</button><button class="btn-primary" id="go">Find recipes</button></div>
      </div>
    </div>
    <div id="out"></div>
  </div>`;
  const itemsEl = app.querySelector('#items');
  const out = app.querySelector('#out');
  const go = app.querySelector('#go');

  function paint() {
    itemsEl.innerHTML = items.map((t, i) => `<span class="tag green">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')
      + '<input type="text" id="item-input" placeholder="e.g. chicken, rice, spinach, garlic">';
    itemsEl.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { items.splice(b.dataset.i, 1); store.set('kj:onhand', items); paint(); }));
    const input = itemsEl.querySelector('#item-input');
    const commit = () => {
      const parts = input.value.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const p of parts) if (!items.includes(p)) items.push(p);
      store.set('kj:onhand', items);
      input.value = '';
      paint();
      itemsEl.querySelector('#item-input').focus();
    };
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); commit(); }
      else if (e.key === 'Enter' && !input.value.trim() && items.length) { e.preventDefault(); search(); }
      else if (e.key === 'Backspace' && !input.value && items.length) { items.pop(); store.set('kj:onhand', items); paint(); itemsEl.querySelector('#item-input').focus(); }
    });
    input.addEventListener('paste', () => setTimeout(() => { if (/[,\n]/.test(input.value)) commit(); }));
  }
  paint();
  itemsEl.addEventListener('click', (e) => { if (e.target === itemsEl) itemsEl.querySelector('#item-input').focus(); });
  app.querySelector('#clear').addEventListener('click', () => { items = []; store.set('kj:onhand', items); out.innerHTML = ''; paint(); });

  const chips = (arr, cls = 'green') => arr.map((m) => `<span class="tag ${cls}">${esc(m)}</span>`).join('');

  async function search() {
    const pending = itemsEl.querySelector('#item-input').value.trim();
    if (pending) { pending.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((p) => items.includes(p) || items.push(p)); store.set('kj:onhand', items); paint(); }
    if (!items.length) { toast('Add at least one ingredient', 'error'); return; }
    out.innerHTML = '<p class="muted center pad"><span class="spinner"></span> Looking through your kitchen and the web…</p>';
    await busy(go, async () => {
      try {
        const r = await api('/suggest', { method: 'POST', body: { items } });
        out.innerHTML = `<div class="cook-cols">
          <section class="stack">
            <h2>From your kitchen <span class="muted" style="font-size:.9rem;font-family:var(--sans)">${r.mine.length}</span></h2>
            ${r.mine.length ? `<div class="result-list">${r.mine.map((m) => `<div class="result">
                <a class="thumb" href="#/entry/${m.entry.id}">${coverImg(m.entry)}</a>
                <div>
                  <h3><a href="#/entry/${m.entry.id}">${esc(m.entry.name)}</a></h3>
                  ${m.entry.ingredients.length ? `<div class="bar" title="${Math.round(m.coverage * 100)}% of ingredients on hand"><i style="width:${Math.round(m.coverage * 100)}%"></i></div>` : ''}
                  <div class="tags">${chips(m.matched)}</div>
                  ${m.missingCount ? `<p class="meta" style="margin:6px 0 0">Also needs: ${esc(m.missing.join(', '))}${m.missingCount > m.missing.length ? ` +${m.missingCount - m.missing.length} more` : ''}</p>` : (m.entry.ingredients.length ? '<p class="meta" style="margin:6px 0 0">✅ You have everything!</p>' : '')}
                </div></div>`).join('')}</div>`
              : '<div class="banner muted">None of your entries use these yet.</div>'}
          </section>
          <section class="stack">
            <h2>From the web <span class="muted" style="font-size:.9rem;font-family:var(--sans)">${r.online.length}</span></h2>
            ${r.onlineError ? `<div class="banner muted">${esc(r.onlineError)}</div>` : ''}
            ${r.online.length ? `<div class="result-list">${r.online.map((m) => `<div class="result">
                <a class="thumb" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(m.thumb)}" alt="" loading="lazy" data-fallback="🍽️"></a>
                <div>
                  <h3><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.name)} ↗</a></h3>
                  <div class="meta">${esc([m.area, m.category].filter(Boolean).join(' · '))}</div>
                  <div class="tags" style="margin-top:6px">${chips(m.matched)}</div>
                  ${m.missingCount ? `<p class="meta" style="margin:6px 0 8px">Also needs: ${esc(m.missing.join(', '))}${m.missingCount > m.missing.length ? ` +${m.missingCount - m.missing.length} more` : ''}</p>` : ''}
                  <button class="btn-sm" data-save="${esc(m.url)}">＋ Save to my kitchen</button>
                </div></div>`).join('')}</div>`
              : (!r.onlineError ? '<div class="banner muted">No online recipes found for that combination. Try fewer or more common ingredients.</div>' : '')}
            <a class="btn" href="${esc(r.webSearchUrl)}" target="_blank" rel="noopener noreferrer">Search the whole web for more ideas ↗</a>
          </section>
        </div>`;
        out.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
          state.pendingImport = b.dataset.save;
          location.hash = '#/new';
        }));
      } catch (e) { out.innerHTML = ''; toast(e.message, 'error'); }
    });
  }
  go.addEventListener('click', search);
  if (items.length) search();
}

// ------------------------------------------------------------------ community & sharing
async function renderCommunity(alive) {
  renderTopbar('community');
  const [share, { collections }] = await Promise.all([api('/share'), api('/community')]);
  if (!alive()) return;
  const shareUrl = (token) => `${location.origin}/#/s/${token}`;

  app.innerHTML = `<div class="stack">
    <div><h1>Community &amp; Sharing</h1><p class="muted">Share your collection with friends, and browse what others are cooking.</p></div>
    <div class="card stack">
      <div class="row spread">
        <div><h2 style="margin:0">Share my kitchen</h2>
          <p class="muted" style="margin:4px 0 0">Anyone with the link can view your entries (read-only, no account needed). Signed-in users will also see you below.</p></div>
        <label class="switch"><input type="checkbox" id="share-toggle" ${share.enabled ? 'checked' : ''}> <span id="share-state">${share.enabled ? 'Sharing on' : 'Private'}</span></label>
      </div>
      <div id="share-box"></div>
    </div>
    <h2>Shared kitchens</h2>
    <div id="collections"></div>
  </div>`;

  function paintShare(s) {
    app.querySelector('#share-state').textContent = s.enabled ? 'Sharing on' : 'Private';
    app.querySelector('#share-box').innerHTML = s.enabled ? `
      <div class="share-link"><input type="text" readonly value="${esc(shareUrl(s.token))}" id="share-url">
        <button class="btn-primary" id="copy">Copy link</button></div>
      <div class="row" style="margin-top:10px">
        <a class="btn btn-sm" href="#/s/${esc(s.token)}">Preview what others see</a>
        <button class="btn-sm btn-ghost" id="regen" title="Old links stop working">Make a new link</button>
      </div>` : '';
    app.querySelector('#copy')?.addEventListener('click', async () => {
      const input = app.querySelector('#share-url');
      try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
      toast('Link copied, ready to send');
    });
    app.querySelector('#regen')?.addEventListener('click', async () => {
      if (!confirm('Create a new link? Anyone with the old link will lose access.')) return;
      paintShare(await api('/share', { method: 'POST', body: { enabled: true, regenerate: true } }));
      loadCollections();
    });
  }
  function paintCollections(list) {
    const el = app.querySelector('#collections');
    el.innerHTML = list.length ? `<div class="grid">${list.map((c) => `<a class="entry-card collection" href="#/s/${esc(c.token)}">
        <div class="collage">${c.covers.length ? c.covers.map((src) => `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="🍽️">`).join('') : '<div class="ph">🍳</div>'}</div>
        <div class="body" style="padding:0 14px 14px">
          <h3>${esc(c.username)}'s kitchen ${c.isMe ? '<span class="tag plain">you</span>' : ''}</h3>
          <div class="meta">${c.count} ${c.count === 1 ? 'entry' : 'entries'}</div>
          <div class="tags">${c.topTags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        </div></a>`).join('')}</div>`
      : '<div class="empty"><div class="big">👩‍🍳</div><p>No one is sharing yet. Turn on sharing above to be the first!</p></div>';
  }
  async function loadCollections() { paintCollections((await api('/community')).collections); }

  paintShare(share);
  paintCollections(collections);
  app.querySelector('#share-toggle').addEventListener('change', async (e) => {
    try { paintShare(await api('/share', { method: 'POST', body: { enabled: e.target.checked } })); loadCollections(); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
  });
}

// Public shared collection (works without an account).
async function renderShared(token, params, alive) {
  renderTopbar('community');
  const data = await api(`/shared/${enc(token)}`);
  if (!alive()) return;
  let query = params.get('q') || '';
  state.tab = 'All';
  app.innerHTML = `<div class="stack">
    ${state.user ? '<a class="back" href="#/community">← Community</a>' : ''}
    <div class="row spread">
      <div><h1>${esc(data.owner.username)}'s kitchen</h1><p class="muted" id="subtitle" style="margin:0"></p></div>
      ${data.isOwner ? '<span class="tag plain">This is your shared collection</span>' : ''}
    </div>
    <div class="search"><input type="search" id="q" placeholder="Search ${esc(data.owner.username)}'s dishes, ingredients or tags" value="${esc(query)}"></div>
    <div class="tabs" id="tabs"></div>
    <div id="results"></div>
  </div>`;
  const paint = () => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = data.entries.filter((e) => {
      const hay = [e.name, e.category, e.notes, ...e.tags, ...e.ingredients].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    app.querySelector('#subtitle').textContent = query ? `${entries.length} of ${data.entries.length} entries match “${query}”` : `${data.entries.length} entries`;
    paintCollection({
      tabsEl: app.querySelector('#tabs'), resultsEl: app.querySelector('#results'), entries,
      hrefFor: (e) => `#/s/${enc(token)}/${e.id}`,
      emptyHtml: `<div class="empty"><div class="big">🍽️</div><p>${query ? 'Nothing matches that search.' : 'Nothing here yet.'}</p></div>`,
    });
  };
  app.querySelector('#q').addEventListener('input', debounce((e) => { query = e.target.value.trim(); paint(); }, 150));
  paint();
}

async function renderSharedEntry(token, id, alive) {
  renderTopbar('community');
  const { owner, entry, isOwner } = await api(`/shared/${enc(token)}/entries/${enc(id)}`);
  if (!alive()) return;
  const actions = isOwner
    ? `<a class="btn" href="#/entry/${entry.id}/edit">✎ Edit</a>`
    : state.user
      ? '<button class="btn-primary" id="save-copy">＋ Save to my kitchen</button>'
      : '<a class="btn btn-primary" href="#/login" id="signin-save">Sign in to save a copy</a>';
  app.innerHTML = entryDetailHtml(entry, {
    back: { href: `#/s/${enc(token)}`, label: `${owner.username}'s kitchen` },
    actions,
    tagHref: (t) => `#/s/${enc(token)}?q=${enc(t)}`,
  });
  wireGallery();
  app.querySelector('#signin-save')?.addEventListener('click', () => { state.afterLogin = location.hash; });
  app.querySelector('#save-copy')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const { id: newId } = await api(`/shared/${enc(token)}/entries/${entry.id}/save`, { method: 'POST' });
      toast(`Saved “${entry.name}” to your kitchen`);
      location.hash = `#/entry/${newId}`;
    } catch (err) { toast(err.message, 'error'); }
  }));
}

// ------------------------------------------------------------------ import & export (Markdown)
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|avif)$/i;
const fmtNum = (n) => Number(n).toLocaleString();

function renderData(alive) {
  renderTopbar('data');
  app.innerHTML = `<div class="stack">
    <div><h1>Import &amp; export</h1>
      <p class="muted" style="margin:0">Your kitchen as plain Markdown files you can read, edit, back up or put in git, and bring back in any time.</p></div>

    <section class="card stack">
      <div class="row spread" style="align-items:flex-start">
        <div style="flex:1;min-width:260px">
          <h2 style="margin:0">⬇ Export</h2>
          <p class="muted" style="margin:6px 0 0">Downloads a <strong>.zip</strong> of your whole kitchen: journals, one file per recipe, category lists and photos.</p>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="exp-photos" checked> Include photos</label>
          <a class="btn btn-primary" id="exp-go" href="/api/export/markdown" download>⬇ Download .zip</a>
        </div>
      </div>
      <details><summary class="muted">What's inside</summary>
<pre class="tree">kitchen-journal/
├── README.md            overview and conventions
├── main.md              # Food Journey: savoury dishes you've made, plus your wishlist
├── dessert.md           # Food Journey: baking and desserts
├── Categories/          by category, cuisine, main ingredient, tag and favourites
├── Recipes/             one .md per dish: ingredients, method and notes
│   └── pasta_alla_bolognese.md
└── Pictures/            one folder per dish
    └── Pasta alla Bolognese/01.jpg</pre>
        <p class="hint">Journals use <code>- [*] Dish</code> for favourites and <code>[*] link</code> for the source you used. Each recipe file starts with a small <code>---</code> block of fields, so re-importing an export loses nothing.</p>
      </details>
    </section>

    <section class="card stack" id="imp">
      <div>
        <h2 style="margin:0">⬆ Import</h2>
        <p class="muted" style="margin:6px 0 0">Bring in Markdown notes: a whole notes folder (with a <code>Pictures/</code> folder if you have one), individual <code>.md</code> files, or a Kitchen Journal export <code>.zip</code>. You'll see a preview before anything is saved.</p>
      </div>
      <div class="drop-area" id="imp-drop">
        <div class="row" style="justify-content:center">
          <button class="btn-primary" id="pick-folder">📁 Choose a folder</button>
          <button id="pick-files">📄 Choose .md or .zip files</button>
        </div>
        <p class="hint center" style="margin:10px 0 0">…or drop .md / .zip files here</p>
        <input type="file" id="in-folder" webkitdirectory multiple hidden>
        <input type="file" id="in-files" accept=".md,.markdown,.zip,text/markdown,application/zip" multiple hidden>
      </div>
      <div class="row">
        <label class="field" style="max-width:220px"><span>Photos per dish</span>
          <select id="imp-max"><option value="6">Up to 6</option><option value="12" selected>Up to 12</option><option value="24">Up to 24</option><option value="0">All of them</option></select></label>
        <p class="hint" style="margin:18px 0 0;flex:1;min-width:220px">Photos are matched to dishes by folder name (<code>Pictures/&lt;Dish&gt;/…</code>). When a dish has more photos than this, an even spread across every time you made it is kept. Large photos are resized before uploading.</p>
      </div>
      <div id="imp-out"></div>
    </section>
  </div>`;

  // ---- export
  const expPhotos = app.querySelector('#exp-photos');
  const expGo = app.querySelector('#exp-go');
  expPhotos.addEventListener('change', () => { expGo.href = `/api/export/markdown${expPhotos.checked ? '' : '?photos=0'}`; });

  // ---- import
  const out = app.querySelector('#imp-out');
  const maxSel = app.querySelector('#imp-max');
  let picked = null; // { md: [{path, file}], images: Map(path -> File), zip: File|null, label }

  const choose = (fileList) => {
    const all = [...fileList].filter((f) => !/(^|\/)\.git\//.test(f.webkitRelativePath || ''));
    const zip = all.find((f) => /\.zip$/i.test(f.name));
    const pathOf = (f) => f.webkitRelativePath || f.name;
    picked = {
      zip: zip || null,
      md: zip ? [] : all.filter((f) => /\.(md|markdown)$/i.test(f.name)).map((f) => ({ path: pathOf(f), file: f })),
      images: zip ? new Map() : new Map(all.filter((f) => IMAGE_FILE.test(f.name)).map((f) => [pathOf(f), f])),
    };
    parse();
  };
  app.querySelector('#pick-folder').addEventListener('click', () => app.querySelector('#in-folder').click());
  app.querySelector('#pick-files').addEventListener('click', () => app.querySelector('#in-files').click());
  app.querySelector('#in-folder').addEventListener('change', (e) => { choose(e.target.files); e.target.value = ''; });
  app.querySelector('#in-files').addEventListener('change', (e) => { choose(e.target.files); e.target.value = ''; });
  const drop = app.querySelector('#imp-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); choose(e.dataTransfer.files); });
  maxSel.addEventListener('change', () => { if (picked) parse(); });

  async function parse() {
    if (!picked.zip && !picked.md.length) { toast('No .md or .zip files in what you picked', 'error'); return; }
    out.innerHTML = `<p class="muted center pad"><span class="spinner"></span> Reading ${picked.zip ? esc(picked.zip.name) : `${fmtNum(picked.md.length)} Markdown file${picked.md.length === 1 ? '' : 's'}${picked.images.size ? ` and ${fmtNum(picked.images.size)} photos` : ''}`}…</p>`;
    try {
      let result;
      if (picked.zip) {
        const fd = new FormData();
        fd.append('maxPhotos', maxSel.value);
        fd.append('archive', picked.zip);
        result = await api('/markdown/parse', { method: 'POST', form: fd });
      } else {
        const files = await Promise.all(picked.md.map(async ({ path, file }) => ({ path, text: await file.text() })));
        result = await api('/markdown/parse', { method: 'POST', body: { files, imagePaths: [...picked.images.keys()], maxPhotos: Number(maxSel.value) } });
      }
      if (alive()) showPreview(result);
    } catch (e) { out.innerHTML = ''; toast(e.message, 'error'); }
  }

  function showPreview({ importId, items, skipped, stats }) {
    // Default: import everything except things already in the kitchen and photo-only twins.
    const sel = new Set(items.filter((i) => !i.duplicateOf && !(i.origin === 'photos' && i.duplicateInImport)).map((i) => i.key));
    let filter = '';
    let view = 'all';
    const n = (f) => items.filter(f).length;
    out.innerHTML = `<div class="stack">
      <div class="banner">
        <strong>Found ${fmtNum(items.length)} dishes</strong> in ${fmtNum(stats.markdownFiles)} Markdown file${stats.markdownFiles === 1 ? '' : 's'}${stats.images ? ` and ${fmtNum(stats.images)} photos` : ''}.
        <div class="tags" style="margin-top:8px">
          <span class="tag plain">🍳 ${n((i) => i.status === 'made')} made</span>
          <span class="tag plain">📝 ${n((i) => i.status === 'wishlist')} want to try</span>
          <span class="tag plain">⭐ ${n((i) => i.favorite)} favourites</span>
          <span class="tag plain">📷 ${n((i) => i.photos.length)} with photos</span>
          <span class="tag plain">🥕 ${n((i) => i.ingredients.length)} with ingredients</span>
          ${n((i) => i.duplicateOf) ? `<span class="tag gold">${n((i) => i.duplicateOf)} already in your kitchen (unticked)</span>` : ''}
        </div>
      </div>
      ${skipped.length ? `<details><summary class="muted">${skipped.length} file/section${skipped.length === 1 ? '' : 's'} skipped</summary><ul class="hint">${skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
      <div class="row spread">
        <div class="row">
          <input type="search" id="pv-q" placeholder="Filter dishes…" style="width:240px">
          <select id="pv-view" style="width:200px">
            <option value="all">Show all</option><option value="selected">Selected</option><option value="unselected">Not selected</option>
            <option value="dup">Duplicates</option><option value="loose">Loose photo matches</option><option value="photos">Photos only</option>
          </select>
        </div>
        <div class="row"><button class="btn-sm" id="pv-all">Select all</button><button class="btn-sm btn-ghost" id="pv-none">Select none</button></div>
      </div>
      <div class="pv-list" id="pv-list"></div>
      <div class="sticky-actions row spread">
        <span class="muted" id="pv-count"></span>
        <button class="btn-primary" id="pv-go">Import</button>
      </div>
    </div>`;
    const list = out.querySelector('#pv-list');
    const visible = () => items.filter((i) => (!filter || i.name.toLowerCase().includes(filter))
      && (view === 'all' || (view === 'selected' && sel.has(i.key)) || (view === 'unselected' && !sel.has(i.key))
        || (view === 'dup' && (i.duplicateOf || i.duplicateInImport)) || (view === 'loose' && i.photoFolder) || (view === 'photos' && i.origin === 'photos')));
    const countLine = () => {
      const chosen = items.filter((i) => sel.has(i.key));
      const photos = chosen.reduce((s, i) => s + i.photos.length, 0);
      out.querySelector('#pv-count').textContent = `${fmtNum(chosen.length)} of ${fmtNum(items.length)} selected · ${fmtNum(photos)} photos`;
      out.querySelector('#pv-go').textContent = `Import ${fmtNum(chosen.length)} ${chosen.length === 1 ? 'entry' : 'entries'}`;
      out.querySelector('#pv-go').disabled = !chosen.length;
    };
    const row = (i) => `<details class="pv-row ${sel.has(i.key) ? '' : 'off'}" data-key="${i.key}">
      <summary>
        <input type="checkbox" data-sel="${i.key}" ${sel.has(i.key) ? 'checked' : ''} aria-label="Import ${esc(i.name)}">
        <span class="pv-name">${i.favorite ? '⭐ ' : ''}${esc(i.name)}</span>
        <select data-cat="${i.key}" aria-label="Category">${state.categories.map((c) => `<option ${c === i.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <button type="button" class="pv-status ${i.status}" data-status="${i.key}" title="Click to switch">${i.status === 'wishlist' ? '📝 Want to try' : '🍳 Made'}</button>
        <span class="pv-meta">${i.photos.length ? `📷 ${i.photos.length}${i.photoTotal > i.photos.length ? `/${i.photoTotal}` : ''}` : ''}${i.ingredients.length ? ` · 🥕 ${i.ingredients.length}` : ''}${i.instructions ? ' · 📋' : ''}${i.recipeUrl ? ' · 🔗' : ''}</span>
      </summary>
      <div class="pv-body">
        ${i.duplicateOf ? `<p class="warn">Already in your kitchen as “${esc(i.duplicateOf.name)}”. Unticked so you don't get two.</p>` : ''}
        ${i.duplicateInImport ? `<p class="warn">Another dish in this import is also called “${esc(i.duplicateInImport)}”.</p>` : ''}
        ${i.photoFolder ? `<p class="warn">Photos matched loosely from the folder “${esc(i.photoFolder)}”.</p>` : ''}
        <div class="tags">${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <p class="hint" style="margin:6px 0">From ${esc(i.source)}${i.madeOn ? ` · last made ${esc(fmtDate(i.madeOn))}` : ''}${i.recipeUrl ? ` · <a href="${esc(i.recipeUrl)}" target="_blank" rel="noopener noreferrer">${esc(i.recipeUrl)}</a>` : ''}</p>
        ${i.ingredients.length ? `<p class="pv-sub">Ingredients</p><p class="pv-text">${esc(i.ingredients.slice(0, 12).join(' · '))}${i.ingredients.length > 12 ? ' …' : ''}</p>` : ''}
        ${i.instructions ? `<p class="pv-sub">Method</p><p class="pv-text">${esc(i.instructions.split('\n').slice(0, 3).join(' / '))}${i.instructions.split('\n').length > 3 ? ' …' : ''}</p>` : ''}
        ${i.notes ? `<p class="pv-sub">Notes</p><pre class="pv-notes">${esc(i.notes.length > 900 ? i.notes.slice(0, 900) + '\n…' : i.notes)}</pre>` : ''}
      </div>
    </details>`;
    const paint = () => {
      const v = visible();
      list.innerHTML = v.length ? v.map(row).join('') : '<p class="muted center pad">No dishes match.</p>';
      countLine();
    };
    list.addEventListener('click', (e) => {
      if (e.target.matches('[data-sel], [data-cat], [data-status]')) e.stopPropagation();
      const st = e.target.closest('[data-status]');
      if (st) {
        e.preventDefault();
        const it = items.find((x) => x.key === st.dataset.status);
        it.status = it.status === 'wishlist' ? 'made' : 'wishlist';
        st.className = `pv-status ${it.status}`;
        st.textContent = it.status === 'wishlist' ? '📝 Want to try' : '🍳 Made';
      }
      if (e.target.matches('[data-sel]') || e.target.matches('[data-cat]')) {
        // Don't let clicks on controls inside <summary> toggle the row open.
        if (e.target.matches('[data-cat]')) e.preventDefault();
      }
    });
    list.addEventListener('change', (e) => {
      const k = e.target.dataset.sel || e.target.dataset.cat;
      if (e.target.dataset.sel) {
        if (e.target.checked) sel.add(k); else sel.delete(k);
        e.target.closest('.pv-row').classList.toggle('off', !e.target.checked);
        countLine();
      } else if (e.target.dataset.cat) {
        items.find((x) => x.key === k).category = e.target.value;
      }
    });
    out.querySelector('#pv-q').addEventListener('input', debounce((e) => { filter = e.target.value.trim().toLowerCase(); paint(); }, 150));
    out.querySelector('#pv-view').addEventListener('change', (e) => { view = e.target.value; paint(); });
    out.querySelector('#pv-all').addEventListener('click', () => { visible().forEach((i) => sel.add(i.key)); paint(); });
    out.querySelector('#pv-none').addEventListener('click', () => { visible().forEach((i) => sel.delete(i.key)); paint(); });
    out.querySelector('#pv-go').addEventListener('click', () => runImport(importId, items.filter((i) => sel.has(i.key))));
    paint();
  }

  async function runImport(importId, chosen) {
    out.innerHTML = `<div class="banner stack"><strong id="pr-title"><span class="spinner"></span> Saving ${fmtNum(chosen.length)} entries…</strong>
      <div class="progress"><i id="pr-bar" style="width:5%"></i></div><span class="hint" id="pr-text"></span></div>`;
    const bar = out.querySelector('#pr-bar');
    const text = out.querySelector('#pr-text');
    let res;
    try {
      res = await api('/markdown/import', { method: 'POST', body: { importId, items: chosen } });
    } catch (e) { out.innerHTML = ''; toast(e.message, 'error'); return; }

    // Folder imports: upload each entry's photos from the browser (resized first).
    const byKey = new Map(chosen.map((i) => [i.key, i]));
    const jobs = [];
    if (!importId) {
      for (const c of res.created) {
        const files = (byKey.get(c.key)?.photos || []).map((p) => picked.images.get(p)).filter(Boolean);
        for (let i = 0; i < files.length; i += 6) jobs.push({ id: c.id, files: files.slice(i, i + 6) });
      }
    }
    const total = jobs.reduce((s, j) => s + j.files.length, 0);
    let done = 0;
    let failed = 0;
    const tick = () => {
      bar.style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
      text.textContent = total ? `Uploading photos… ${fmtNum(done)} / ${fmtNum(total)}` : '';
    };
    tick();
    if (total) out.querySelector('#pr-title').innerHTML = `<span class="spinner"></span> Saved ${fmtNum(res.created.length)} entries, now adding photos`;
    const worker = async () => {
      while (jobs.length) {
        const job = jobs.shift();
        try {
          const fd = new FormData();
          for (const f of job.files) fd.append('photos', await shrinkImage(f));
          await api(`/entries/${job.id}/photos`, { method: 'POST', form: fd });
        } catch { failed += job.files.length; }
        done += job.files.length;
        tick();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (!alive()) return;
    const photoCount = importId ? res.photosSaved : total - failed;
    out.innerHTML = `<div class="banner stack">
      <strong>✅ Imported ${fmtNum(res.created.length)} ${res.created.length === 1 ? 'entry' : 'entries'}${photoCount ? ` with ${fmtNum(photoCount)} photos` : ''}.</strong>
      ${failed ? `<span class="warn">${fmtNum(failed)} photos couldn't be uploaded.</span>` : ''}
      ${res.errors.length ? `<details><summary class="warn">${res.errors.length} couldn't be imported</summary><ul class="hint">${res.errors.map((e) => `<li>${esc(e.name || e.key)}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}
      <div class="row"><a class="btn btn-primary" href="#/">Go to My Kitchen</a></div>
    </div>`;
    state.tab = 'All';
    state.query = '';
  }
}

// ------------------------------------------------------------------ clip (bookmarklet receiver)
function renderClip(alive) {
  renderTopbar('kitchen');
  app.innerHTML = `<div class="empty"><div class="big">📌</div><h2 id="clip-status"><span class="spinner"></span> Receiving the recipe…</h2>
    <p class="muted" id="clip-hint">Keep the recipe tab open for a moment.</p></div>`;
  let done = false;
  const onMessage = async (ev) => {
    const d = ev.data;
    if (done || !d || d.type !== 'kj-clip' || typeof d.html !== 'string') return;
    done = true;
    window.removeEventListener('message', onMessage);
    try { ev.source?.postMessage('kj-clip-ok', ev.origin); } catch { /* tab closed */ }
    try {
      const { recipe } = await api('/import/html', { method: 'POST', body: { html: d.html, url: String(d.url || '') } });
      state.pendingRecipe = recipe;
      if (alive()) location.hash = '#/new';
    } catch (e) {
      if (!alive()) return;
      app.querySelector('#clip-status').textContent = e.message;
      app.querySelector('#clip-hint').innerHTML = 'You can still <a href="#/new">add it manually</a> and paste the recipe text.';
    }
  };
  window.addEventListener('message', onMessage);
  setTimeout(() => {
    if (done || !alive()) return;
    window.removeEventListener('message', onMessage);
    app.querySelector('#clip-status').textContent = 'Nothing received yet';
    app.querySelector('#clip-hint').innerHTML = 'This page is opened by the 📌 Clip bookmark. Open a recipe page and click the bookmark there.'
      + `<div class="card" style="text-align:left;margin-top:16px">${clipHelpHtml()}</div>`;
  }, 20000);
}

// ------------------------------------------------------------------ spotlight
function submissionCard(week, s) {
  return `<a class="entry-card" href="#/spotlight/${esc(week)}/s/${s.id}">
    <div class="cover">${s.entry.cover ? `<img src="${esc(s.entry.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${EMOJI[s.entry.category] || '🍽️'}">` : (EMOJI[s.entry.category] || '🍽️')}</div>
    <div class="body">
      <h3>${esc(s.entry.name)}</h3>
      <div class="meta">by @${esc(s.username)}${s.isMine ? ' <span class="tag plain">you</span>' : ''} · ${esc(fmtDate(s.createdAt))}</div>
      ${s.caption ? `<p class="caption">“${esc(s.caption)}”</p>` : ''}
    </div>
  </a>`;
}

async function renderSpotlight(week, alive) {
  renderTopbar('spotlight');
  const [data, mine] = await Promise.all([
    api(week ? `/spotlight/${enc(week)}` : '/spotlight'),
    api('/entries'),
  ]);
  if (!alive()) return;
  const f = data.featured;
  const archiveHtml = data.archive.length ? `<section class="stack">
      <h2>${data.isCurrent ? 'Past spotlights' : 'Other spotlights'}</h2>
      <div class="grid">${data.archive.map((a) => `<a class="entry-card" href="#/spotlight/${esc(a.week)}">
        <div class="cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${EMOJI[a.category] || '🍽️'}">` : (EMOJI[a.category] || '🍽️')}</div>
        <div class="body"><div class="eyebrow">${esc(a.label)}</div><h3>${esc(a.name)}</h3>
          <div class="meta">from @${esc(a.owner)} · ${a.count} cook-along${a.count === 1 ? '' : 's'}</div></div></a>`).join('')}</div>
    </section>` : '';

  if (!f) {
    app.innerHTML = `<div class="stack">
      <div><h1>🌟 Spotlight</h1><p class="muted">Week of ${esc(data.label)}</p></div>
      <div class="empty"><div class="big">🌱</div><h2>No spotlight yet</h2>
        <p>Each week, one recipe is picked from the kitchens that have sharing turned on, and everyone can cook along.<br>
        Nobody is sharing yet, so there's nothing to pick from.</p>
        <p><a class="btn btn-primary" href="#/community">Turn on sharing for your kitchen</a></p></div>
      ${archiveHtml}
    </div>`;
    return;
  }

  // Put my entries that look like this recipe at the top of the picker.
  const words = f.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const likely = (e) => words.some((w) => e.name.toLowerCase().includes(w));
  const options = [...mine.entries].sort((a, b) => likely(b) - likely(a))
    .filter((e) => !(f.isMine && e.id === f.id));
  const my = data.mySubmission;

  const cover = f.photos[0]?.url || f.imageUrl;
  app.innerHTML = `<div class="stack">
    ${data.isCurrent ? '' : `<a class="back" href="#/spotlight">← This week's spotlight</a>`}
    <div><h1>🌟 Spotlight</h1><p class="muted" style="margin:0">${data.isCurrent ? 'This week' : 'Past spotlight'} · ${esc(data.label)}</p></div>

    <section class="spot-hero card">
      <div class="spot-cover">${cover ? `<img src="${esc(cover)}" alt="${esc(f.name)}" referrerpolicy="no-referrer" data-fallback="${EMOJI[f.category] || '🍽️'}">` : `<span>${EMOJI[f.category] || '🍽️'}</span>`}</div>
      <div class="stack">
        <div class="eyebrow">${data.isCurrent ? "This week's featured recipe" : `Featured ${esc(data.label)}`}</div>
        <h2 class="spot-title">${esc(f.name)}</h2>
        <div class="meta">from @${esc(f.owner)}'s kitchen${f.isMine ? ' <span class="tag gold">That\'s you! 🎉</span>' : ''} · ${esc(f.category)}</div>
        <div class="tags">${f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <p class="muted" style="margin:0">${data.submissions.length ? `${data.submissions.length} ${data.submissions.length === 1 ? 'cook has' : 'cooks have'} made this so far.` : 'Nobody has cooked this yet. Be the first!'}</p>
        <div class="row">
          <button class="btn-primary" id="cook-along">🍳 Cook along</button>
          <button id="save-featured">＋ Save recipe to my kitchen</button>
        </div>
      </div>
    </section>

    <details class="card" ${f.ingredients.length + f.instructions.length ? 'open' : ''}>
      <summary><h2 style="display:inline">The recipe</h2></summary>
      <div id="featured-detail" style="margin-top:16px"></div>
    </details>

    <section class="stack">
      <div class="row spread"><h2 style="margin:0">Cook-along <span class="muted" style="font-size:.9rem;font-family:var(--sans)">${data.submissions.length}</span></h2></div>
      <div class="card" id="submit-box">
        ${my ? `<div class="row spread">
            <div><strong>Your submission:</strong> <a href="#/spotlight/${esc(data.week)}/s/${my.id}">${esc(my.entry.name)}</a>${my.caption ? ` <span class="muted">· “${esc(my.caption)}”</span>` : ''}</div>
            <div class="row"><button class="btn-sm" id="change-sub">Change</button><button class="btn-sm btn-ghost btn-danger" id="withdraw">Withdraw</button></div>
          </div>` : ''}
        <form id="sub-form" class="stack" ${my ? 'hidden' : ''}>
          <div><strong>Made it? Share how yours turned out.</strong>
            <div class="hint">Pick the entry from your kitchen, or use <em>Cook along</em> to start a new entry from this recipe. Submitted entries are visible to everyone signed in, even if your kitchen is private.</div></div>
          ${options.length ? `<div class="row" style="align-items:flex-end">
            <label class="field" style="flex:2;min-width:200px"><span>Your entry</span>
              <select name="entryId">${options.map((e) => `<option value="${e.id}" ${my?.entry.id === e.id ? 'selected' : ''}>${esc(e.name)}${e.photos.length ? ' 📷' : ''}</option>`).join('')}</select></label>
            <label class="field" style="flex:3;min-width:200px"><span>Caption <span class="muted" style="font-weight:400">(optional)</span></span>
              <input type="text" name="caption" maxlength="280" value="${esc(my?.caption || '')}" placeholder="What did you change? How did it go?"></label>
            <button class="btn-primary">${my ? 'Update' : 'Submit'}</button>
          </div>` : '<p class="muted" style="margin:0">You don\'t have any entries yet. Use <strong>Cook along</strong> above to start one from this recipe.</p>'}
        </form>
      </div>
      ${data.submissions.length ? `<div class="grid">${data.submissions.map((s) => submissionCard(data.week, s)).join('')}</div>` : ''}
    </section>
    ${archiveHtml}
  </div>`;

  // Featured recipe body (reuse the entry detail layout, without its header).
  const tmp = document.createElement('div');
  tmp.innerHTML = entryDetailHtml({ ...f, photos: f.photos.slice(1), imageUrl: '' }, { back: { href: '#', label: '' }, tagHref: (t) => `#/?q=${enc(t)}` });
  const detail = app.querySelector('#featured-detail');
  for (const sel of ['.gallery', '.video', '.detail-grid']) { const n = tmp.querySelector(sel); if (n) detail.append(n); }
  wireGallery();

  week = data.week;
  app.querySelector('#cook-along').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    try {
      const { id } = await api(`/spotlight/${week}/save`, { method: 'POST', body: { cookAlong: true } });
      location.hash = `#/entry/${id}/edit?spotlight=${week}`;
    } catch (e) { toast(e.message, 'error'); }
  }));
  app.querySelector('#save-featured').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    try {
      const { id } = await api(`/spotlight/${week}/save`, { method: 'POST', body: {} });
      toast(`Saved “${f.name}” to your kitchen`);
      location.hash = `#/entry/${id}`;
    } catch (e) { toast(e.message, 'error'); }
  }));
  const subForm = app.querySelector('#sub-form');
  app.querySelector('#change-sub')?.addEventListener('click', () => { subForm.hidden = !subForm.hidden; });
  app.querySelector('#withdraw')?.addEventListener('click', async () => {
    if (!confirm('Withdraw your submission from this Spotlight? Your entry stays in your kitchen.')) return;
    try { await api(`/spotlight/${week}/submissions/mine`, { method: 'DELETE' }); toast('Submission withdrawn'); router(); }
    catch (e) { toast(e.message, 'error'); }
  });
  subForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!subForm.entryId) return;
    busy(subForm.querySelector('button'), async () => {
      try {
        await api(`/spotlight/${week}/submissions`, { method: 'POST', body: { entryId: Number(subForm.entryId.value), caption: subForm.caption.value } });
        toast(my ? 'Submission updated' : 'Submitted to the Spotlight 🌟');
        router();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function renderSubmission(week, subId, alive) {
  renderTopbar('spotlight');
  const { submission: s, spotlight, entry } = await api(`/spotlight/${enc(week)}/submissions/${enc(subId)}`);
  if (!alive()) return;
  app.innerHTML = entryDetailHtml(entry, {
    back: { href: `#/spotlight/${enc(week)}`, label: `Spotlight: ${spotlight.name}` },
    banner: `<div class="banner spot-banner">🍳 <strong>@${esc(s.username)}</strong>'s cook-along of <strong>${esc(spotlight.name)}</strong>${s.caption ? `: “${esc(s.caption)}”` : ''}</div>`,
    actions: s.isMine
      ? `<a class="btn btn-primary" href="#/entry/${entry.id}/edit">✎ Edit my entry</a>`
      : '<button class="btn-primary" id="save-sub">＋ Save to my kitchen</button>',
    tagHref: (t) => `#/?q=${enc(t)}`,
  });
  wireGallery();
  app.querySelector('#save-sub')?.addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    try {
      const { id } = await api(`/spotlight/${enc(week)}/submissions/${s.id}/save`, { method: 'POST' });
      toast(`Saved “${entry.name}” to your kitchen`);
      location.hash = `#/entry/${id}`;
    } catch (e) { toast(e.message, 'error'); }
  }));
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    const [{ user }, { categories }] = await Promise.all([api('/auth/me'), api('/meta')]);
    state.user = user;
    state.categories = categories;
  } catch {
    app.innerHTML = '<p class="center pad">Could not reach the server. Is it running?</p>';
    return;
  }
  window.addEventListener('hashchange', router);
  router();
})();
