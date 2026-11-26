/**
 * Drives the real renderer against real service output.
 *
 * The Custom UI cannot be opened outside Jira, so this serves `static/ui/` on
 * localhost with a fake Forge bridge in front of it. The fixtures are not hand
 * written: the real service runs in this process against a fake Jira, so what
 * the page renders is exactly the shape the deployed app will receive. If the
 * service changes shape, this probe fails instead of quietly passing.
 *
 *   npm run probe:ui
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createStore, memoryDriver } from '../src/store/store.js';
import * as service from '../src/service/warrants.js';
import { OPERATIONS } from '../src/domain/warrant.js';

const require = createRequire(import.meta.url);
const puppeteer = (() => {
  try {
    return require('puppeteer');
  } catch {
    return require('/data/data/com.termux/files/usr/lib/node_modules/puppeteer/lib/puppeteer/puppeteer.js');
  }
})();

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const ui = join(repo, 'static/ui');

// ---------------------------------------------------------------- fake Jira

const DAY = 86_400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function seedIssues() {
  return new Map(
    Object.entries({
      'PAY-412': {
        id: '10412',
        key: 'PAY-412',
        summary: 'Card form drops focus after the OTP field',
        status: 'In Progress',
        statusId: '3',
        statusCategory: 'In Progress',
        assignee: 'Dana Whitfield',
        assigneeId: 'acct-dana',
        priority: 'High',
        labels: ['customer'],
        updatedAt: iso(6 * 60 * 60 * 1000),
        lastCommentAt: iso(40 * 60 * 1000),
        lastCommentBy: 'Dana Whitfield',
        blocks: ['PAY-455', 'PAY-461'],
        blockedBy: [],
        unmergedPrs: [{ id: '8811', title: 'Stop re-rendering the OTP group', state: 'OPEN' }],
        goals: [],
      },
      'PAY-419': {
        id: '10419',
        key: 'PAY-419',
        summary: 'Refund export times out over 5k rows',
        status: 'To Do',
        statusId: '1',
        statusCategory: 'To Do',
        assignee: null,
        assigneeId: null,
        priority: 'Medium',
        labels: [],
        updatedAt: iso(9 * DAY),
        lastCommentAt: iso(9 * DAY),
        lastCommentBy: 'Sam Okoro',
        blocks: [],
        blockedBy: ['PAY-380'],
        unmergedPrs: [],
        goals: [{ title: 'Q4 refund accuracy' }],
      },
      'PAY-431': {
        id: '10431',
        key: 'PAY-431',
        summary: 'Typo in the settlement email footer',
        status: 'To Do',
        statusId: '1',
        statusCategory: 'To Do',
        assignee: null,
        assigneeId: null,
        priority: 'Low',
        labels: [],
        updatedAt: iso(63 * DAY),
        lastCommentAt: null,
        lastCommentBy: null,
        blocks: [],
        blockedBy: [],
        unmergedPrs: [],
        goals: [],
      },
    }),
  );
}

function fakeJira() {
  const issues = seedIssues();
  const writes = [];
  let seq = 900;
  const copy = (issue) => ({ ...issue, links: { blocks: issue.blocks, blockedBy: issue.blockedBy } });

  return {
    writes,
    issues,
    async getIssues(keys) {
      return keys.map((k) => issues.get(String(k).toUpperCase())).filter(Boolean).map(copy);
    },
    async getIssue(key) {
      const issue = issues.get(String(key).toUpperCase());
      if (!issue) throw new Error(`Jira 404 for ${key}`);
      return copy(issue);
    },
    async getComments(key) {
      const issue = issues.get(String(key).toUpperCase());
      if (!issue || !issue.lastCommentAt) return [];
      return [
        {
          id: 'c1',
          body: 'Reproduced on the staging build with the new SDK.',
          authorName: issue.lastCommentBy || 'Someone',
          createdAt: issue.lastCommentAt,
        },
      ];
    },
    async getTransitions(key) {
      const issue = issues.get(String(key).toUpperCase());
      if (issue.status === 'Done') return [];
      return [
        { id: '31', name: 'Start progress', toStatusId: '3', toStatusName: 'In Progress' },
        { id: '41', name: 'Done', toStatusId: '10000', toStatusName: 'Done' },
      ];
    },
    async searchUsers() {
      return [{ accountId: 'acct-dana', displayName: 'Dana Whitfield', active: true }];
    },
    async searchKeys() {
      return [];
    },
    async transition(key, id) {
      seq += 1;
      writes.push({ kind: 'transition', key, id });
      issues.get(key).status = 'Done';
      issues.get(key).statusId = '10000';
      return { issueKey: key, statusId: '10000' };
    },
    async addComment(key, text) {
      seq += 1;
      writes.push({ kind: 'comment', key, text });
      return { issueKey: key, commentId: String(seq) };
    },
    async deleteComment(key, id) {
      writes.push({ kind: 'deleteComment', key, id });
      return { issueKey: key, commentId: id };
    },
    async assign(key, accountId) {
      writes.push({ kind: 'assign', key, accountId });
      return { issueKey: key, assigneeId: accountId };
    },
  };
}

const fakeTwg = {
  enabled: () => true,
  async enrich(issues) {
    return { issues, unavailable: 0 };
  },
};

// ------------------------------------------------------------------- story

const HUMAN = { accountId: 'acct-human', accountName: 'Manass Kusko', cloudId: 'cloud-1' };
const AGENT = { accountId: 'acct-human', cloudId: 'cloud-1' };

async function buildFixtures() {
  const jira = fakeJira();
  const store = createStore(memoryDriver());
  const deps = { jira, twg: fakeTwg };

  // A: awaiting a signature, and worth reading before signing. It covers the
  // issue the panel is probed on, so both surfaces show the same request.
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: {
      operation: OPERATIONS.TRANSITION,
      issueKeys: ['PAY-412', 'PAY-431'],
      reason: 'Close out the card-form bug now the fix has shipped, and tidy the footer typo.',
      maxActions: 6,
      ttlMinutes: 240,
    },
  });

  // B: signed, so there is live authority and a real write to undo.
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: {
      operation: OPERATIONS.COMMENT,
      issueKeys: ['PAY-412'],
      reason: 'Post the profiler numbers on the card-form bug.',
      maxActions: 3,
      ttlMinutes: 90,
    },
  });
  const all = await store.listWarrants({ limit: 10 });
  const commentRequest = all.find((w) => w.request.operation === OPERATIONS.COMMENT);
  await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: commentRequest.id, maxActions: 2 },
  });

  // A write that happened inside the warrant: the ledger gains an undo.
  await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: {
      operation: OPERATIONS.COMMENT,
      issueKey: 'PAY-412',
      value: 'Profiler shows 4.1s in the row mapper; batching the join takes it to 600ms.',
    },
  });

  // A write the warrant does not cover: refused, and queued rather than dropped.
  await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.ASSIGN, issueKey: 'PAY-412', value: 'Dana Whitfield' },
  });

  const snapshot = await service.snapshot({ store, context: HUMAN, deps });
  const panel = await service.issueContext({
    store,
    deps,
    context: HUMAN,
    input: { issueKey: 'PAY-412' },
  });

  return { snapshot, panel };
}

// -------------------------------------------------------------- static host

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * The real bridge cannot work outside Atlassian: it looks for the parent frame
 * and logs a connection error. So the harness serves a stand-in at the same URL
 * the page asks for, and checks the real bundle separately.
 */
function serve(fixtures) {
  const fixtureScript = `
window.__fixtures = ${JSON.stringify(fixtures)};
window.forgeBridge = {
  invoke: function (name, payload) {
    var f = window.__fixtures;
    if (name === 'snapshot') return Promise.resolve(f.snapshot);
    if (name === 'issueContext') return Promise.resolve(f.panel);
    if (name === 'grant' || name === 'revoke' || name === 'decline') {
      return Promise.resolve({ ok: true, warrant: f.snapshot.warrants[0] });
    }
    if (name === 'resolvePending') return Promise.resolve({ ok: true, executed: 'PAY-431 moved to Done' });
    if (name === 'undo') return Promise.resolve({ ok: true });
    if (name === 'requestForIssue') return Promise.resolve({ ok: true, warrant: f.snapshot.warrants[0] });
    return Promise.resolve({ ok: false, error: 'unknown action ' + name });
  },
  view: {
    getContext: function () {
      if (location.search.indexOf('surface=panel') !== -1) {
        return Promise.resolve({ extension: { issue: { key: 'PAY-412', id: '10412' } } });
      }
      return Promise.resolve({ platformContext: { cloudId: 'cloud-1' } });
    },
    theme: { enable: function () { return Promise.resolve(); } },
  },
  router: { navigate: function () { return Promise.resolve(); } },
  events: { on: function () {} },
};
`;

  return new Promise((done) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';

      if (path === '/__fixture.js') {
        response.writeHead(200, { 'content-type': TYPES['.js'] });
        response.end(fixtureScript);
        return;
      }

      if (path === '/vendor/bridge.js') {
        response.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
        response.end(fixtureScript);
        return;
      }

      if (path === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      // Loads the genuine vendored bundle. It refuses to initialise without a
      // host, so the page installs the same `__bridge` shim Forge provides,
      // which is enough to prove the shipped file exposes the real API.
      if (path === '/__bundle-check.html') {
        response.writeHead(200, { 'content-type': TYPES['.html'] });
        response.end(`<!doctype html><meta charset="utf-8"><title>bridge</title>
<script>
  window.__calls = [];
  window.__bridge = {
    callBridge: function (method, args) {
      window.__calls.push(method);
      return Promise.resolve({ method: method, args: args });
    },
    callAsyncBridge: function () { return Promise.resolve({}); },
  };
</script>
<script src="/__real-bridge.js"></script>
<script>
  window.__bundle = window.forgeBridge ? Object.keys(window.forgeBridge) : null;
  window.__roundTrip = window.forgeBridge
    ? window.forgeBridge.invoke('snapshot', { probe: true }).then(function (r) {
        return { resolved: true, calls: window.__calls.slice() };
      }, function (e) { return { resolved: false, error: String(e && e.message) }; })
    : null;
</script>`);
        return;
      }

      if (path === '/__real-bridge.js') {
        const body = await readFile(join(ui, 'vendor/bridge.js'));
        response.writeHead(200, { 'content-type': TYPES['.js'] });
        response.end(body);
        return;
      }

      try {
        const body = await readFile(join(ui, path));
        response.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
        response.end(body);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

// --------------------------------------------------------------- assertions

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
}

async function main() {
  const fixtures = await buildFixtures();
  const server = await serve(fixtures);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const shots = join(process.env.OPENCODE_TMP_DIR || '/data/data/com.termux/files/usr/tmp/opencode', 'warrant-ui');
  await readFile('/dev/null').catch(() => {});
  await (await import('node:fs/promises')).mkdir(shots, { recursive: true });

  // ---------------------------------------------------------------- console
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${base}/index.html?surface=console`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.stats');

    const facts = await page.evaluate(() => {
      const text = (sel) => (document.querySelector(sel) || {}).textContent || '';
      const all = (sel) => Array.from(document.querySelectorAll(sel));
      return {
        title: text('.masthead h1'),
        mark: (() => {
          const img = document.querySelector('.masthead-mark');
          if (!img) return null;
          return {
            tag: img.tagName,
            loaded: img.complete && img.naturalWidth > 0,
            width: Math.round(img.getBoundingClientRect().width),
            src: img.getAttribute('src'),
          };
        })(),
        stats: all('.stat').map((s) => ({
          value: text.call(null, '.stat-value'),
          label: s.querySelector('.stat-label').textContent,
          count: s.querySelector('.stat-value').textContent,
        })),
        cards: all('.card').length,
        highVerdict: all('.verdict--high').length,
        against: all('.signal.is-against').length,
        forSignals: all('.signal.is-for').length,
        ledger: all('.ledger-row').length,
        meters: all('.meter').length,
        signButtons: all('.btn--primary').filter((b) => b.textContent === 'Sign').length,
        undoButtons: all('.btn').filter((b) => b.textContent === 'Undo').length,
        groupDots: all('.group-dot').map((d) => d.className.replace('group-dot ', '')),
        groupLabels: all('.section-head').map((h) => {
          const dot = h.querySelector('.group-dot');
          const chip = h.querySelector('.section-note');
          return {
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
            label: (h.querySelector('.kicker') || {}).textContent || '',
            chip: chip ? chip.textContent : '',
            chipRadius: chip ? getComputedStyle(chip).borderTopLeftRadius : null,
          };
        }),
        rowDots: all('.rows .row-dot').length,
        surface: document.body.dataset.surface,
        ground: getComputedStyle(document.body).backgroundColor,
        raised: (() => {
          const card = document.querySelector('.card');
          return card ? getComputedStyle(card).backgroundColor : null;
        })(),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.innerText.slice(0, 400),
      };
    });

    check('console renders the masthead', facts.title === 'Warrant', facts.title);
    check(
      'the badge is a real image that loaded in the console',
      facts.mark && facts.mark.loaded && facts.mark.width === 28,
      JSON.stringify(facts.mark),
    );
    check('console shows five counters', facts.stats.length === 5, String(facts.stats.length));
    check(
      'the awaiting-signature counter is non-zero',
      Number(facts.stats[0].count) >= 1,
      facts.stats.map((s) => `${s.label}=${s.count}`).join(', '),
    );
    check('a request card is present', facts.cards >= 2, String(facts.cards));
    check('the high-risk verdict is rendered', facts.highVerdict >= 1, String(facts.highVerdict));
    check('signals against the grant are listed', facts.against >= 2, String(facts.against));
    check('a signal arguing for the grant is listed', facts.forSignals >= 1, String(facts.forSignals));
    check('the ledger has rows', facts.ledger >= 5, String(facts.ledger));
    check('an undo control is offered for a real write', facts.undoButtons >= 1, String(facts.undoButtons));
    check('a remaining-actions meter is shown', facts.meters >= 1, String(facts.meters));
    check('the sign control is present', facts.signButtons >= 1, String(facts.signButtons));
    // The reference's list language: a colour dot and a count chip per group,
    // so the page is read by scanning, not by reading every heading.
    check('every group heading carries a status dot', facts.groupLabels.every((g) => g.dot && g.dot !== 'rgba(0, 0, 0, 0)'), JSON.stringify(facts.groupLabels));
    check(
      'the group dots are coloured, not all one grey',
      new Set(facts.groupLabels.map((g) => g.dot)).size >= 3,
      facts.groupLabels.map((g) => `${g.label}:${g.dot}`).join(', '),
    );
    check(
      'every group heading carries a count chip',
      facts.groupLabels.every((g) => g.chip && g.chip.length > 0),
      facts.groupLabels.map((g) => `${g.label}=${g.chip}`).join(', '),
    );
    check(
      'the count chips are pills',
      facts.groupLabels.every((g) => parseFloat(g.chipRadius) >= 9),
      facts.groupLabels.map((g) => g.chipRadius).join(', '),
    );
    check('rows carry a phase dot', facts.rowDots >= 1, String(facts.rowDots));
    // Depth: the console is a page, so it sits on a sunken ground with raised
    // cards on top. The panel is a column inside Jira and stays flat.
    check('the console reports itself as the console surface', facts.surface === 'console', String(facts.surface));
    check('the console ground is sunken, not the page colour', facts.ground !== facts.raised, `${facts.ground} vs ${facts.raised}`);
    check('no horizontal overflow at 1280', facts.overflow <= 0, `${facts.overflow}px`);
    check('no console errors', errors.length === 0, errors.join(' | '));

    // Clicking Sign must reach the resolver and say so.
    await page.click('.btn--primary');
    await page.waitForSelector('.toast', { timeout: 4000 }).catch(() => {});
    const toastText = await page.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
    check('signing reports back in a toast', /Signed/i.test(toastText), toastText);

    await page.screenshot({ path: join(shots, 'console.png'), fullPage: false });

    // Narrow viewport: the console must survive a phone.
    await page.setViewport({ width: 320, height: 800 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.stats');
    const narrow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cards: document.querySelectorAll('.card').length,
    }));
    check('console does not overflow at 320', narrow.overflow <= 0, `${narrow.overflow}px`);
    check('console still renders its cards at 320', narrow.cards >= 2, String(narrow.cards));
    await page.screenshot({ path: join(shots, 'console-320.png'), fullPage: false });

    await page.close();
  }

  // ------------------------------------------------------------------ panel
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 390, height: 900 });
    await page.goto(`${base}/index.html?surface=panel`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.app--panel');

    const facts = await page.evaluate(() => {
      const all = (sel) => Array.from(document.querySelectorAll(sel));
      const text = (sel) => (document.querySelector(sel) || {}).textContent || '';
      return {
        title: text('.masthead h1'),
        subtitle: text('.masthead p'),
        mark: (() => {
          const img = document.querySelector('.masthead-mark');
          if (!img) return null;
          return {
            loaded: img.complete && img.naturalWidth > 0,
            width: Math.round(img.getBoundingClientRect().width),
          };
        })(),
        kickers: all('.kicker').map((k) => k.textContent),
        blast: all('.blast').length,
        signals: all('.signal').length,
        propose: all('.propose').length,
        operationSelect: all('.propose select option').map((o) => o.value),
        hasAuthRow: all('.rows .row-item').length,
        authority: (() => {
          const row = document.querySelector('.rows .row-item');
          if (!row) return null;
          const main = row.querySelector('.row-main');
          const title = row.querySelector('.row-title');
          const line = parseFloat(getComputedStyle(title).lineHeight) || 20;
          return {
            row: Math.round(row.getBoundingClientRect().width),
            main: Math.round(main.getBoundingClientRect().width),
            lines: Math.round(title.getBoundingClientRect().height / line),
          };
        })(),
        surface: document.body.dataset.surface,
        groupDots: all('.group-dot').length,
        ledger: all('.ledger-row').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    check('panel renders its masthead', facts.title === 'Warrant', facts.title);
    check(
      'the badge is a real image that loaded in the panel',
      facts.mark && facts.mark.loaded && facts.mark.width === 28,
      JSON.stringify(facts.mark),
    );
    check('panel names the issue', /PAY-412/.test(facts.subtitle), facts.subtitle);
    check('panel leads with the blast radius', facts.kickers[0] === 'If an agent changed this issue', facts.kickers[0]);
    check('panel shows blast signals', facts.signals >= 2, String(facts.signals));
    check('panel offers every operation in the propose form', facts.operationSelect.length === 3, facts.operationSelect.join(','));
    check('panel shows the live warrant over this issue', facts.hasAuthRow >= 1, String(facts.hasAuthRow));
    check('panel shows this issue in the ledger', facts.ledger >= 1, String(facts.ledger));
    check('the panel reports itself as the panel surface', facts.surface === 'panel', String(facts.surface));
    check('the panel group headings carry dots too', facts.groupDots >= 2, String(facts.groupDots));
    // The bug this guards: at 390px the authority row used to squeeze its main
    // column into one word per line, because the meter and button would not fit
    // beside it. Wrapping puts the side on its own line instead.
    check(
      'the authority row keeps a usable main column',
      facts.authority && facts.authority.main >= facts.authority.row * 0.6,
      facts.authority ? `${facts.authority.main} of ${facts.authority.row}px` : 'no row',
    );
    check(
      'the authority title does not collapse to one word per line',
      facts.authority && facts.authority.lines <= 2,
      facts.authority ? `${facts.authority.lines} lines` : 'no row',
    );
    check('panel does not overflow at 390', facts.overflow <= 0, `${facts.overflow}px`);
    check('panel is error free', errors.length === 0, errors.join(' | '));

    await page.screenshot({ path: join(shots, 'panel.png'), fullPage: true });
    await page.setViewport({ width: 320, height: 900 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.app--panel');
    const narrow = await page.evaluate(() => {
      const row = document.querySelector('.rows .row-item');
      const main = row && row.querySelector('.row-main');
      const title = row && row.querySelector('.row-title');
      const line = title ? parseFloat(getComputedStyle(title).lineHeight) || 20 : 20;
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
        mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
        lines: title ? Math.round(title.getBoundingClientRect().height / line) : 99,
      };
    });
    check('panel does not overflow at 320', narrow.overflow <= 0, `${narrow.overflow}px`);
    check(
      'the authority row survives a 320px panel',
      narrow.mainWidth >= narrow.rowWidth * 0.6 && narrow.lines <= 2,
      `${narrow.mainWidth} of ${narrow.rowWidth}px, ${narrow.lines} lines`,
    );
    await page.screenshot({ path: join(shots, 'panel-320.png'), fullPage: false });

    await page.close();
  }

  // ------------------------------------------------------- vendored bundle
  {
    // The stand-in proved the page works; this proves the shipped bundle is the
    // thing that would actually be loaded in Jira.
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/__bundle-check.html`, { waitUntil: 'networkidle0' });
    const keys = await page.evaluate(() => window.__bundle);
    check('the real bridge bundle is loadable', Array.isArray(keys), String(keys));
    for (const name of ['invoke', 'view', 'router', 'events']) {
      check(`the real bundle exposes ${name}`, Array.isArray(keys) && keys.includes(name), (keys || []).join(','));
    }
    const roundTrip = await page.evaluate(() => window.__roundTrip);
    check(
      'the real bundle routes invoke through the host bridge',
      roundTrip && roundTrip.resolved && (roundTrip.calls || []).length >= 1,
      JSON.stringify(roundTrip),
    );
    check('the real bundle loads without errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  → ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots: ${shots}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
