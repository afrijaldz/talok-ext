'use strict';

const $ = (sel) => document.querySelector(sel);
const treeEl = $('#tree');
const filterEl = $('#filter');

const MD_EXT = /\.(md|markdown|mdx)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;
const BINARY_EXT = /\.(pdf|zip|gz|tgz|tar|7z|rar|jar|exe|dll|so|dylib|bin|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|webm|psd|sqlite|db|class|o|a|wasm)$/i;
const MAX_TEXT_SIZE = 1024 * 1024;
const NARROW = 820;
const SPLIT_SEP = '::'; // separates left/right paths in the hash; ':' is always encoded inside a path
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// The same page runs as the extension's reader.html and as a plain website (index.html).
const IS_EXT = !!globalThis.chrome?.runtime?.id;
const TOKEN_HINT = IS_EXT ? 'in the extension options' : 'under Token in the file list';

const state = {
  owner: '', repo: '', ref: 'HEAD', token: '',
  nodes: new Map(),      // path -> { name, path, type: 'blob'|'tree', size, children }
  root: null,
  order: [],             // reading order (prev/next)
  active: 0,             // currently focused pane
};

// ---------- storage helpers (localStorage may be unavailable) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};
const repoKey = (k, repo = `${state.owner}/${state.repo}`, ref = state.ref) => `${k}:${repo}@${ref}`;

// ---------- recently opened repos (shown on the landing page) ----------
const MAX_RECENT = 20;

function rememberRepo() {
  const repo = `${state.owner}/${state.repo}`;
  const rest = store.get('recent', []).filter((r) => !(r.repo === repo && r.ref === state.ref));
  store.set('recent', [{ repo, ref: state.ref, at: Date.now(), total: state.order.length }, ...rest].slice(0, MAX_RECENT));
}

function forgetRepo(repo, ref) {
  store.set('recent', store.get('recent', []).filter((r) => !(r.repo === repo && r.ref === ref)));
}

const relTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(ms) {
  const s = (ms - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return relTime.format(Math.round(s / n), unit);
  }
  return 'just now';
}

function renderRecent() {
  const list = $('#recent-list');
  const recent = store.get('recent', []);
  $('#recent').hidden = !recent.length;
  list.replaceChildren(...recent.map(({ repo, ref, at, total }) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = readerHref({ repo, ref: ref === 'HEAD' ? undefined : ref });

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = repo + (ref !== 'HEAD' ? ` @ ${ref}` : '');

    const last = store.get(repoKey('last', repo, ref), null);
    const read = Math.min(store.get(repoKey('done', repo, ref), []).length, total);
    const meta = document.createElement('small');
    meta.textContent = [last && title(last), total ? `${read}/${total} read` : '', ago(at)].filter(Boolean).join(' · ');

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.title = 'Remove from history';
    remove.textContent = '×';
    remove.addEventListener('click', () => { forgetRepo(repo, ref); renderRecent(); });

    a.append(name, meta);
    li.append(a, remove);
    return li;
  }));
}

// ---------- preferences ----------
function applyPrefs() {
  const theme = store.get('theme', 'auto');
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--fs', store.get('fontSize', 19) + 'px');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1400);
}

// ---------- paths & urls ----------
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const dirname = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const title = (p) => basename(p).replace(MD_EXT, '');
const hidden = (p) => p.split('/').some((s) => s.startsWith('.'));
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

const rawUrl = (p) => `https://raw.githubusercontent.com/${state.owner}/${state.repo}/${encPath(state.ref)}/${encPath(p)}`;
const githubUrl = (p, kind = 'blob') =>
  `https://github.com/${state.owner}/${state.repo}` + (p ? `/${kind}/${encPath(state.ref)}/${encPath(p)}` : '');

function parseRepoInput(text) {
  text = text.trim().replace(/\.git$/, '');
  const m = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:blob|tree)\/([^/\s]+)(?:\/(.*))?)?/i)
    || text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, ref: m[3], path: m[4] ? decodeURIComponent(m[4].replace(/[?#].*$/, '')) : '' };
}

function readerHref({ repo, ref, path }) {
  const hash = path ? '#' + encPath(path) : '';
  if (!IS_EXT) return `/${repo}` + (ref ? `?ref=${encodeURIComponent(ref)}` : '') + hash;
  const params = new URLSearchParams({ repo });
  if (ref) params.set('ref', ref);
  return `reader.html?${params}` + hash;
}

// On the web the repo lives in the path, like on github.com: /owner/repo[/blob|tree/<ref>/<path>].
// A GitHub-style URL is rewritten to /owner/repo?ref=<ref>#<path>, the form the reader uses.
function webTarget() {
  const [owner, repo, kind, ref, ...rest] = location.pathname.split('/').filter(Boolean).map(decode);
  if (!repo) return null;
  const target = { repo: `${owner}/${repo.replace(/\.git$/, '')}`, ref: new URLSearchParams(location.search).get('ref') };
  if ((kind === 'blob' || kind === 'tree') && ref) {
    const href = readerHref({ ...target, ref, path: rest.join('/') });
    history.replaceState(null, '', location.hash ? href.replace(/#.*$/, '') + location.hash : href);
    target.ref = ref;
  }
  return target;
}

async function loadToken() {
  if (!IS_EXT) return store.get('token', '');
  try { return (await chrome.storage.local.get('token')).token || ''; } catch { return ''; }
}

// ---------- github fetch ----------
async function gh(url, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(url, { headers });
  if (res.ok) return res;

  let msg = `GitHub responded with ${res.status}.`;
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
    msg = `GitHub rate limit reached (resets at ${reset.toLocaleTimeString()}). Add a token ${TOKEN_HINT} for a higher limit.`;
  } else if (res.status === 404) {
    msg = state.token
      ? 'Not found. Check the repo / branch name, or the token permissions.'
      : `Not found. If the repo is private, add a token ${TOKEN_HINT}.`;
  } else if (res.status === 401) {
    msg = `GitHub rejected the token. Check it ${TOKEN_HINT}.`;
  }
  throw new Error(msg);
}

async function loadTree() {
  const cacheKey = repoKey('tree');
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey));
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.tree;
  } catch {}

  const url = `https://api.github.com/repos/${state.owner}/${state.repo}/git/trees/${encPath(state.ref)}?recursive=1`;
  const data = await (await gh(url)).json();
  if (data.truncated) toast('Repo is very large, some files are not shown');
  const tree = data.tree.map(({ path, type, size }) => ({ path, type, size }));
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), tree })); } catch {}
  return tree;
}

async function fetchFile(path, as = 'text') {
  const res = state.token
    ? await gh(`https://api.github.com/repos/${state.owner}/${state.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(state.ref)}`, 'application/vnd.github.raw')
    : await fetch(rawUrl(path)).then((r) => { if (!r.ok) throw new Error(`Failed to load file (${r.status}).`); return r; });
  return as === 'blob' ? res.blob() : res.text();
}

// ---------- tree ----------
const isReadme = (n) => /^readme(\.|$)/i.test(n.name) && n.type === 'blob';
const ordinal = (name) => (name.match(/^\D*\d+/) || [name])[0];

// Reading-friendly order for numbered notes: "EVM 01 - X.md", then folder "EVM 01 - Detail",
// then "EVM 02 ...". README always comes first.
function compareNodes(a, b) {
  if (isReadme(a) !== isReadme(b)) return isReadme(a) ? -1 : 1;
  const byOrdinal = collator.compare(ordinal(a.name), ordinal(b.name));
  if (byOrdinal) return byOrdinal;
  if (a.type !== b.type) return a.type === 'blob' ? -1 : 1;
  return collator.compare(a.name, b.name);
}

function buildTree(entries) {
  const root = { name: '', path: '', type: 'tree', children: [] };
  state.nodes.clear();
  state.nodes.set('', root);
  for (const e of entries) {
    if (hidden(e.path) || e.type === 'commit') continue;
    state.nodes.set(e.path, { ...e, name: basename(e.path), children: e.type === 'tree' ? [] : null });
  }
  for (const node of state.nodes.values()) {
    if (node === root) continue;
    state.nodes.get(dirname(node.path))?.children.push(node);
  }
  for (const node of state.nodes.values()) node.children?.sort(compareNodes);
  state.root = root;

  const files = [];
  (function walk(n) { for (const c of n.children) c.type === 'tree' ? walk(c) : files.push(c); })(root);
  const md = files.filter((f) => MD_EXT.test(f.name));
  state.order = (md.length ? md : files).map((f) => f.path);
}

function renderTree() {
  const done = new Set(store.get(repoKey('done'), []));
  const build = (node) => {
    const ul = document.createElement('ul');
    for (const c of node.children) {
      const li = document.createElement('li');
      if (c.type === 'tree') {
        const details = document.createElement('details');
        details.dataset.path = c.path;
        const summary = document.createElement('summary');
        summary.textContent = c.name;
        summary.title = c.path;
        details.append(summary, build(c));
        li.append(details);
      } else {
        li.append(fileLink(c, done.has(c.path)), splitButton(c.path));
      }
      ul.append(li);
    }
    return ul;
  };
  treeEl.replaceChildren(build(state.root));
  markTree();
}

function fileLink(node, isDone, label = node.name) {
  const a = document.createElement('a');
  a.href = '#' + encPath(node.path);
  a.textContent = MD_EXT.test(label) ? label.replace(MD_EXT, '') : label;
  a.title = node.path;
  a.dataset.path = node.path;
  if (MD_EXT.test(node.name)) a.classList.add('md');
  if (isDone) a.classList.add('done');
  return a;
}

function splitButton(path) {
  const btn = document.createElement('button');
  btn.className = 'split-btn';
  btn.textContent = 'Split';
  btn.title = 'Open in the other pane (Shift+click)';
  btn.dataset.split = path;
  return btn;
}

const treeLink = (path) => [...treeEl.querySelectorAll('a[data-path]')].find((a) => a.dataset.path === path);

// Mark the file in the active pane (active) and the one in the other pane (other).
function markTree() {
  treeEl.querySelectorAll('a.active, a.other').forEach((a) => a.classList.remove('active', 'other'));
  const other = isSplit() ? panes[1 - state.active].current : null;
  if (other) treeLink(other)?.classList.add('other');

  const link = treeLink(panes[state.active].current);
  if (!link) return;
  link.classList.add('active');
  for (let el = link.parentElement; el && el !== treeEl; el = el.parentElement) {
    if (el.tagName === 'DETAILS') el.open = true;
  }
  link.scrollIntoView({ block: 'nearest' });
}

function markDone(path) {
  const key = repoKey('done');
  const done = new Set(store.get(key, []));
  if (done.has(path)) return;
  done.add(path);
  store.set(key, [...done]);
  treeLink(path)?.classList.add('done');
}

// ---------- filter ----------
function runFilter() {
  const terms = filterEl.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) { renderTree(); return; }
  const hits = [...state.nodes.values()]
    .filter((n) => n.type === 'blob' && terms.every((t) => n.path.toLowerCase().includes(t)))
    .sort((a, b) => collator.compare(a.path, b.path))
    .slice(0, 200);
  const ul = document.createElement('ul');
  for (const n of hits) {
    const li = document.createElement('li');
    li.append(fileLink(n, false, n.path), splitButton(n.path));
    ul.append(li);
  }
  treeEl.replaceChildren(hits.length ? ul : Object.assign(document.createElement('div'), { className: 'hint', textContent: 'No matching files' }));
}

function clearFilter() {
  if (!filterEl.value) return;
  filterEl.value = '';
  runFilter();
}

// ---------- panes ----------
function createPane(idx) {
  const el = $('#pane-template').content.firstElementChild.cloneNode(true);
  el.dataset.pane = idx;
  $('#main').append(el);
  const pane = {
    idx, el,
    crumb: el.querySelector('.crumb-text'),
    doc: el.querySelector('.doc'),
    pager: el.querySelector('.pager'),
    progress: el.querySelector('.progress'),
    current: null,
    pendingAnchor: '',
  };

  el.addEventListener('pointerdown', () => setActive(idx));
  el.querySelector('.close').addEventListener('click', () => closePane(idx));

  let scrollSave;
  el.addEventListener('scroll', () => {
    updateProgress(pane);
    clearTimeout(scrollSave);
    scrollSave = setTimeout(() => store.set(repoKey('scroll:' + pane.current), Math.round(el.scrollTop)), 300);
  }, { passive: true });

  pane.doc.addEventListener('click', (e) => onDocClick(e, pane));
  pane.pager.addEventListener('click', (e) => onDocClick(e, pane));
  return pane;
}

const panes = [createPane(0), createPane(1)];
const isSplit = () => !panes[1].el.hidden;
const otherPane = (idx) => (window.innerWidth < NARROW ? 0 : 1 - idx);

function setActive(idx) {
  if (idx === 1 && !isSplit()) idx = 0;
  if (state.active === idx) return;
  state.active = idx;
  panes.forEach((p) => p.el.classList.toggle('active', p.idx === idx));
  markTree();
  updateTitle();
}

function updateTitle() {
  const path = panes[state.active].current;
  document.title = `${path ? title(path) : state.repo} · ${state.owner}/${state.repo}`;
}

// ---------- routing ----------
// Hash: "#left" or "#left::right" (each path encoded).
function readHash() {
  const [left = '', right = ''] = location.hash.slice(1).split(SPLIT_SEP);
  return [decode(left), decode(right)];
}

function writeHash(left, right, replace = false) {
  const hash = '#' + encPath(left) + (right ? SPLIT_SEP + encPath(right) : '');
  if (replace) history.replaceState(null, '', hash);
  else if (location.hash !== hash) location.hash = hash;
  else sync();
}

function openPath(idx, path, anchor = '') {
  if (window.innerWidth < NARROW) idx = 0;
  const [left, right] = readHash();
  panes[idx].pendingAnchor = anchor;
  state.active = idx; // applied to the view by sync()
  writeHash(...(idx === 0 ? [path, isSplit() ? right : ''] : [left || panes[0].current, path]));
}

function closePane(idx) {
  const [left, right] = readHash();
  state.active = 0;
  writeHash(idx === 0 ? right : left, '');
}

function defaultPath() {
  const last = store.get(repoKey('last'), null);
  if (last && state.nodes.has(last)) return last;
  const readme = state.root.children.find(isReadme);
  return readme ? readme.path : state.order[0] || '';
}

function sync({ restoreScroll = false } = {}) {
  let [left, right] = readHash();
  if (!left) {
    left = defaultPath();
    restoreScroll = true;
    writeHash(left, right, true);
  }

  const split = Boolean(right) && window.innerWidth >= NARROW;
  document.body.classList.toggle('split', split);
  panes[1].el.hidden = !split;
  if (!split) state.active = 0;
  panes.forEach((p) => p.el.classList.toggle('active', p.idx === state.active));

  showPath(panes[0], left, restoreScroll);
  if (split) showPath(panes[1], right, restoreScroll);
  else panes[1].current = null;
  markTree();
  updateTitle();
}

async function showPath(pane, path, restoreScroll) {
  let node = state.nodes.get(path);
  if (node?.type === 'tree') {
    const readme = node.children.find(isReadme);
    if (readme) {
      node = readme;
      path = readme.path;
      const [left, right] = readHash();
      writeHash(pane.idx === 0 ? path : left, pane.idx === 1 ? path : right, true);
    }
  }

  if (pane.current === path) {
    if (pane.pendingAnchor) scrollToAnchor(pane);
    return;
  }
  pane.current = path;
  pane.crumb.textContent = path ? path.split('/').join('  /  ') : `${state.owner}/${state.repo}`;
  pane.pager.replaceChildren();
  pane.el.scrollTop = 0;

  if (!node) {
    pane.doc.replaceChildren(notice(`"${path}" does not exist in this repo.`, githubUrl(path)));
    return;
  }
  if (node.type === 'tree') {
    renderFolder(pane, node);
    return;
  }

  pane.doc.replaceChildren(notice('Loading…'));
  try {
    await renderFile(pane, node);
  } catch (err) {
    if (pane.current === path) pane.doc.replaceChildren(notice(err.message, githubUrl(path)));
    return;
  }
  if (pane.current !== path) return; // navigated elsewhere while loading

  renderPager(pane);
  if (pane.idx === state.active) store.set(repoKey('last'), path);
  if (window.innerWidth < NARROW) document.body.classList.add('side-hidden');

  if (pane.pendingAnchor) {
    scrollToAnchor(pane);
  } else if (restoreScroll) {
    const y = store.get(repoKey('scroll:' + path), 0);
    requestAnimationFrame(() => { pane.el.scrollTop = y; });
  }
  updateProgress(pane);
}

function scrollToAnchor(pane, smooth = false) {
  const id = pane.pendingAnchor;
  pane.pendingAnchor = '';
  pane.doc.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
}

function go(offset) {
  const pane = panes[state.active];
  const i = state.order.indexOf(pane.current);
  const next = state.order[i < 0 ? 0 : i + offset];
  if (next) openPath(pane.idx, next);
}

// ---------- markdown ----------
function slugify(text, used) {
  let slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const base = slug;
  for (let i = 1; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

// Relative markdown link → repo path (+ anchor). null when the link leaves the repo.
function resolveLink(href, fromPath) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    const m = href.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/[^/]+\/([^#?]*)(#.*)?$/i);
    if (m && m[1].toLowerCase() === state.owner.toLowerCase() && m[2].toLowerCase() === state.repo.toLowerCase()) {
      return { path: decodeURIComponent(m[3]).replace(/\/$/, ''), anchor: (m[4] || '').slice(1) };
    }
    return null;
  }
  const base = 'https://repo.invalid/' + encPath(dirname(fromPath)) + (dirname(fromPath) ? '/' : '');
  const url = new URL(href, base);
  return { path: decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, ''), anchor: decodeURIComponent(url.hash.slice(1)) };
}

function renderMarkdown(pane, source, path) {
  const doc = pane.doc;
  source = source.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // YAML frontmatter
  doc.innerHTML = DOMPurify.sanitize(marked.parse(source, { gfm: true }));

  const used = new Set();
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => { h.id = slugify(h.textContent, used); });

  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) { a.dataset.anchor = decode(href.slice(1)); return; }
    const target = resolveLink(href, path);
    if (target && state.nodes.has(target.path)) {
      a.href = '#' + encPath(target.path);
      a.dataset.path = target.path;
      if (target.anchor) a.dataset.anchor = target.anchor;
    } else if (target) {
      a.href = githubUrl(target.path);
      a.target = '_blank';
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });

  doc.querySelectorAll('img[src]').forEach((img) => {
    const target = resolveLink(img.getAttribute('src'), path);
    if (!target) return;
    if (state.token) {
      img.removeAttribute('src');
      fetchFile(target.path, 'blob').then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
    } else {
      img.src = rawUrl(target.path);
    }
  });

  doc.querySelectorAll('table').forEach((t) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  });

  doc.querySelectorAll('pre > code').forEach(decorateCode);
}

// highlight.js leaves command names and flags in bash blocks uncolored. Color the command at the
// start of a line or after | ; & (except shell keywords and builtins) and every -x / --flag.
// This runs before the first highlight, while the bash grammar is not compiled yet.
const bash = hljs.getLanguage('bash');
const shellWords = [...bash.keywords.keyword, ...bash.keywords.built_in]
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
bash.contains.push(
  { scope: 'title', match: new RegExp('(?<=^[ \\t]*|[|;&][ \\t]*)(?!(?:' + shellWords.join('|') + ')\\b)[A-Za-z_./][\\w./-]*') },
  { scope: 'attr', match: /(?<=[ \t])--?[A-Za-z][\w-]*/ },
);

function decorateCode(code) {
  const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9);
  if (lang === 'mermaid') { renderMermaid(code); return; }
  if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(code.textContent).then(() => toast('Copied'));
  });
  code.parentElement.append(btn);
}

// Mermaid diagrams are drawn by Pele. mount() shows parse errors inside the box itself.
function renderMermaid(code) {
  const box = document.createElement('div');
  box.className = 'mermaid';
  code.parentElement.replaceWith(box);
  pele.mount(box, code.textContent, {
    sanitize: (svg) => DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, RETURN_DOM_FRAGMENT: true }),
  });
}

// ---------- views ----------
function internalLink(path, text) {
  const a = document.createElement('a');
  a.href = '#' + encPath(path);
  a.dataset.path = path;
  a.textContent = text;
  return a;
}

function renderFolder(pane, node) {
  pane.doc.className = 'doc';
  const h = document.createElement('h1');
  h.textContent = node.name || state.repo;
  const ul = document.createElement('ul');
  ul.className = 'folder-list';
  for (const c of node.children) {
    const li = document.createElement('li');
    li.append(internalLink(c.path, c.type === 'tree' ? c.name + '/' : c.name.replace(MD_EXT, '')));
    ul.append(li);
  }
  pane.doc.replaceChildren(h, ul);
}

function notice(text, link) {
  const p = document.createElement('p');
  p.className = 'notice';
  p.textContent = text + ' ';
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.textContent = 'Open on GitHub';
    p.append(a);
  }
  return p;
}

async function renderFile(pane, node) {
  const { path } = node;
  pane.doc.className = 'doc';

  if (IMG_EXT.test(path)) {
    const img = document.createElement('img');
    img.alt = node.name;
    if (state.token) fetchFile(path, 'blob').then((b) => { img.src = URL.createObjectURL(b); });
    else img.src = rawUrl(path);
    pane.doc.replaceChildren(img);
    return;
  }
  if (BINARY_EXT.test(path) || node.size > MAX_TEXT_SIZE) {
    pane.doc.replaceChildren(notice('This file cannot be shown in the reader.', githubUrl(path)));
    return;
  }

  const text = await fetchFile(path);
  if (pane.current !== path) return;

  if (MD_EXT.test(path)) {
    renderMarkdown(pane, text, path);
  } else {
    pane.doc.className = 'doc code-file';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext) code.className = `language-${ext}`;
    code.textContent = text;
    pre.append(code);
    pane.doc.replaceChildren(pre);
    decorateCode(code);
  }
}

function renderPager(pane) {
  const i = state.order.indexOf(pane.current);
  if (i < 0) return;
  const make = (p, cls, label) => {
    const a = internalLink(p, '');
    a.className = cls;
    a.title = p;
    const small = document.createElement('small');
    small.textContent = label;
    const span = document.createElement('span');
    span.textContent = title(p);
    a.append(small, span);
    return a;
  };
  pane.pager.append(i > 0 ? make(state.order[i - 1], 'prev', '← Previous') : document.createElement('span'));
  if (i < state.order.length - 1) pane.pager.append(make(state.order[i + 1], 'next', 'Next →'));
}

// ---------- scroll progress ----------
function updateProgress(pane) {
  const el = pane.el;
  const max = el.scrollHeight - el.clientHeight;
  const ratio = max > 0 ? Math.min(1, el.scrollTop / max) : 1;
  pane.progress.style.transform = `scaleX(${ratio})`;
  if (ratio > 0.9 && pane.doneFor !== pane.current && MD_EXT.test(pane.current || '')) {
    pane.doneFor = pane.current;
    markDone(pane.current);
  }
}

// ---------- keyboard scrolling ----------
// The browser's own ↑/↓ scrolling moves in 40px steps at the key-repeat rate, which stutters.
// Instead, holding a key glides the active pane at a steady speed and releasing eases it out.
const GLIDE_SPEED = 700; // px/s
const GLIDE_ACCEL = 8000; // px/s²
const glide = { dir: 0, v: 0, y: 0, last: 0, el: null, raf: 0 };

function startGlide(dir) {
  const el = panes[state.active].el;
  glide.dir = dir;
  if (glide.raf && glide.el === el) return;
  cancelAnimationFrame(glide.raf);
  Object.assign(glide, { el, v: 0, y: el.scrollTop, last: performance.now() });
  glide.raf = requestAnimationFrame(glideFrame);
}

function glideFrame(t) {
  const el = glide.el;
  const dt = Math.min(0.05, (t - glide.last) / 1000);
  glide.last = t;
  // Something else moved the pane (trackpad, anchor link): continue from there.
  if (Math.abs(el.scrollTop - glide.y) > 2) glide.y = el.scrollTop;

  const target = glide.dir * GLIDE_SPEED;
  const step = GLIDE_ACCEL * dt * (glide.dir ? 1 : 3);
  glide.v = glide.v < target ? Math.min(target, glide.v + step) : Math.max(target, glide.v - step);

  const max = el.scrollHeight - el.clientHeight;
  glide.y = Math.max(0, Math.min(max, glide.y + glide.v * dt));
  el.scrollTop = glide.y;

  const atEdge = (glide.v < 0 && glide.y === 0) || (glide.v > 0 && glide.y === max);
  if ((!glide.dir && !glide.v) || (atEdge && !glide.dir)) { glide.raf = 0; glide.v = 0; return; }
  if (atEdge) glide.v = 0;
  glide.raf = requestAnimationFrame(glideFrame);
}

// ---------- events ----------
// Plain click: open in the same pane. Shift+click: the other pane.
// Cmd/Ctrl/middle click is left to the browser (opens a new tab).
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey;

function onDocClick(e, pane) {
  const a = e.target.closest('a[href]');
  if (!a || !plainClick(e)) return;
  if (a.dataset.path !== undefined) {
    e.preventDefault();
    openPath(e.shiftKey ? otherPane(pane.idx) : pane.idx, a.dataset.path, a.dataset.anchor || '');
  } else if (a.dataset.anchor !== undefined) {
    e.preventDefault();
    pane.pendingAnchor = a.dataset.anchor;
    scrollToAnchor(pane, true);
  }
}

treeEl.addEventListener('click', (e) => {
  const splitBtn = e.target.closest('[data-split]');
  if (splitBtn) {
    openPath(otherPane(state.active), splitBtn.dataset.split);
    clearFilter();
    return;
  }
  const a = e.target.closest('a[data-path]');
  if (!a || !plainClick(e)) return;
  e.preventDefault();
  openPath(e.shiftKey ? otherPane(state.active) : state.active, a.dataset.path);
  clearFilter();
});

$('#side-toggle').addEventListener('click', () => document.body.classList.remove('side-hidden'));
$('#scrim').addEventListener('click', () => document.body.classList.add('side-hidden'));

filterEl.addEventListener('input', runFilter);
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { clearFilter(); filterEl.blur(); }
  if (e.key === 'Enter') {
    const first = treeEl.querySelector('a[data-path]');
    if (!first) return;
    openPath(e.shiftKey ? otherPane(state.active) : state.active, first.dataset.path);
    clearFilter();
    filterEl.blur();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea') || $('#settings').open || ($('#help').open && e.key !== '?')) return;
  if (document.body.classList.contains('landing')) return;

  switch (e.key) {
    case 'ArrowLeft': go(-1); break;
    case 'ArrowRight': go(1); break;
    case 'ArrowUp': case 'ArrowDown':
      e.preventDefault();
      if (!e.repeat) startGlide(e.key === 'ArrowDown' ? 1 : -1);
      break;
    case 'b': case '\\': document.body.classList.toggle('side-hidden'); break;
    case 's':
      if (isSplit()) closePane(1);
      else if (window.innerWidth >= NARROW) openPath(1, panes[0].current);
      break;
    case '1': setActive(0); break;
    case '2': setActive(1); break;
    case '/':
      e.preventDefault();
      document.body.classList.remove('side-hidden');
      filterEl.focus();
      break;
    case '+': case '=': case '-': {
      const size = Math.max(14, Math.min(28, store.get('fontSize', 19) + (e.key === '-' ? -1 : 1)));
      store.set('fontSize', size);
      applyPrefs();
      toast(`Font size ${size}px`);
      break;
    }
    case 't': {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(store.get('theme', 'auto')) + 1) % order.length];
      store.set('theme', next);
      applyPrefs();
      toast({ auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' }[next]);
      break;
    }
    case 'g': {
      const path = panes[state.active].current || '';
      window.open(githubUrl(path, state.nodes.get(path)?.type === 'tree' ? 'tree' : 'blob'), '_blank');
      break;
    }
    case '?': {
      const help = $('#help');
      help.open ? help.close() : help.showModal();
      break;
    }
    default: return;
  }
});
document.addEventListener('keyup', (e) => {
  if ((e.key === 'ArrowDown' && glide.dir === 1) || (e.key === 'ArrowUp' && glide.dir === -1)) glide.dir = 0;
});
window.addEventListener('blur', () => { glide.dir = 0; });
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') e.target.close(); });

// Token settings for the web version (the extension has its own options page).
document.querySelectorAll('.settings-btn').forEach((b) => b.addEventListener('click', () => {
  $('#token').value = store.get('token', '');
  $('#settings').returnValue = '';
  $('#settings').showModal();
}));
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const token = $('#token').value.trim();
  if (token === store.get('token', '')) return;
  if (token) store.set('token', token);
  else try { localStorage.removeItem('token'); } catch {}
  location.reload();
});

window.addEventListener('hashchange', () => sync());

// ---------- start ----------
function showLanding() {
  document.body.classList.add('landing');
  $('#landing').hidden = false;
  document.title = 'Reader';
  if (!IS_EXT) $('#landing-hint').textContent = `Or replace github.com with ${location.host} in any GitHub URL.`;
  renderRecent();
  $('#open-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = parseRepoInput($('#repo-input').value);
    if (target) location.href = readerHref(target);
    else toast('Format: owner/repo or a GitHub URL');
  });
}

async function init() {
  applyPrefs();
  const params = new URLSearchParams(location.search);
  if (!IS_EXT) {
    document.body.classList.add('web');
    navigator.serviceWorker?.register('/sw.js').catch(() => {});
    // Installed as an app, a GitHub link shared to it arrives as /?url=…&text=…
    const shared = [params.get('url'), params.get('text')].join(' ').match(/https?:\/\/(?:www\.)?github\.com\/\S+/i);
    const sharedTarget = shared && parseRepoInput(shared[0]);
    if (sharedTarget) { location.replace(readerHref(sharedTarget)); return; }
  }
  const target = IS_EXT ? params.get('repo') && parseRepoInput(params.get('repo')) : webTarget();
  if (!target) { showLanding(); return; }

  [state.owner, state.repo] = target.repo.split('/');
  state.ref = target.ref || params.get('ref') || 'HEAD';
  if (window.innerWidth < NARROW) document.body.classList.add('side-hidden');
  panes[1].el.hidden = true;

  state.token = await loadToken();

  $('#repo-name').textContent = `${state.owner}/${state.repo}` + (state.ref !== 'HEAD' ? ` @ ${state.ref}` : '');
  $('#repo-name').href = IS_EXT ? 'reader.html' : '/';
  panes[0].crumb.textContent = `${state.owner}/${state.repo}`;
  panes[0].doc.replaceChildren(notice('Loading file list…'));

  try {
    buildTree(await loadTree());
  } catch (err) {
    panes[0].doc.replaceChildren(notice(err.message, githubUrl('')));
    return;
  }
  renderTree();
  rememberRepo();
  sync({ restoreScroll: true });
}

init();
