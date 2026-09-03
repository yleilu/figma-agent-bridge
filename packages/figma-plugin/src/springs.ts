import type { SpringConfig } from '@react-spring/web'

// The one home for the panel's motion (Motion Review artifact,
// 2026-07-24). No spring tuning lives inline in a hook or a
// component. mass omitted = react-spring default (1).
//
// There are exactly TWO configs, because there are exactly two
// kinds of motion — a transition and a loop. Anything that eases
// from one state to another uses MOTION_SPRING; per-element
// tuning is not a thing we do, so two elements never move at
// subtly different speeds for no reason.
//
// EVERY spring is CLAMPED. These are underdamped (260/26 would
// need ~32 friction to critically damp), so left alone they
// overshoot and swing back. `clamp` stops each spring dead at its
// target instead: the fast, physical approach is kept, but nothing
// in the panel ever bounces past where it is going. Bounce reads
// as toy-like in Figma chrome. Clamping here rather than by
// hand-raising friction keeps the rule immune to retuning — a new
// config below is only bounce-free if it spreads CLAMPED too.
const CLAMPED = { clamp: true } as const

// Every transition: roster rows entering/leaving, the selection
// bar collapsing in and out, the status-text crossfade. One curve
// for the whole panel, so everything that moves moves alike.
export const MOTION_SPRING: SpringConfig = {
  ...CLAMPED,
  tension: 260,
  friction: 26,
}

// The looping indicators: the busy dot's breathing pulse and the
// typing-dots trail. Deliberately NOT MOTION_SPRING — for a loop
// the config sets the TEMPO, not the feel of a change. On the
// transition curve a pulse cycles in ~0.6s and reads as blinking;
// this slower, softer spring keeps it a breath (~1.1s), inside the
// design system's "subtle, <=1.8s" rule for loops.
export const LOOP_SPRING: SpringConfig = {
  ...CLAMPED,
  tension: 120,
  friction: 14,
}

// There is deliberately NO window-edge spring. The outer Figma
// window follows its measured content 1:1 (see useWindowResize):
// a spring on the frame would chase a target that is still moving
// while the content animates, so it always settled after the
// content did — visible as the window edge lagging the selection
// bar. The content owns the motion; the frame just matches it.
