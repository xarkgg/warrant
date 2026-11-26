# Trying Warrant

Warrant is installed on **`one-atlas-lkwc.atlassian.net`** (development
environment). This is how to open it, what to click, and what is deliberately
empty.

---

## 1. Open it

**The Authority console** — the site-wide view.

Jira top bar → **Apps** (the grid of squares) → look for the app, module title
**Authority**. It opens a full page under `/jira/apps/`.

If the menu does not show it, the app is still installed; check that the
development deployment is live with:

```sh
forge environments list        # development should be the newest deploy
```

**The issue panel** — the per-issue view, which is where the product actually
lives.

Open any issue in any project, then click the **Warrant badge** — the purple
rosette with a yellow `!` — in the right-hand panel strip (the column of app
icons next to Comments / More fields).
If the strip is collapsed, the icon is under **More** or the `+` at the end of
the strip.

> The panel reads the issue's own key and summary from the Forge context. It
> will tell you which issue it is looking at at the top; if it says nothing, the
> app is not running in the panel context and you are looking at the console.

---

## 2. The first thing you will see is empty, on purpose

Both surfaces open with zeros and a sentence explaining what would be there.
That is not a bug: **Warrant has no authority to show until someone asks for
some.** There is no seeded demo data.

- Console: five counters at zero, four empty groups.
- Panel: the blast radius for *this* issue (this is real, computed now), then
  "nothing pending" under Requests, and "No authority" under Authority.

The panel's blast radius is the one part that should never be empty-looking on a
real issue with history — it names specific issues. If it is thin, see §5.

---

## 3. A two-minute tour, without an agent

Everything here is a human acting on their own behalf, which is the honest way
to see the shape of the thing.

1. **Open an issue you own** with a status you can move (something in To Do or
   In Progress, not Done if you want to reverse it later).
2. Scroll to the **Propose a change** section at the bottom of the panel.
3. Set **Operation** = `Transition`, **Target status** = one of the names listed
   under "available now", **Why** = a sentence you would accept from a
   colleague, **Actions** = 1, **Minutes** = 30.
4. Press **Propose**. This creates a *request*, not a permission. It appears
   under **Requests on this issue**, with the blast radius attached.
5. Press **Sign**. Now a row appears under **Authority over this issue**: the
   operation, the scope sentence, who signed it, a `0/1` meter and **Revoke**.
6. Press **Revoke**. The row moves out of the live list and the ledger records
   the revocation.

Notice what did **not** happen: the issue never moved. Signing does not perform
the write. Authority and execution are separate, and only a warrant can bridge
them.

---

## 4. Beginner test: create a task and let Warrant comment on it

This is the complete path from an empty Jira site to a visible write. A comment
is the easiest first test because it does not depend on a project's workflow or
status names.

> **Two different pieces are involved.** The Warrant panel lets a human inspect
> and sign authority. It does not execute Jira work. The Rovo agent named
> **Steward** requests and uses that authority. Signing and execution are
> deliberately separate.

### A. Check the prerequisites

1. Open any Jira work item and open its Warrant panel. It must load without
   `unknown action: (none)`. The **Operation** list at the bottom should contain
   **Change status**, **Add a comment**, and **Assign an issue**. If it does not,
   stop: the fixed production version has not been deployed yet.
2. Look for **Chat** in Jira's top navigation. If Chat is absent, a site admin
   must activate Rovo before an app-based agent can be used.

### B. Create the Jira task

1. Select **Create (+)** in Jira's top navigation.
2. Select an existing **Project**. If the site has no project, create a simple
   team-managed project first, then return to **Create**.
3. Set **Work type** (sometimes labelled **Issue type**) to **Task**.
4. Set **Summary** to `Warrant comment test`. Leave the task in **To Do**.
5. Select **Create**, then open the task.
6. Copy its key from the task header. It will look like `WRT-1`, but use the key
   Jira actually created; do not literally use `WRT-1` in the steps below.

### C. Ask Steward to do the work

1. Select **Chat** in Jira's top navigation.
2. In Chat, select **Agents**, search for **Steward**, and select it. Start a new
   conversation if Jira offers that choice.
3. Replace `WRT-1` with the real key and send this exact message:

   > Add the exact comment "Warrant performed this test" to WRT-1. Use Warrant's
   > tools. First request a warrant for `jira.comment` on only WRT-1, with 1
   > action and 30 minutes. Do not claim the comment was added until it was.

4. Steward should report that it **requested a warrant** and that nothing has
   happened yet. The comment should not be on the task yet.

If **Steward** is not in the Agents search, confirm that Rovo is active and that
the current production version of Warrant is installed on this same Jira site.

### D. Sign the request

1. Return to the task and open its purple Warrant badge. Alternatively, open
   **Apps → Authority**.
2. Under **Requests on this issue**, find the new card. Confirm all of these:
   - operation: **Add a comment** / `jira.comment`;
   - scope: only the task key you created;
   - Actions: `1`;
   - Minutes: `30` or less.
3. Select **Sign**. This grants permission; it still does not add the comment.
4. Under **Authority over this issue**, an active warrant should now show `1/1`.

### E. Tell Steward to continue

1. Return to the **same Steward conversation**. Send:

   > The warrant is signed. Check authority again, then add the exact comment
   > "Warrant performed this test" to WRT-1 now.

2. Steward should call `check-warrant`, then `perform-change`, and report
   **Done**. It must not ask you to sign a second request.

### F. Prove that it worked

1. Refresh or reopen the Jira task. Its comments should contain
   `Warrant performed this test`.
2. Open the issue's Warrant panel again. **Authority over this issue** should be
   empty because the one permitted action has been spent.
3. Open **Apps → Authority**, expand **Spent and closed**, and confirm that the
   warrant shows `0/1` and `budget spent`.
4. Back on the issue's Warrant panel, **Recent activity** should contain a
   **changed** event for the comment and offer **Undo**.
5. Optional: select **Undo**. Refresh the task; the test comment should be gone,
   and Warrant should record a **reverted** event.

If Steward tries a write the warrant does not cover, the refusal is **queued**,
not dropped. It appears under **Waiting on you** with **Approve once**, which
performs only that single change on your authority.

**MCP.** The same four tools are exposed at
`https://mcp.atlassian.com/forge/<app-id>`. By default an admin has to enable
the app's exposure in **Connected apps** before an MCP client sees them; if a
client lists no Warrant tools, that switch is why.

**Anything else** that calls the four actions gets identical treatment. A
warrant does not care which model is holding the keyboard.

---

## 5. What the blast radius is reading

Each signal is a named fact about the issues in the request, from Jira and from
Teamwork Graph:

| Signal | Where it comes from |
|---|---|
| Code is mid-flight | a linked pull request that has not been merged (Teamwork Graph) |
| Someone is talking about this now | a comment in the last 48 hours |
| Other work is waiting on this | the issue blocks work that is still open |
| This is waiting on something else | an issue it depends on is still open |
| A goal is attached | a linked Atlassian goal moves when this closes (Teamwork Graph) |
| A customer reported it | a customer / support / severity / escalation marker |
| Nothing has happened in a month | no update and no comment for 30 days |

Teamwork Graph scopes are **per object type**, and a missing scope returns an
empty result rather than an error — so a thin briefing with no explanation is a
permissions symptom, not a data one. To tell the two apart:

```sh
forge logs -e development -s 10m -n 200
```

The graph adapter logs the query it asked and why it returned nothing.

---

## 6. Boundaries worth stating out loud

- **Three operations**: `jira.transition`, `jira.comment`, `jira.assign`. Not a
  general-purpose Jira writer.
- **Scope is a frozen list of issue keys**, resolved once. A JQL query in the
  request becomes a list at request time; it is never re-run, so a grant cannot
  quietly grow as issues enter the query.
- **A grant may narrow, never widen.** The sign dialog can trim the scope and
  lower the ceiling. Nothing can raise them above what was asked for.
- **Expiry is read from the clock**, not swept by a job. A warrant is expired
  the instant you look at it after its time, whether or not anything ran.
- **Every executed write is reversible** where Jira allows it: the ledger keeps
  the prior value, and **Undo** is offered on the event.
