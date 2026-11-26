/**
 * Warrant's palette, for the video only.
 *
 * These are the same values the product ships with, taken from
 * `static/ui/app.css` at the point where Jira's tokens fall back. The video and
 * the app must look like the same object, so this file — not a designer's
 * instinct — is where a colour comes from. If the app's palette changes, change
 * this file in the same commit.
 */

export const colour = {
  ground: '#f7f8f9', // page behind the console
  raised: '#ffffff', // cards, rows, panels
  ink: '#1d2125',
  ink2: '#44546f',
  ink3: '#626f86',
  line: '#dcdfe4',
  lineStrong: '#8590a2',
  accent: '#0c66e4', // the Jira blue the sign button uses
  danger: '#e2483d',
  dangerInk: '#ae2a19',
  ok: '#216e4e',
  warn: '#7f5f01',
  white: '#ffffff',
};

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

/** Text and graphics must clear this or YouTube's chrome eats them. */
export const safe = {
  x: 96,
  y: 84,
};

/** 1920x1080 at 30fps, for every composition in this folder. */
export const frame = {
  width: 1920,
  height: 1080,
  fps: 30,
};
