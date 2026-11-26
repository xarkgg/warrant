/**
 * The four graphics the video needs, and nothing else.
 *
 * Everything here is a function of the frame: no state, no timers, no random.
 * That is what makes a render reproducible, and it is the one rule that will
 * silently ruin a cut if it is broken.
 *
 * UNVERIFIED ON THE PHONE — the raea CLI does not build for aarch64, so nothing
 * here can be rendered locally. What has been rendered is the `title`
 * composition, on Linux through software Vulkan (145 ms a frame, 0 errors).
 * The other three are rendered by `.github/workflows/video-stills.yml` but have
 * not been looked at yet. `--at` only inspects the FIRST composition in a file,
 * so always pass `--composition`.
 *
 * Run from this folder:
 *   raea render warrant.tsx --composition blast --at 0,60,140,239 -o stills/
 *   raea render warrant.tsx --composition blast -o out/blast.mp4
 */

import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from 'raea';
import type { ReactNode } from 'react';
import { colour, font, frame, safe } from './tokens';

/** Every interpolate in this file is clamped; this keeps that promise visible. */
function ramp(frame: number, from: number, to: number, start = 0, end = 1) {
  return interpolate(frame, [from, to], [start, end], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

function Ground({ children }: { children: ReactNode }) {
  return (
    <AbsoluteFill
      style={{
        background: colour.ground,
        color: colour.ink,
        fontFamily: font.sans,
        padding: `${safe.y}px ${safe.x}px`,
        justifyContent: 'center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ 1. title
// 3s. One line, no logo sting. "Warrant" rises a few pixels and settles.

function Title() {
  const f = useCurrentFrame();
  const rise = ramp(f, 0, 18, 10, 0);
  const opacity = ramp(f, 0, 12);

  return (
    <Ground>
      <div style={{ maxWidth: 1100 }}>
        <div style={{ opacity: ramp(f, 6, 20), fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700, color: colour.ink3 }}>
          Scoped authority
        </div>
        <div
          style={{
            opacity,
            transform: `translateY(${rise}px)`,
            fontSize: 132,
            fontWeight: 600,
            letterSpacing: '-0.035em',
            lineHeight: 1,
            marginTop: 14,
          }}
        >
          Warrant
        </div>
        <div
          style={{
            opacity: ramp(f, 10, 26),
            marginTop: 26,
            width: 96,
            height: 3,
            background: colour.accent,
          }}
        />
        <div style={{ opacity: ramp(f, 14, 30), marginTop: 26, fontSize: 38, color: colour.ink2, lineHeight: 1.35 }}>
          An agent asks for permission.
          <br />
          A person signs it.
        </div>
      </div>
    </Ground>
  );
}

// ------------------------------------------------------------ 2. blast radius
// 8s. The one bespoke graphic: a permission drawn as a boundary, with the work
// it touches inside it and the work it does not touch outside.

const INSIDE = ['PAY-412', 'PAY-431', 'PAY-388', 'PAY-402', 'PAY-417', 'PAY-455', 'PAY-460'];
const OUTSIDE = ['PAY-501', 'PAY-477'];

function Chip({ text, index, tone }: { text: string; index: number; tone: 'in' | 'out' }) {
  const f = useCurrentFrame();
  const from = 18 + index * 4;
  const opacity = ramp(f, from, from + 10, 0, 1);
  const shift = ramp(f, from, from + 12, 8, 0);
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${shift}px)`,
        fontFamily: font.mono,
        fontSize: 26,
        padding: '10px 18px',
        borderRadius: 8,
        border: `1px solid ${tone === 'in' ? colour.line : colour.danger}`,
        background: tone === 'in' ? colour.raised : 'transparent',
        color: tone === 'in' ? colour.ink : colour.dangerInk,
      }}
    >
      {text}
    </div>
  );
}

function BlastRadius() {
  const f = useCurrentFrame();
  const boxOpacity = ramp(f, 0, 14);
  const caption = ramp(f, 120, 140);
  const strike = ramp(f, 96, 116, 0, 1);

  return (
    <Ground>
      <div style={{ opacity: ramp(f, 0, 12), fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700, color: colour.ink3 }}>
        If this is signed
      </div>
      <div style={{ opacity: ramp(f, 2, 16), fontSize: 56, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 12 }}>
        Nine issues, and what each one is holding.
      </div>

      <div style={{ display: 'flex', gap: 64, marginTop: 52, alignItems: 'flex-start' }}>
        <div
          style={{
            opacity: boxOpacity,
            flex: '1 1 0',
            border: `1px solid ${colour.line}`,
            borderRadius: 10,
            background: colour.raised,
            padding: 28,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: colour.ok }}>
            Inside the warrant · 7
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 20 }}>
            {INSIDE.map((key, index) => (
              <Chip key={key} text={key} index={index} tone="in" />
            ))}
          </div>
        </div>

        <div style={{ opacity: boxOpacity, flex: '0 0 420px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: colour.dangerInk }}>
            Outside it · refused
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
            {OUTSIDE.map((key, index) => (
              <Chip key={key} text={key} index={INSIDE.length + index} tone="out" />
            ))}
          </div>
          <div
            style={{
              marginTop: 26,
              height: 3,
              width: `${strike * 100}%`,
              background: colour.danger,
            }}
          />
          <div style={{ opacity: ramp(f, 116, 132), marginTop: 18, fontSize: 24, color: colour.ink2, lineHeight: 1.4 }}>
            A refusal is an event, not an error. It waits for a person.
          </div>
        </div>
      </div>

      <div style={{ opacity: caption, marginTop: 44, fontSize: 22, color: colour.ink3 }}>
        Live, from Jira and from Teamwork Graph — linked pull requests, comments, goals, blockers.
      </div>
    </Ground>
  );
}

// --------------------------------------------------------- 3. bonus lower-third
// 2s. One per bonus lane. Change `lane` and `sub`, keep everything else.

function LowerThird() {
  const f = useCurrentFrame();
  const slide = ramp(f, 0, 10, -24, 0);
  const opacity = ramp(f, 0, 8);
  const out = ramp(f, 50, 60, 1, 0);

  const lane = 'Teamwork Graph';
  const sub = 'linked pull requests and goals, read live';

  return (
    <AbsoluteFill style={{ background: 'transparent' }}>
      <div
        style={{
          position: 'absolute',
          left: safe.x,
          bottom: safe.y + 40,
          opacity: opacity * out,
          transform: `translateX(${slide}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '16px 24px',
          borderRadius: 10,
          background: 'rgba(29, 33, 37, 0.94)',
          color: colour.white,
          fontFamily: font.sans,
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: 5, background: colour.accent }} />
        <div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.01em' }}>{lane}</div>
          <div style={{ fontSize: 20, color: '#c7cdd4', marginTop: 2 }}>{sub}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

// -------------------------------------------------------------------- 4. end
// 3s. Name, one sentence, where to get it. Nothing else.

function EndCard() {
  const f = useCurrentFrame();
  return (
    <Ground>
      <div style={{ opacity: ramp(f, 0, 14) }}>
        <div style={{ fontSize: 74, fontWeight: 600, letterSpacing: '-0.03em' }}>Warrant</div>
        <div style={{ marginTop: 20, fontSize: 32, color: colour.ink2, maxWidth: 900, lineHeight: 1.4 }}>
          Scoped, expiring, revocable authority for agents working in Jira.
        </div>
        <div style={{ marginTop: 34, fontFamily: font.mono, fontSize: 24, color: colour.ink3 }}>
          xarkgg.github.io/warrant-site
        </div>
      </div>
    </Ground>
  );
}

registerRoot(() => (
  <>
    <Composition id="title" width={frame.width} height={frame.height} fps={frame.fps} durationInFrames={90} component={Title} />
    <Composition id="blast" width={frame.width} height={frame.height} fps={frame.fps} durationInFrames={240} component={BlastRadius} />
    <Composition id="lane" width={frame.width} height={frame.height} fps={frame.fps} durationInFrames={60} component={LowerThird} />
    <Composition id="end" width={frame.width} height={frame.height} fps={frame.fps} durationInFrames={90} component={EndCard} />
  </>
));
