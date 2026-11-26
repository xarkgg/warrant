# The demo video — a production preset

Target: **3:30–4:00**, hard ceiling 5:00. Public on YouTube. It is one fifth of
the score on its own, and it is the only way a judge sees the other four fifths.

---

## 1. What the rules actually demand

From the Codegeist 2026 page, verbatim constraints that shape every decision
below:

- **"under 5 minutes … Judges are not required to watch beyond five minutes."**
  So the whole case must land by 4:00. Never rely on minute six.
- **"demonstrates your project and any relevant bonus prize specifics."** The
  four bonus lanes are not implied by a good demo — each needs its own visible
  evidence. There is a lane checklist at the bottom of this file.
- **YouTube, public.** Not unlisted, not Vimeo, not a Drive link.
- **"Provide access … an installation link … for the judges."** Separate
  deliverable, but it is scored under Technological Implementation, and a video
  showing a site the judges cannot open reads as a mock-up.

Judging, all at 20%: implementation (a real system, not "a single hardcoded demo
path"), design (a coherent product, not a proof of concept), impact (a real
audience and a specific problem), innovation, presentation (working end-to-end,
problem / who it's for / why it matters, easy to follow).

Every beat below is aimed at one of those five. If a beat serves none of them,
it gets cut.

---

## 2. The spine: what the story is

A refusal, not a feature tour. The product is only interesting at the moment an
agent is stopped — that is the shot nothing else in this hackathon will have.

> An agent can already edit Jira. What it cannot do is prove it was allowed to.

So the video is one loop, twice: ask → see → sign → run (allowed) and
ask → see → **refuse** → queue → one-off approval → undo.

---

## 3. Beat sheet

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:10 | A Jira board, normal. Nothing app-branded yet. | "Every team is being told to hand work to an agent. The blocker was never capability." |
| 0:10–0:22 | Same board. | "It's that *let the agent update Jira* is an all-or-nothing decision. Grant it and you've given a model your backlog." |
| 0:22–0:40 | Rovo, agent **Steward**. It calls `request-warrant` for nine stale issues. The request card appears in the issue panel. | "So we made permission an object. The agent doesn't get access. It gets a request." |
| 0:40–1:20 | The request card, close. Signals appear one by one: an unmerged pull request, a comment from two hours ago, a goal that moves if this closes, two issues blocked by it. | "Before you sign anything, Warrant shows what this permission would actually touch — live, from Jira and from Teamwork Graph: the pull request still open, the argument from this morning, the goal behind it." |
| 1:20–1:45 | The sign dialog. Two issues trimmed out of the list. The ceiling drops. The meter appears: `0/7`, 30 minutes. | "You can narrow it. You cannot widen it — the window only closes. Nine issues become seven, thirty minutes, seven writes." |
| 1:45–2:15 | A write that is covered: the issue transitions. The ledger row appears. | "Inside that window, the agent works normally. Every write lands in one ledger, and every one carries what's needed to reverse it." |
| 2:15–2:55 | The agent tries `jira.assign` on an issue that is *not* in the warrant. Refusal, with the reason, in the agent's own conversation. Then: **Waiting on you** in the console, `Approve once`, the write happens, **Undo** puts it back. | "And the moment it steps outside? It isn't dropped and it isn't an error. It's refused with the reason, and it waits for a person — who can approve that one change, and take it back." |
| 2:55–3:15 | Same four tools in an MCP client, listed and called once. | "The same tools are an MCP server, so a warrant doesn't care which model is holding the keyboard." |
| 3:15–3:30 | The Authority console: five counters, four groups, one expired row. | "And one page for the whole site — every grant, whose it is, what's left, and what has expired, because expiry is read from the clock, not swept by a job." |
| 3:30–3:48 | The Marketplace listing (or review ticket), then a still of the panel. | "Scoped, expiring, revocable authority for agents in Jira. Install it from the Marketplace — and the first thing you'll notice is that it refuses." |

Trim order if you overrun: drop 3:15–3:30, then shorten 0:00–0:22. **Never**
trim 2:15–2:55.

---

## 4. Capture — the footage comes first

Nothing else can start until real footage exists, and today none does. In order:

1. **Ask me for the fixture harness before recording.** The UI already renders
   from a stub in `scripts/probe-ui.mjs`; driving it with worst-case data first
   means the video never shows a row collapsing or a blank state by accident.
2. **Record the real thing** once the app is open on the site: the panel, the
   console, Rovo. Real Jira chrome is the credibility — a fixture looks like a
   prototype, which is exactly the judging criterion at risk.
3. **Capture spec:** 1440×900 or 1920×1080, browser at 100% zoom (125% is a
   common laptop default and it makes text enormous on video), one window, no
   bookmarks bar, no personal data in frame. Record at 60fps if the tool allows
   — smooth cursor motion reads as production value.
4. **Two takes of the refusal.** It is the money shot; do not discover on the
   last take that the toast covers the button. (A real bug of exactly that shape
   shipped in another project of ours — a fixed toast ate a tap.)
5. **Do not fake a Rovo frame.** If the agent cannot be driven end-to-end by
   recording day, the request is still real — a person proposes it from the
   panel — and the voice-over says "an agent, or a person, asks". A judge who
   installs the app and finds that the agent screen was staged has caught you in
   the one thing the rules call out: "not just a single hardcoded demo path".

---

## 5. Graphics — what is worth building, and what is not

Keep graphics under 25 seconds total. Every second of animation is a second not
spent on the product, and presentation is scored on *clarity*, not on polish
density.

- **Title card** (2–3s): "Warrant" + one line. No logo sting.
- **The blast-radius diagram** (6–8s): the one genuinely bespoke graphic — a
  permission as a shape with things inside it and things outside it. This is
  where an isometric figure earns its place.
- **Lower-third per bonus lane** (3 × 2s): Rovo agent, MCP, Teamwork Graph,
  Marketplace. Cheap, and they make the bonus claims undeniable.
- **End card** (3s): name, one sentence, install link.

Safe margins: keep all text inside 90% of frame — YouTube's player chrome eats
the bottom, and captions eat more.

---

## 6. Audio — the part everyone underestimates

- **Voice-over is the video.** Record it separately, close-mic'd, and cut picture
  to it — not the reverse. Phone-in-a-room is audible and it costs presentation
  points nothing else can recover.
- **Music:** a bed at roughly −22 LUFS under the voice, ducked. Licensed or
  original, never a commercial track with a credit line (attribution is not a
  licence; this is the same call we already made once for a jam entry).
- **SFX:** three, total. A soft tick when a signal appears, a low thud on the
  refusal, a click on Undo. More than that sounds like a template.
- **Captions:** burn them in or upload them — judges watch muted more often than
  anyone believes.

---

## 7. The pipeline

Three stages, all 1080p30 H.264, so the pieces concatenate without a re-encode
mismatch.

```
capture   (Playwright, one run per shot)
   ↓       webapp-testing skill; deterministic viewport, no cursor drift
graphics  (raea on macOS, or HyperFrames blocks for furniture)
   ↓       raea: composition → out/*.mp4, stills first with --at
concat    (ffmpeg: concat demuxer, -c copy where the encodes match)
   ↓
gate      (watch muted at 320px wide, then at 1×, then read the checklist)
```

- **Stills first.** Rendering a 4-minute timeline to check one title card is how
  a day disappears. `raea render piece.tsx --at 0,45,89` — look, then render.
- **Version the files.** `demo-v1.mp4`, `demo-v2.mp4`; never render over the
  previous cut.
- **One owner per stage.** Whoever writes the VO reads the picture cut for
  timing, and the editor never re-times the VO.

### Setting it up (macOS)

The graphics live in `video/` in this repo. Nothing there is required to shoot
the footage — it is only the 25 seconds of graphics — so this can happen in
parallel with recording.

```sh
# once
curl -fsSL https://raea.io/install | sh      # puts raea in ~/.raea and on PATH

# from the repo root, every time
cd video
raea render warrant.tsx --composition blast --at 0,60,140,239 -o stills/blast/   # look first
raea render warrant.tsx --composition blast -o out/blast.mp4                     # then render
raea render warrant.tsx --composition blast --alpha -o stills/blast-alpha/       # if it overlays footage
```

Four compositions, so render them by name. `--composition` is the flag; with no
flag raea renders the first one in the file, which is the title — a trap that
costs a round trip when you think you are looking at the blast radius.

Files and what they are for:

| File | What it is |
|---|---|
| `video/warrant.tsx` | Four compositions: `title`, `blast`, `lane`, `end` |
| `video/tokens.ts` | The palette, copied from the app's own CSS. **The colour source** — do not invent a hex |
| `video/stills/`, `video/out/` | Output, git-ignored |

Things about that file worth knowing before editing it:

- **It renders.** raea 0.1.8 on Linux, software Vulkan, ~140 ms a frame. All
  four compositions have been rendered on the runner and looked at.
  `--at` only ever looks at the **first** composition in a file, which is why
  the workflow renders each one by name instead:
  `raea render warrant.tsx --composition blast --at 60`. Use `--composition`,
  or you will keep re-checking the title card and think the others are fine.
- **`lane` must be rendered with `--alpha`.** Its ground is transparent because
  it sits over footage. Rendered without `--alpha`, every transparent pixel is
  written as black and the still reads as a black card — the first run of the
  stills job produced exactly that.
- **The exposure warnings are expected, not bugs.** raea reports "+2.4 stops
  over mid grey: the frame reads washed out unless it is meant high-key". It is
  meant: the ground is Jira's `#f7f8f9`. Do not "fix" it by darkening the card.
- **`raea check --quick` catches reading speed**, and it caught a real problem
  here: the original title tagline was 13 words held for 2.3 s (3.9 s of reading
  at raea's rate). The card was shortened to 9 words — "An agent asks for
  permission. A person signs it." — rather than lengthened, because a title card
  is not where a viewer should be doing arithmetic. It still warns (2.3 s held
  against 2.7 s of reading) and that is accepted: the voice-over says the line,
  and three seconds is the right length for a title card. Run the check after
  any copy change on a card and read the number, don't just clear the warning.
- **Every animated value reads `useCurrentFrame()` and every `interpolate` is
  clamped.** Keep it that way. A `useState` or a timer in there renders one
  frame and then lies about the rest.

If raea is unavailable or fights you, the fallback is HyperFrames (same HTML,
ready-made titles and lower-thirds in `hyperframes-registry`) — but pick one per
shot and concatenate the outputs; do not mix renderers inside one shot.

### What to send back

| Deliverable | Detail |
|---|---|
| Raw footage | One clip per beat from §3, named `01-ask.mp4`, `02-blast.mp4`, … |
| Graphics | `out/title.mp4`, `out/blast.mp4`, `out/lane-*.mp4`, `out/end.mp4` |
| Voice-over | Separately recorded, one file per beat, `vo-01.wav` … — not mixed into anything |
| Rough cut | Anything watchable, at any quality. A rough cut that exists beats a beautiful timeline that does not |
| Notes | Where the picture does not match the product. I would rather know at 1:00 than at 3:55 |

---

## 8. Skill map — what to use, and what to leave alone

### The spine of the preset

| Skill | What it does here |
|---|---|
| `raea` | Renders the bespoke shots (title, blast-radius diagram) as TSX on Timi's Mac. Frame-pure, so the render is reproducible. |
| `hyperframes` + `hyperframes-registry` | The furniture, without hand-building it: lower-thirds, captions, kinetic type, transitions. ~450 ready blocks — read the registry before inventing a visual. |
| `media-use` | Music, SFX, voice-over, transcripts, colour grade. The audio half of §6. |
| `webapp-testing` | The capture rig. Deterministic Playwright runs instead of a hand-held screen recording, so takes are repeatable. |
| `imagegen` | YouTube thumbnail (1280×720) and the Devpost cover image. |
| `anatomy` | The one isometric figure — a permission drawn as a physical object with things inside and outside it. |

### Supporting, if and only if they earn it

| Skill | When it's worth opening |
|---|---|
| `emil-design-eng`, `apple-design` | If Timi does the frontend pass: the UI in frame is 20% of the score (design), and these are the craft references. |
| `animation-vocabulary` | Naming notes between us ("that's a pop-in, not a fade") so feedback survives the round trip. |
| `break-ui` | One pass before recording: feed the worst-case data so nothing embarrassing is on camera. |
| `game-jam` | Scope discipline against a hard deadline. Its cuts-must-be-made instinct is right even though this is not a jam. |

### Explicitly not for this

`raea-bevy` and the whole `blender-*` family (no 3D in this video — a 3D object
would cost days and read as decoration), `unreal-*`, `solidity-auditor` / `fizz`
/ `x-ray`, `mobile-native`, `ask-sonner`, `write-swift`, `physics-tuning`,
`level-design`, `camera-systems`, `game-ui-ux`, `orbital-hud-motion`,
`mascot-logo-reconstruction` and the `reference-*` / `multiview-*` /
`texture-*` reconstruction set, `prototype-fast`, `brag` (it launches a website,
not an app). None of these make the video better; some would eat the schedule.

---

## 9. Lane checklist — does the video prove each bonus prize?

- [ ] **Rovo / assignable agents** — the Steward agent calling a tool on screen.
- [ ] **Atlassian MCP** — the tool list in an MCP client, and one call returning.
- [ ] **Teamwork Graph** — a signal that could only come from the graph (linked
      pull request, linked goal), and the words "Teamwork Graph" in the VO.
- [ ] **Marketplace** — the listing screenshot or the review ticket id, on
      screen, and the listing link in the Devpost description.

## 10. Reference video (to be supplied)

The cut should follow one reference, not a mood board. When it arrives, it gets
taken apart along five axes and each answer gets applied to §3:

1. **Cold open** — how many seconds before the product appears, and what is on
   screen in that time.
2. **Pace** — average shot length, and where it deliberately slows down. A demo
   that cuts every 2 seconds cannot show a decision being made.
3. **Captions / lower-thirds** — position, size, whether they are burned in.
4. **Audio** — is the voice continuous, or does it stop to let the UI breathe?
5. **Close** — what the last ten seconds contain.

What will not be copied: its product, its claims, or its music. A structure is a
structure; a track is a licence.

## 11. The last gate

Watch it once at 320px wide, muted. If the story is not legible at that size
with no sound, the judge on a laptop at 1.25× will not follow it either.
