// Turn github.com/<owner>/<repo>[/blob|tree/<ref>/<path>] into a reader URL.
// GitHub paths that are not repos (settings, notifications, etc.) are ignored.
const NON_REPO = new Set([
  'settings', 'notifications', 'explore', 'marketplace', 'pulls', 'issues',
  'search', 'login', 'orgs', 'sponsors', 'topics', 'trending', 'codespaces', 'new',
]);

function readerUrlFor(tabUrl) {
  let u;
  try { u = new URL(tabUrl); } catch { return null; }
  if (u.hostname !== 'github.com') return null;

  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || NON_REPO.has(parts[0])) return null;

  const [owner, repo, kind, ref, ...rest] = parts;
  const params = new URLSearchParams({ repo: `${owner}/${repo.replace(/\.git$/, '')}` });
  if ((kind === 'blob' || kind === 'tree') && ref) params.set('ref', ref);

  const hash = (kind === 'blob' || kind === 'tree') && rest.length ? '#' + encodeURIComponent(rest.join('/')) : '';
  return chrome.runtime.getURL(`reader.html?${params}${hash}`);
}

chrome.action.onClicked.addListener((tab) => {
  const url = tab.url && readerUrlFor(tab.url);
  if (url) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') });
});
