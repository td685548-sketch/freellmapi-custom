/**
 * A full-screen WebGPU transition. Each effect is one WGSL module drawn as a
 * single triangle over the page: the fragment shader decides, per pixel and per
 * moment, how much of the old page is hidden and what is painted over it.
 */
export interface Effect {
  id: 'galaxy' | 'ink'
  /** Total running time in milliseconds. */
  duration: number
  /** Progress (0..1) at which the page is fully hidden and the route may change. */
  coveredAt: number
  /** Shader with `vs` and `fs` entry points over the shared uniform block. */
  wgsl: string
  /** Four colours (RGBA, 0..1) the shader reads as `u.c0` … `u.c3`. */
  palette(dark: boolean): [number[], number[], number[], number[]]
}

/** `#rrggbb` → [r, g, b, 1] in 0..1. */
export const rgb = (hex: string): number[] => [
  ...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255),
  1,
]

/**
 * Uniform block shared by every effect (96 bytes). Kept in one place so the
 * WGSL prelude and the TypeScript writer cannot drift apart.
 *
 *   res     canvas size in pixels
 *   origin  where the transition starts, in canvas pixels from the top-left
 *   t       progress 0..1
 *   dark    1 in the dark theme
 *   reach   distance in pixels from origin to the farthest screen corner
 *   scale   canvas pixels per CSS pixel
 *   c0..c3  the effect's palette
 */
export const UNIFORM_FLOATS = 24

export const prelude = /* wgsl */ `
struct Uniforms {
  res: vec2f,
  origin: vec2f,
  t: f32,
  dark: f32,
  reach: f32,
  scale: f32,
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
  c3: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

const TAU = 6.28318530718;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn easeOut(x: f32) -> f32 { let k = 1.0 - x; return 1.0 - k * k * k; }
fn easeInOut(x: f32) -> f32 { return x * x * (3.0 - 2.0 * x); }

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let e = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, e, w.x), w.y);
}

// Five octaves of value noise, normalised to 0..1.
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 5; i = i + 1) {
    sum = sum + amp * vnoise(p);
    p = vec2f(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) * 2.02 + vec2f(17.0, 9.0);
    amp = amp * 0.5;
  }
  return sum / 0.96875;
}
`
