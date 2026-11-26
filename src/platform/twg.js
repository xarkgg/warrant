/**
 * Teamwork Graph adapter.
 *
 * Jira tells you what an issue says. The graph tells you what is attached to it
 * that Jira cannot see: the pull request waiting to merge, the goal the team is
 * tracking. That difference is the reason the grant card is worth reading.
 *
 * Everything here is best-effort. Scopes are granted per object type, and a
 * missing scope returns empty rather than an error (the docs are explicit: "a
 * query that reads an object type you weren't granted comes back successful and
 * empty"). So the graph can degrade the blast radius, never block a grant, and
 * `unavailable` counts failures so the UI can say context is partial. An empty
 * result is genuinely ambiguous, which is why the card says what turned up
 * rather than what exists.
 */

import forgeApi from '@forge/api';

const { asUser } = forgeApi;

// Exported so a test can pin the exact fields we ask for: a field that does not
// exist on the object type is a GraphQL error, which this adapter turns into a
// thinner briefing — the failure would otherwise be invisible.
export const PULL_REQUESTS = `
  query Warrant_pullRequests($id: ID!) {
    jiraWorkItemLinkedExternalPullRequests(id: $id, first: 25) {
      edges {
        node {
          ... on ExternalPullRequest {
            id
            title
            status
            url
          }
        }
      }
    }
  }
`;

export const GOALS = `
  query Warrant_goals($id: ID!) {
    jiraWorkItemGoals(id: $id, first: 25) {
      edges {
        node {
          ... on AtlassianGoal {
            id
            name
          }
        }
      }
    }
  }
`;

/** Teamwork Graph identifies a Jira work item by ARI, not by key. */
export function workItemAri(cloudId, issueId) {
  if (!cloudId || !issueId) return null;
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

export function enabled() {
  return String(process.env.WARRANT_TWG || 'on').toLowerCase() !== 'off';
}

async function query(gql, variables) {
  const res = await asUser().requestTeamworkGraph(gql, variables);
  const json = await res.json();
  if (json?.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; ').slice(0, 200));
  }
  return json?.data || {};
}

function edges(data, field) {
  return (data?.[field]?.edges || []).map((e) => e?.node).filter(Boolean);
}

export async function pullRequests(ari) {
  if (!enabled() || !ari) return [];
  const data = await query(PULL_REQUESTS, { id: ari });
  return edges(data, 'jiraWorkItemLinkedExternalPullRequests')
    .filter((pr) => !/merged|closed|declined/i.test(String(pr.status || '')))
    .map((pr) => ({
      id: pr.id,
      title: pr.title || pr.displayName || 'A pull request',
      // The graph calls it `status`; the rest of the app reads `state`.
      state: String(pr.status || 'OPEN'),
      url: pr.url,
    }));
}

export async function goals(ari) {
  if (!enabled() || !ari) return [];
  const data = await query(GOALS, { id: ari });
  return edges(data, 'jiraWorkItemGoals').map((goal) => ({ title: goal.name || 'A goal' }));
}

/**
 * Enrich a set of Jira issues with graph context, bounded in parallel and
 * never throwing upwards.
 *
 * A failure is swallowed so it cannot block a grant, but it is logged, because
 * otherwise the two very different causes look identical from the app: "this
 * issue has nothing linked" and "the query was refused". `forge logs` is the
 * only place that distinction exists.
 */
export async function enrich(issues, cloudId, { concurrency = 5 } = {}) {
  if (!enabled()) return { issues, unavailable: 0 };
  let unavailable = 0;

  const out = [];
  const queue = [...issues];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const issue = queue.shift();
      const ari = workItemAri(cloudId, issue.id);
      if (!ari) {
        // No site id means no graph call at all. Silent by default, so say so.
        unavailable += 1;
        console.error(`[warrant] no cloudId, so the graph was not asked about ${issue.key}`);
        out.push({ ...issue, unmergedPrs: [], goals: [] });
        continue;
      }
      const [prs, goalList] = await Promise.all([
        pullRequests(ari).catch((error) => {
          unavailable += 1;
          console.error(`[warrant] graph pull-request lookup failed for ${issue.key}: ${error.message}`);
          return [];
        }),
        goals(ari).catch((error) => {
          unavailable += 1;
          console.error(`[warrant] graph goal lookup failed for ${issue.key}: ${error.message}`);
          return [];
        }),
      ]);
      out.push({ ...issue, unmergedPrs: prs, goals: goalList });
    }
  });

  await Promise.all(workers);
  out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { issues: out, unavailable };
}
