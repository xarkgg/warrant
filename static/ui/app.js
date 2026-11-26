/**
 * Warrant's UI.
 *
 * One document, two surfaces. The Forge context decides which:
 *
 *   jira:issuePanel  → context.extension.issue.key  → the issue panel
 *   jira:globalPage  → no issue                     → the authority console
 *
 * Nothing here decides whether a write is allowed. Every action goes through
 * `invoke(...)` into the resolver, which goes through the service, which goes
 * through the policy. This file is a view over that, and if it were wrong the
 * worst outcome is a confusing screen — never an unauthorised change.
 */
(function () {
  'use strict';

  var bridge = window.forgeBridge;
  var root = document.getElementById('root');
  var toastHost = document.getElementById('toasts');

  var state = {
    mode: 'console',
    issueKey: null,
    data: null,
    busy: false,
    error: null,
    drafts: {},
    propose: { operation: 'jira.transition', value: '', reason: '', maxActions: 10, ttlMinutes: 120 },
  };

  // ---------------------------------------------------------------- DOM bits

  function el(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (key) {
      var value = a[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = value; // only ever for a static SVG string
      else if (key.indexOf('on') === 0 && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : String(value));
    });
    for (var i = 2; i < arguments.length; i += 1) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) {
        append(node, c);
      });
      return;
    }
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ------------------------------------------------------------- formatting

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function clockOf(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function relative(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    var ms = d.getTime() - Date.now();
    var future = ms > 0;
    var abs = Math.abs(ms);
    var minutes = Math.round(abs / 60000);
    var text;
    if (minutes < 1) text = 'moments';
    else if (minutes < 60) text = minutes + 'm';
    else if (minutes < 60 * 48) text = Math.round(minutes / 60) + 'h';
    else text = Math.round(minutes / (60 * 24)) + 'd';
    if (text === 'moments') return future ? 'any second' : 'just now';
    return future ? 'in ' + text : text + ' ago';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }

  function verdict(risk, label) {
    var tone = risk === 'high' ? 'high' : risk === 'medium' ? 'medium' : risk === 'low' ? 'low' : 'muted';
    return el('span', { class: 'verdict verdict--' + tone, text: label || risk });
  }

  function chip(key, onRemove) {
    return el('span', { class: onRemove ? 'chip' : 'chip chip--static' }, [
      key,
      onRemove
        ? el('button', {
            class: 'chip-remove',
            type: 'button',
            'aria-label': 'Remove ' + key + ' from the grant',
            title: 'Remove ' + key,
            text: '\u00d7',
            onclick: onRemove,
          })
        : null,
    ]);
  }

  function meter(remaining, max) {
    var pct = max > 0 ? Math.max(0, Math.min(100, (remaining / max) * 100)) : 0;
    var tone = remaining === 0 ? 'is-empty' : pct <= 25 ? 'is-low' : '';
    return el('span', { class: 'meter', title: remaining + ' of ' + max + ' actions left' }, [
      el('span', { class: 'meter-track' }, [
        el('span', { class: 'meter-fill ' + tone, style: 'width:' + pct + '%' }),
      ]),
      el('span', { class: 'meter-text', text: remaining + '/' + max }),
    ]);
  }

  // The badge, keyed off its own ground by `scripts/badge-assets.mjs`. A raster
  // rather than a traced vector because the mark's whole character is its gloss
  // and inner ring, which a 24px path would flatten into a purple blob.
  var MARK = '<img class="masthead-mark" src="mark.png" width="28" height="28" alt="" />';

  // ------------------------------------------------------------------ toasts

  function toast(message, bad) {
    if (!message) return;
    var node = el('div', { class: 'toast' + (bad ? ' is-bad' : ''), text: message });
    toastHost.appendChild(node);
    while (toastHost.children.length > 3) toastHost.removeChild(toastHost.firstChild);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, bad ? 8000 : 4500);
  }

  // -------------------------------------------------------------- blast view

  function blastView(blast) {
    if (!blast || (!blast.against && !blast.forIt)) {
      return el('p', { class: 'muted', text: 'No context was captured for this request.' });
    }
    var signals = (blast.against || []).concat(blast.forIt || []);
    return el('div', { class: 'blast' }, [
      el('p', { class: 'blast-headline', text: blast.headline }),
      el(
        'ul',
        { class: 'blast-list' },
        signals.map(function (signal) {
          var against = signal.weight > 0;
          return el('li', { class: 'signal ' + (against ? 'is-against' : 'is-for') }, [
            el('span', { class: 'signal-mark', text: against ? '\u2212' : '+' }),
            el('span', { class: 'signal-text' }, [
              el('span', { class: 'signal-label', text: signal.label }),
              ' ',
              el('span', { class: 'signal-keys', text: signal.issueKeys.join(' ') }),
              ' ',
              el('span', { class: 'muted', text: '\u2014 ' + signal.detail }),
            ]),
          ]);
        }),
      ),
      el('div', { class: 'blast-foot' }, [
        el('span', { text: plural(blast.issueCount, 'issue') }),
        blast.projects && Object.keys(blast.projects).length
          ? el('span', { text: 'across ' + Object.keys(blast.projects).join(', ') })
          : null,
        el('span', { text: 'captured ' + relative(blast.computedAt) }),
      ]),
    ]);
  }

  function tone(blast) {
    if (!blast) return 'card--quiet';
    return blast.risk === 'high'
      ? 'card--high'
      : blast.risk === 'medium'
        ? 'card--medium'
        : 'card--low';
  }

  // ------------------------------------------------------------ request card

  function draftFor(warrant) {
    var existing = state.drafts[warrant.id];
    if (existing) return existing;
    var draft = {
      issueKeys: warrant.scope.issueKeys.slice(),
      maxActions: warrant.request.askedMaxActions,
      ttlMinutes: warrant.request.askedTtlMinutes,
    };
    state.drafts[warrant.id] = draft;
    return draft;
  }

  function attempt(fn) {
    return function (event) {
      if (event) event.preventDefault();
      if (state.busy) return;
      Promise.resolve()
        .then(fn)
        .catch(function (error) {
          toast(error && error.message ? error.message : 'That did not go through.', true);
        });
    };
  }

  function requestCard(warrant, options) {
    var draft = draftFor(warrant);
    var asked = warrant.request.askedMaxActions;
    var askedTtl = warrant.request.askedTtlMinutes;
    var compact = options && options.compact;

    function setNumber(field, max) {
      return function (event) {
        var raw = event.target.value === '' ? NaN : Math.trunc(Number(event.target.value));
        draft[field] = isNaN(raw) ? 1 : raw;
        sign.disabled = draft.issueKeys.length === 0 || state.busy;
        hint.textContent =
          draft[field] > max
            ? 'The agent asked for at most ' + max + '. More than that is refused.'
            : '';
      };
    }

    var hint = el('span', { class: 'muted', style: 'font-size:11.5px' });

    var sign = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: 'Sign',
      disabled: draft.issueKeys.length === 0,
      onclick: attempt(function () {
        return act(
          'grant',
          { warrantId: warrant.id, issueKeys: draft.issueKeys, maxActions: draft.maxActions, ttlMinutes: draft.ttlMinutes },
          function (res) {
            delete state.drafts[warrant.id];
            return 'Signed. ' + capitalise(res.warrant.scopeSentence) + ', ' + plural(res.warrant.limits.maxActions, 'action') + '.';
          },
        );
      }),
    });

    var chips = el(
      'div',
      { class: 'chips' },
      draft.issueKeys.map(function (key) {
        return chip(key, function () {
          if (draft.issueKeys.length <= 1) {
            toast('A warrant with no issues grants nothing. Keep at least one.', true);
            return;
          }
          draft.issueKeys = draft.issueKeys.filter(function (k) {
            return k !== key;
          });
          render();
        });
      }),
    );

    var trimmed = draft.issueKeys.length < warrant.scope.issueKeys.length;

    return el('article', { class: 'card ' + tone(warrant.blast) }, [
      el('header', { class: 'card-head' }, [
        el('div', { class: 'card-head-main' }, [
          el('div', { class: 'card-title' }, [
            el('span', { class: 'card-agent', text: warrant.agent.name }),
            el('span', { class: 'card-verb', text: warrant.operation }),
            warrant.blast ? verdict(warrant.blast.risk) : null,
          ]),
          el('p', { class: 'card-reason', text: warrant.request.reason || 'No reason given.' }),
        ]),
      ]),

      blastView(warrant.blast),

      el('div', { class: 'scope-line' }, [
        el('span', { class: 'scope-label', text: 'Scope' }),
        chips,
        trimmed
          ? el('span', { class: 'muted', style: 'font-size:11.5px', text: 'trimmed from ' + warrant.scope.issueKeys.length })
          : null,
      ]),

      el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('div', { class: 'field field--num' }, [
          el('label', { text: 'Actions' }),
          el('input', {
            type: 'number',
            min: '1',
            max: String(asked),
            value: String(draft.maxActions),
            oninput: setNumber('maxActions', asked),
          }),
        ]),
        el('div', { class: 'field field--num' }, [
          el('label', { text: 'Minutes' }),
          el('input', {
            type: 'number',
            min: '1',
            max: String(askedTtl),
            value: String(draft.ttlMinutes),
            oninput: setNumber('ttlMinutes', askedTtl),
          }),
        ]),
        el('span', { class: 'muted', style: 'font-size:11.5px' }, 'asked for ' + asked + ' actions over ' + askedTtl + ' minutes'),
      ]),

      hint.textContent ? hint : null,

      el('div', { class: 'card-actions' }, [
        el('span', { class: 'muted', style: 'font-size:11.5px', text: 'Nothing has happened yet.' }),
        el('span', { class: 'card-actions-spacer' }),
        compact
          ? null
          : el('button', {
              class: 'btn btn--quiet btn--small',
              type: 'button',
              text: 'Decline',
              onclick: attempt(function () {
                return act('decline', { warrantId: warrant.id }, function () {
                  delete state.drafts[warrant.id];
                  return 'Declined. The agent gets no authority for this.';
                });
              }),
            }),
        sign,
      ]),
    ]);
  }

  // --------------------------------------------------------- queued refusals

  function pendingCard(record) {
    return el('article', { class: 'card card--medium' }, [
      el('div', { class: 'card-head-main' }, [
        el('div', { class: 'card-title' }, [
          el('span', { class: 'mono', text: record.issueKey }),
          el('span', { class: 'card-verb', text: record.operation }),
          el('span', { class: 'muted', style: 'font-size:12px', text: 'refused ' + relative(record.at) }),
        ]),
        el('p', { class: 'card-reason' }, [
          el('span', { class: 'muted', text: 'The agent tried: ' }),
          el('span', { class: 'mono', text: describeValue(record.operation, record.value) }),
        ]),
        el('p', { class: 'card-reason', style: 'margin-top:4px', text: record.detail }),
      ]),
      el('div', { class: 'card-actions' }, [
        el('span', { class: 'muted', style: 'font-size:11.5px', text: 'Approving performs it once, as you. It does not extend any warrant.' }),
        el('span', { class: 'card-actions-spacer' }),
        el('button', {
          class: 'btn btn--quiet btn--small',
          type: 'button',
          text: 'Decline',
          onclick: attempt(function () {
            return act('resolvePending', { pendingId: record.id, decision: 'deny' }, function () {
              return 'Declined. Nothing was changed.';
            });
          }),
        }),
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Approve once',
          onclick: attempt(function () {
            return act('resolvePending', { pendingId: record.id, decision: 'approve' }, function (res) {
              return res.executed ? res.executed + '.' : 'Approved.';
            });
          }),
        }),
      ]),
    ]);
  }

  function describeValue(operation, value) {
    if (operation === 'jira.comment') {
      var text = String(value || '');
      return '"' + (text.length > 120 ? text.slice(0, 120) + '\u2026' : text) + '"';
    }
    if (operation === 'jira.assign') return 'assign to ' + String(value || '');
    return 'move to "' + String(value || '') + '"';
  }

  // ------------------------------------------------------------ authority row

  function authorityRow(warrant) {
    var left =
      warrant.phase === 'active'
        ? warrant.expiresIn
        : warrant.phase === 'exhausted'
          ? 'budget spent'
          : warrant.phase === 'expired'
            ? 'expired ' + relative(warrant.limits.expiresAt)
            : 'revoked';

    return el('div', { class: 'row-item' }, [
      el('span', {
        class: 'row-dot ' + (warrant.phase === 'active' ? 'is-ok' : warrant.phase === 'requested' ? 'is-warn' : 'is-muted'),
        'aria-hidden': 'true',
      }),
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, [
          el('span', { class: 'card-verb', text: warrant.operationLabel }),
          el('span', { text: warrant.scopeSentence }),
        ]),
        el('div', { class: 'row-sub' }, [
          warrant.agent.name + ' \u00b7 requested ' + relative(warrant.request.requestedAt) +
            (warrant.grant && warrant.grant.byName ? ' \u00b7 signed by ' + warrant.grant.byName : ''),
        ]),
      ]),
      el('div', { class: 'row-side' }, [
        warrant.phase === 'active' || warrant.phase === 'exhausted'
          ? meter(warrant.remaining, warrant.limits.maxActions)
          : null,
        el('span', { class: 'mono', style: 'font-size:11.5px;color:var(--w-ink-3)', text: left }),
        warrant.phase === 'active'
          ? el('button', {
              class: 'btn btn--danger btn--small',
              type: 'button',
              text: 'Revoke',
              onclick: attempt(function () {
                return act('revoke', { warrantId: warrant.id, reason: 'revoked from the console' }, function () {
                  return 'Revoked. Every write through this app is refused for it now.';
                });
              }),
            })
          : null,
      ]),
    ]);
  }

  // ---------------------------------------------------------------- the ledger

  var TONE = {
    executed: 'is-ok',
    approved: 'is-ok',
    undone: 'is-ok',
    granted: 'is-grant',
    requested: 'is-grant',
    blocked: 'is-bad',
    denied: 'is-bad',
    undo_failed: 'is-bad',
    revoked: 'is-warn',
    queued: 'is-warn',
  };

  function ledger(events, options) {
    if (!events.length) {
      return el('div', { class: 'empty' }, [
        el('strong', { text: 'Nothing yet. ' }),
        'Every request, refusal, write and reversal lands here.',
      ]);
    }
    var limit = (options && options.limit) || events.length;
    return el(
      'div',
      { class: 'ledger' },
      events.slice(0, limit).map(function (event) {
        return el('div', { class: 'ledger-row' }, [
          el('span', { class: 'ledger-time', text: clockOf(event.at), title: new Date(event.at).toLocaleString() }),
          el('span', { class: 'ledger-dot ' + (TONE[event.type] || ''), title: event.type }),
          el('span', { class: 'ledger-text' }, [
            el('span', { class: 'ledger-type', text: label(event.type) + ' \u00b7 ' }),
            event.detail,
          ]),
          event.undo && !event.undone && event.type === 'executed'
            ? el('button', {
                class: 'btn btn--quiet btn--small',
                type: 'button',
                text: 'Undo',
                onclick: attempt(function () {
                  return act('undo', { eventId: event.id }, function () {
                    return 'Undone. ' + (event.issueKey || 'The issue') + ' is back where it was.';
                  });
                }),
              })
            : null,
        ]);
      }),
    );
  }

  function label(type) {
    return (
      {
        requested: 'asked',
        granted: 'signed',
        revoked: 'revoked',
        executed: 'changed',
        blocked: 'refused',
        queued: 'queued',
        approved: 'approved',
        denied: 'declined',
        undone: 'reverted',
        undo_failed: 'undo failed',
      }[type] || type
    );
  }

  // ---------------------------------------------------------------- structure

  function masthead(title, subtitle, actions) {
    return el('header', { class: 'masthead' }, [
      el('span', { html: MARK }),
      el('div', { class: 'masthead-text' }, [
        el('h1', { text: title }),
        subtitle ? el('p', { text: subtitle }) : null,
      ]),
      actions ? el('div', { class: 'masthead-actions' }, actions) : null,
    ]);
  }

  function section(kicker, note, body, tone) {
    return el('section', { class: 'section' }, [
      el('div', { class: 'section-head' }, [
        // Every heading carries a dot; a group with no particular state gets
        // the muted one rather than no dot, so the column still scans evenly.
        el('span', { class: 'group-dot ' + (tone || 'is-muted'), 'aria-hidden': 'true' }),
        el('span', { class: 'kicker', text: kicker }),
        note ? el('span', { class: 'section-note', text: note }) : null,
      ]),
      body,
    ]);
  }

  function empty(message, strong) {
    return el('div', { class: 'empty' }, [strong ? el('strong', { text: strong + ' ' }) : null, message]);
  }

  function capitalise(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  // ------------------------------------------------------------ console view

  function renderConsole(data) {
    var counts = data.counts || {};
    var requested = (data.warrants || []).filter(function (w) {
      return w.phase === 'requested';
    });
    var active = (data.warrants || []).filter(function (w) {
      return w.phase === 'active';
    });
    var closed = (data.warrants || []).filter(function (w) {
      return ['expired', 'exhausted', 'revoked'].indexOf(w.phase) !== -1;
    });
    var pending = data.pending || [];

    var stats = el('div', { class: 'stats' }, [
      stat(requested.length, 'awaiting signature', requested.length > 0),
      stat(active.length, 'live', false),
      stat(pending.length, 'waiting on you', pending.length > 0),
      stat(counts.expired || 0, 'expired', false),
      stat(counts.revoked || 0, 'revoked', false),
    ]);

    var body = [
      masthead(
        'Warrant',
        'Scoped, expiring authority for agents working in this Jira. Nothing an agent does here happens until someone signs for it.',
        [
          el('span', {
            class: 'muted',
            style: 'font-size:11.5px',
            text: 'as of ' + clockOf(data.at),
          }),
          el('button', { class: 'btn btn--quiet btn--small', type: 'button', text: 'Refresh', onclick: attempt(reload) }),
        ],
      ),
      stats,
    ];

    if (state.error) body.push(el('div', { class: 'notice notice--error', text: state.error }));

    body.push(
      section(
        'Awaiting signature',
        requested.length ? plural(requested.length, 'request') : 'nothing waiting',
        requested.length
          ? el(
              'div',
              { class: 'stack' },
              requested.map(function (w) {
                return requestCard(w);
              }),
            )
          : empty(
              'An agent asks for authority with the request tool, and the request appears here with everything it would touch.',
              'No agent is waiting on you.',
            ),
        'is-warn',
      ),
    );

    body.push(
      section(
        'Waiting on you',
        pending.length ? plural(pending.length, 'refused change') : 'nothing refused',
        pending.length
          ? el(
              'div',
              { class: 'stack' },
              pending.map(pendingCard),
            )
          : empty('When an agent tries something no warrant covers, the refusal is queued here rather than dropped.', 'No refusals.'),
        'is-bad',
      ),
    );

    body.push(
      section(
        'Live authority',
        active.length ? plural(active.length, 'warrant') + ' in force' : 'none in force',
        active.length
          ? el(
              'div',
              { class: 'rows' },
              active.map(function (w) {
                return el('div', {}, authorityRow(w));
              }),
            )
          : empty('Authority exists only between a signature and its expiry, and only for the issues named on the card.', 'No live warrants.'),
        'is-ok',
      ),
    );

    if (closed.length) {
      body.push(
        el('section', { class: 'section' }, [
          el('details', {}, [
            el('summary', { class: 'kicker', style: 'cursor:pointer', text: 'Spent and closed (' + closed.length + ')' }),
            el(
              'div',
              { class: 'rows', style: 'margin-top:10px' },
              closed.map(function (w) {
                return authorityRow(w);
              }),
            ),
          ]),
        ]),
      );
    }

    body.push(
      section(
        'Ledger',
        data.events && data.events.length ? 'newest first' : 'empty',
        ledger(data.events || []),
        'is-muted',
      ),
    );

    if (data.graph === false) {
      body.push(
        el('div', { class: 'notice notice--info' }, [
          el('span', { text: 'Teamwork Graph is not answering on this site, so pull requests and goals are missing from the briefing above. Warrants still work.' }),
        ]),
      );
    }

    clear(root);
    root.className = 'app';
    document.body.dataset.surface = 'console';
    root.removeAttribute('aria-busy');
    append(root, body);
  }

  function stat(value, labelText, alert) {
    return el('div', { class: 'stat' + (alert ? ' is-alert' : '') + (value ? '' : ' is-zero') }, [
      el('div', { class: 'stat-value', text: String(value) }),
      el('div', { class: 'stat-label', text: labelText }),
    ]);
  }

  // -------------------------------------------------------------- panel view

  function renderPanel(data) {
    var issue = data.issue || {};
    var warrants = data.warrants || [];
    var requested = warrants.filter(function (w) {
      return w.phase === 'requested';
    });
    var active = warrants.filter(function (w) {
      return w.phase === 'active';
    });
    var pending = data.pending || [];
    var blast = data.blast;

    var body = [
      masthead(
        'Warrant',
        issue.key + (issue.summary ? ' \u00b7 ' + issue.summary : ''),
        blast ? verdict(blast.risk, blast.risk + ' risk') : null,
      ),
    ];

    if (pending.length) {
      body.push(
        el('div', { class: 'notice notice--error' }, [
          el('span', { text: plural(pending.length, 'refused change') + ' on this issue is waiting for you.' }),
        ]),
      );
    }

    if (state.error) body.push(el('div', { class: 'notice notice--error', text: state.error }));

    body.push(
      section(
        'If an agent changed this issue',
        data.unavailable ? data.unavailable + ' graph calls failed' : issue.status || null,
        blastView(blast),
        !blast ? 'is-muted' : blast.risk === 'high' ? 'is-bad' : blast.risk === 'medium' ? 'is-warn' : 'is-ok',
      ),
    );

    body.push(
      section(
        'Requests on this issue',
        requested.length ? plural(requested.length, 'awaiting signature') : 'none',
        requested.length
          ? el(
              'div',
              { class: 'stack' },
              requested.map(function (w) {
                return requestCard(w, { compact: true });
              }),
            )
          : empty('No agent has asked to change this issue.', 'Nothing pending.'),
        'is-warn',
      ),
    );

    body.push(
      section(
        'Waiting on you',
        pending.length ? 'refused, not dropped' : 'nothing queued',
        pending.length
          ? el('div', { class: 'stack' }, pending.map(pendingCard))
          : empty('Refused writes for this issue would appear here for a one-off approval.', 'Nothing queued.'),
        'is-bad',
      ),
    );

    body.push(
      section(
        'Authority over this issue',
        active.length ? plural(active.length, 'warrant') + ' in force' : 'none',
        active.length
          ? el('div', { class: 'rows' }, active.map(authorityRow))
          : empty('No live warrant covers this issue, so every write through this app is refused.', 'No authority.'),
        'is-ok',
      ),
    );

    body.push(
      section(
        'Propose a change',
        'authority request only, no Jira write yet',
        proposeForm(issue.key),
      ),
    );

    body.push(section('Recent activity', 'this issue only', ledger(data.events || [], { limit: 8 })));

    clear(root);
    root.className = 'app app--panel';
    document.body.dataset.surface = 'panel';
    root.removeAttribute('aria-busy');
    append(root, body);
  }

  function proposeForm(issueKey) {
    var p = state.propose;
    var valueLabel = el('label', { text: p.operation === 'jira.comment' ? 'Comment' : p.operation === 'jira.assign' ? 'Person or accountId' : 'Target status' });
    var valueInput =
      p.operation === 'jira.comment'
        ? el('textarea', {
            value: p.value,
            placeholder: 'What should the comment say?',
            oninput: function (e) {
              p.value = e.target.value;
            },
          })
        : el('input', {
            type: 'text',
            value: p.value,
            placeholder: p.operation === 'jira.assign' ? 'Dana, or an accountId' : 'Done',
            oninput: function (e) {
              p.value = e.target.value;
            },
          });

    var transitions = (state.data && state.data.transitions) || [];
    var suggestions = transitions.length
      ? el('span', { class: 'muted', style: 'font-size:11.5px', text: 'available now: ' + transitions.map(function (t) { return t.toStatusName || t.name; }).join(', ') })
      : null;

    return el('div', { class: 'propose' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Operation' }),
          el(
            'select',
            {
              onchange: function (e) {
                p.operation = e.target.value;
                p.value = '';
                render();
              },
            },
            (state.data && state.data.operations ? state.data.operations : []).map(function (op) {
              return el('option', { value: op.key, text: op.label, selected: op.key === p.operation ? true : null });
            }),
          ),
        ]),
        el('div', { class: 'field field--grow' }, [valueLabel, valueInput]),
      ]),
      suggestions && p.operation === 'jira.transition' ? suggestions : null,
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('div', { class: 'field field--grow' }, [
          el('label', { text: 'Why' }),
          el('input', {
            type: 'text',
            value: p.reason,
            placeholder: 'One sentence anyone can judge',
            oninput: function (e) {
              p.reason = e.target.value;
            },
          }),
        ]),
        el('div', { class: 'field field--num' }, [
          el('label', { text: 'Actions' }),
          el('input', { type: 'number', min: '1', max: '200', value: String(p.maxActions), oninput: function (e) { p.maxActions = Math.trunc(Number(e.target.value)) || 1; } }),
        ]),
        el('div', { class: 'field field--num' }, [
          el('label', { text: 'Minutes' }),
          el('input', { type: 'number', min: '1', value: String(p.ttlMinutes), oninput: function (e) { p.ttlMinutes = Math.trunc(Number(e.target.value)) || 1; } }),
        ]),
      ]),
      el('div', { class: 'propose-actions' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Propose',
          onclick: attempt(function () {
            if (!String(p.value || '').trim()) {
              toast('A proposal needs a value: a status, a comment, or a person.', true);
              return;
            }
            return act(
              'requestForIssue',
              {
                issueKey: issueKey,
                operation: p.operation,
                reason: p.reason,
                maxActions: p.maxActions,
                ttlMinutes: p.ttlMinutes,
              },
              function (res) {
                p.value = '';
                p.reason = '';
                return 'Proposed. Sign it above to put it in force.';
              },
            );
          }),
        }),
      ]),
    ]);
  }

  // -------------------------------------------------------------- data + act

  function invoke(name, payload) {
    if (!bridge || !bridge.invoke) return Promise.reject(new Error('The Forge bridge did not load.'));
    return bridge.invoke(name, payload || {});
  }

  function reload() {
    return invoke(state.mode === 'panel' ? 'issueContext' : 'snapshot', state.mode === 'panel' ? { issueKey: state.issueKey } : {})
      .then(function (data) {
        if (!data || data.ok === false) {
          state.error = (data && data.error) || 'The app could not read its own state.';
        } else {
          state.error = null;
          state.data = data;
        }
        render();
      })
      .catch(function (error) {
        state.error = describe(error);
        render();
      });
  }

  function act(action, payload, receipt) {
    state.busy = true;
    setBusy(true);
    return invoke(action, payload)
      .then(function (result) {
        state.busy = false;
        setBusy(false);
        if (!result || result.ok === false) {
          toast((result && result.error) || 'That was refused.', true);
          return reload();
        }
        var message = receipt ? receipt(result) : 'Done.';
        toast(message);
        return reload();
      })
      .catch(function (error) {
        state.busy = false;
        setBusy(false);
        toast(describe(error), true);
        return reload();
      });
  }

  function describe(error) {
    var message = error && error.message ? error.message : String(error || 'unknown error');
    if (/timed out|timeout/i.test(message)) return 'The call timed out. Try again.';
    return message;
  }

  function setBusy(busy) {
    root.setAttribute('aria-busy', busy ? 'true' : 'false');
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (button) {
      if (busy) {
        button.dataset.wasDisabled = button.disabled ? '1' : '0';
        button.disabled = true;
      } else if (button.dataset.wasDisabled !== '1') {
        button.disabled = false;
      }
    });
  }

  function render() {
    if (state.mode === 'panel') renderPanel(state.data || {});
    else renderConsole(state.data || { warrants: [], pending: [], events: [], counts: {} });
  }

  // -------------------------------------------------------------------- boot

  function boot() {
    if (!bridge) {
      clear(root);
      root.removeAttribute('aria-busy');
      root.appendChild(
        el('div', { class: 'notice notice--error', text: 'The Forge bridge failed to load, so Warrant cannot reach its own backend.' }),
      );
      return;
    }

    bridge.view
      .getContext()
      .then(function (context) {
        var issueKey =
          context && context.extension && context.extension.issue && context.extension.issue.key;
        state.mode = issueKey ? 'panel' : 'console';
        state.issueKey = issueKey ? String(issueKey).toUpperCase() : null;
        root.className = 'app' + (state.mode === 'panel' ? ' app--panel' : '');
        // Best effort: if theming fails the token fallbacks in app.css still hold.
        try {
          if (bridge.view.theme && bridge.view.theme.enable) bridge.view.theme.enable();
        } catch (error) {
          /* keep the fallback palette */
        }
        return reload();
      })
      .catch(function (error) {
        clear(root);
        root.removeAttribute('aria-busy');
        root.appendChild(el('div', { class: 'notice notice--error', text: describe(error) }));
      });
  }

  boot();
})();
