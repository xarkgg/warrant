/**
 * Jira REST adapter.
 *
 * Everything runs `asUser`, so a write carries the permissions of the human the
 * agent is acting for. The app never asks for more reach than the person
 * already has — a warrant narrows authority, it must never widen it.
 *
 * Only the calls the product actually needs are here. Each one returns plain
 * objects so the rest of the codebase never sees a Jira JSON shape.
 */

import forgeApi from '@forge/api';

/**
 * `@forge/api` ships as CommonJS with its named exports defined as getters, so
 * Node's ESM loader cannot see them as named exports. A default import gives
 * the exports object in both Node (tests) and Forge's esbuild bundle, which is
 * the only form that works in both places.
 */
const { asUser, route } = forgeApi;

const FIELDS = [
  'summary',
  'status',
  'assignee',
  'priority',
  'labels',
  'updated',
  'issuelinks',
  'reporter',
  'created',
].join(',');

async function request(path, options = {}) {
  const res = await asUser().requestJira(path, options);
  if (!res.ok) {
    const detail = await safeText(res);
    const error = new Error(`Jira ${res.status} for ${options.method || 'GET'}: ${detail}`);
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function safeText(res) {
  try {
    const text = await res.text();
    return String(text || '').slice(0, 300);
  } catch {
    return '(no body)';
  }
}

const adf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text) }] }],
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Resolve a JQL string into an explicit list of issue keys. */
export async function searchKeys(jql, { limit = 200 } = {}) {
  const keys = [];
  let nextPageToken = null;
  do {
    const path = nextPageToken
      ? route`/rest/api/3/search/jql?jql=${jql}&fields=key&maxResults=${Math.min(100, limit)}&nextPageToken=${nextPageToken}`
      : route`/rest/api/3/search/jql?jql=${jql}&fields=key&maxResults=${Math.min(100, limit)}`;
    const page = await request(path);
    for (const issue of page?.issues || []) keys.push(issue.key);
    nextPageToken = page?.nextPageToken || null;
    if (page?.isLast) nextPageToken = null;
  } while (nextPageToken && keys.length < limit);
  return keys.slice(0, limit);
}

/** One call for a whole set — the blast radius is computed from these. */
export async function getIssues(keys) {
  if (keys.length === 0) return [];
  const list = keys.map((k) => `"${k}"`).join(', ');
  const jql = `key in (${list})`;
  const page = await request(
    route`/rest/api/3/search/jql?jql=${jql}&fields=${FIELDS}&maxResults=${Math.min(100, keys.length)}`,
  );
  return (page?.issues || []).map((issue) => normaliseIssue(issue));
}

export async function getIssue(key) {
  const issue = await request(route`/rest/api/3/issue/${key}?fields=${FIELDS}`);
  return normaliseIssue(issue);
}

export async function getComments(key, { limit = 50 } = {}) {
  const page = await request(route`/rest/api/3/issue/${key}/comment?maxResults=${limit}`);
  return (page?.comments || []).map((c) => ({
    id: String(c.id),
    authorId: c.author?.accountId || null,
    authorName: c.author?.displayName || 'Someone',
    createdAt: c.created,
    body: extractText(c.body).slice(0, 400),
  }));
}

export async function getTransitions(key) {
  const data = await request(route`/rest/api/3/issue/${key}/transitions?expand=transitions.fields`);
  return (data?.transitions || []).map((t) => ({
    id: String(t.id),
    name: t.name,
    toStatusId: t.to?.id ? String(t.to.id) : null,
    toStatusName: t.to?.name || t.name,
  }));
}

export async function searchUsers(query) {
  const data = await request(route`/rest/api/3/user/search?query=${query}&maxResults=10`);
  return (data || []).map((u) => ({
    accountId: u.accountId,
    displayName: u.displayName,
    active: u.active,
    avatarUrl: u.avatarUrls?.['24x24'] || null,
  }));
}

// ---------------------------------------------------------------------------
// Writing (only ever called after a warrant says yes)
// ---------------------------------------------------------------------------

export async function transition(key, transitionId) {
  await request(route`/rest/api/3/issue/${key}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: String(transitionId) } }),
  });
  return { issueKey: key, statusId: null };
}

export async function addComment(key, text) {
  const data = await request(route`/rest/api/3/issue/${key}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: adf(text) }),
  });
  return { issueKey: key, commentId: data?.id ? String(data.id) : null };
}

export async function deleteComment(key, commentId) {
  await request(route`/rest/api/3/issue/${key}/comment/${commentId}`, { method: 'DELETE' });
  return { issueKey: key, commentId: String(commentId) };
}

export async function assign(key, accountId) {
  await request(route`/rest/api/3/issue/${key}/assignee`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accountId || null }),
  });
  return { issueKey: key, assigneeId: accountId || null };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export function normaliseIssue(issue) {
  const f = issue?.fields || {};
  return {
    id: issue?.id || null,
    key: issue?.key,
    summary: f.summary || '',
    status: f.status?.name || '',
    statusId: f.status?.id ? String(f.status.id) : null,
    statusCategory: f.status?.statusCategory?.name || '',
    assignee: f.assignee?.displayName || null,
    assigneeId: f.assignee?.accountId || null,
    reporter: f.reporter?.displayName || null,
    priority: f.priority?.name || '',
    labels: f.labels || [],
    updatedAt: f.updated || null,
    createdAt: f.created || null,
    links: readLinks(f.issuelinks || []),
  };
}

function readLinks(issuelinks) {
  const blocks = [];
  const blockedBy = [];
  for (const link of issuelinks) {
    const outward = link.type?.outward || '';
    const inward = link.type?.inward || '';
    if (link.outwardIssue && /block/i.test(outward) && !/is blocked/i.test(outward)) {
      const status = link.outwardIssue.fields?.status;
      if (!isDone(status)) blocks.push(link.outwardIssue.key);
    }
    if (link.inwardIssue && /is blocked by/i.test(inward)) {
      const status = link.inwardIssue.fields?.status;
      if (!isDone(status)) blockedBy.push(link.inwardIssue.key);
    }
  }
  return { blocks, blockedBy };
}

function isDone(status) {
  return /done|closed|complete/i.test(status?.statusCategory?.name || status?.name || '');
}

/** Atlassian Document Format back to a line of text, for size-of and previews. */
export function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (node.type === 'text') return node.text || '';
  if (node.content) return extractText(node.content);
  return '';
}
