import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workItemAri, PULL_REQUESTS, GOALS } from '../src/platform/twg.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * These are drift guards, not behaviour tests.
 *
 * Teamwork Graph fails quietly: a missing scope returns an empty result, and a
 * field that does not exist on the object type is an error this adapter catches
 * and reports as "context is partial". Either way the briefing just gets
 * thinner, so a wrong field or a dropped scope would never be noticed by
 * looking at the app. Pinning them here is the only place it fails loudly.
 */

test('a work item is identified by ARI, and nothing is guessed', () => {
  assert.equal(workItemAri('cloud-1', '10412'), 'ari:cloud:jira:cloud-1:issue/10412');
  assert.equal(workItemAri('cloud-1', null), null);
  assert.equal(workItemAri(null, '10412'), null);
});

test('the pull-request query asks only for fields the object type has', () => {
  // ExternalPullRequest exposes `status`. `state` reads like the obvious name
  // and is not a field, so asking for it fails the whole query.
  assert.match(PULL_REQUESTS, /jiraWorkItemLinkedExternalPullRequests/);
  assert.match(PULL_REQUESTS, /\.\.\. on ExternalPullRequest/);
  for (const field of ['id', 'title', 'status', 'url']) {
    assert.match(PULL_REQUESTS, new RegExp(`\\b${field}\\b`), `missing field ${field}`);
  }
  assert.doesNotMatch(PULL_REQUESTS, /\bstate\b/);
});

test('the goal query uses the curated field and a real goal field', () => {
  assert.match(GOALS, /jiraWorkItemGoals/);
  assert.match(GOALS, /\.\.\. on AtlassianGoal/);
  // AtlassianGoal has `name`; `title` belongs to other object types.
  assert.match(GOALS, /\bname\b/);
  assert.doesNotMatch(GOALS, /\btitle\b/);
});

test('the manifest grants a scope for every object type those queries touch', async () => {
  const manifest = await readFile(join(repo, 'manifest.yml'), 'utf8');
  const granted = new Set(
    manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^- (read|write|storage|manage|app|act):/.test(line))
      .map((line) => line.slice(2).trim()),
  );

  // The work item each query starts from, plus what each one returns.
  for (const scope of [
    'read:graph:issue:jira',
    'read:graph:pull-request:external',
    'read:graph:goal:atlassian',
  ]) {
    assert.ok(granted.has(scope), `manifest is missing ${scope}`);
  }
  // Plain Jira for the panel and the writes, app storage for the ledger.
  for (const scope of ['read:jira-work', 'write:jira-work', 'storage:app']) {
    assert.ok(granted.has(scope), `manifest is missing ${scope}`);
  }
});

test('every Rovo action is wired to its own named handler', async () => {
  const manifest = await readFile(join(repo, 'manifest.yml'), 'utf8');
  const routes = [
    ['request-warrant', 'request-warrant-fn', 'requestWarrant'],
    ['check-warrant', 'check-warrant-fn', 'checkWarrant'],
    ['perform-change', 'perform-change-fn', 'performChange'],
    ['list-warrants', 'list-warrants-fn', 'listWarrants'],
  ];

  for (const [action, fn, handler] of routes) {
    assert.match(
      manifest,
      new RegExp(`- key: ${action}\\n(?:.*\\n){0,3}\\s+function: ${fn}`),
      `${action} does not reference ${fn}`,
    );
    assert.match(
      manifest,
      new RegExp(`- key: ${fn}\\n\\s+handler: index\\.${handler}`),
      `${fn} does not reference index.${handler}`,
    );
  }
});
