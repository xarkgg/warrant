# Warrant

**Scoped, expiring, revocable authority for AI agents working in Jira.**

<!-- demo video link goes here -->

An agent that can edit anything cannot be trusted with anything. Warrant makes
permission an object: an agent asks for a *warrant*, a human sees what that
permission would actually touch, and only then signs it. Every write goes
through the warrant, everything is logged, and every change can be put back.

Built for [Codegeist 2026](https://codegeist2026.devpost.com/), whose theme is
"Build with context. Ship with confidence."

## The problem

Teams are being told to hand work to agents. The blocker is rarely capability.
The problem is that "let the agent update Jira" is an all-or-nothing decision.
Grant it and you have handed a model your whole backlog. Refuse it and the
agent is a chatbot with a nice UI.

What's missing is a scope, a clock, and a receipt.

## How it works

1. **Ask.** The agent (Rovo, or any MCP client) wants to close nine stale
   issues. It calls `request-warrant`. That creates a *request*, not a
   permission.
2. **See.** The request arrives with a blast radius computed from Jira and
   Teamwork Graph: which of those issues have unmerged pull requests, which
   carry a goal, which someone commented on in the last hour, which are
   blocking other work. Named signals, each pointing at the issues behind it.
3. **Sign.** A human trims the list, sets a ceiling and an expiry, and grants.
   A grant can only narrow what was asked for, never widen it.
4. **Enforce.** Every write passes through `perform-change`. Inside the
   warrant it runs. Outside it is refused with a specific reason and queued
   for a human instead of being dropped.
5. **Account.** The ledger holds requests, grants, refusals, writes and undos
   in one stream. Every executed write carries the information needed to
   reverse it.

## Three decisions that make it real

### A query is not a scope

JQL is resolved once, at request time, and frozen into an explicit list of
issue keys. An issue that starts matching the query an hour later was never
granted, so it is refused. This is the most common way agent permissions
quietly widen, and the only defence is to make the scope a list.

### Expiry is read from the clock

No background job flips a row to expired, because a missed run would leave
stale authority live. Storage records intent. The clock decides whether a
warrant currently carries authority.

### A refusal is an event

Blocked writes go to the ledger and into the approval queue with the reason
attached, so a human sees exactly where the agent ran out of authority. That
is precisely where their judgment is worth the most.

## What it runs on

- **Forge**: a Jira issue panel and a global *Authority* console, plus the
  serverless functions that enforce the warrant.
- **Rovo**: one agent with four actions, so the protocol is the agent's whole
  repertoire.
- **Rovo MCP**: the same four actions exposed as MCP tools, so Claude, Cursor
  or anything else speaks to the same gate. A warrant doesn't care which model
  is holding the keyboard.
- **Teamwork Graph**: linked pull requests and goals, which Jira alone cannot
  see.

## Honest limits

- Warrant enforces every write made *through its tools*. It cannot stop a
  human clicking a transition, and it is not a substitute for Jira permissions.
- Which agent made a call is self-declared. The platform does not hand app
  functions a verified agent identity, so a warrant binds the operation, the
  scope, the limits and the expiry, which are enforceable, and treats the
  agent name as a label.
- Undo covers what the app does: status, comment, assignee. It is not a
  database rollback.

## Under the hood

```
src/domain/    the policy core. Pure, no I/O, unit-tested
src/platform/  Jira REST and Teamwork Graph adapters
src/service/   the one path from intent to effect
src/store/     Forge Storage, with an in-memory driver for tests
static/ui/     the issue panel and the Authority console. Plain ES, no build
ui/            the source of the vendored Forge bridge
video/         the demo's graphics. Four raea compositions, no product code
tests/         node:test, runnable on a phone
```

```sh
npm test              # domain, store and service, no network
npm run check         # parse every file, catch what node --check misses
npm run probe:ui      # render both surfaces in a browser against real output
npm run build:bridge  # rebuild the vendored @forge/bridge bundle
forge deploy          # ship the app
```

The UI is buildless on purpose. `static/ui/app.js` is plain ES, and the only
generated file, `static/ui/vendor/bridge.js`, is committed. `forge deploy`
packages `static/` as it is.

## Status

Live in production on a Jira site today: the policy core, the issue panel, the
Authority console, the four agent actions and the MCP exposure all exist.
Distribution is by installation link rather than Marketplace, and
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) is the state of that.

Public page and privacy statement: https://xarkgg.github.io/warrant-site/

If the app is installed on your site, [`docs/TRY_IT.md`](docs/TRY_IT.md) is
the click-by-click tour: where it lives in Jira, what to press, and which
empty states are deliberate.
