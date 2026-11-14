/**
 * A full-screen WebGPU transition. Each effect is one WGSL module drawn as a
 * single triangle over the page: the fragment shader decides, per pixel and per
 * moment, how much of the old page is hidden and what is painted over it.
 */
export interface Effect {
  id: 'galaxy' | 'blackhole'
  /** Total running time in milliseconds. */
  duration: number
  /** Progress (0..1) at which the page is fully hidden and the route may change. */
  coveredAt: number
  /** Shader with `vs` and `fs` entry points over the shared uniform block. */
  wgsl: string
  /**
   * Number of star sprites drawn after the background, additively. The shader then
   * also defines `vsStar`; `fsStar` and the sprite helpers come from the prelude.
   */
  particles?: number
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

// ---- star sprites: instanced quads, positions computed from (id, t) alone ----
struct StarOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec2f,   // pixels along / across the streak, from its middle
  @location(1) seg: vec3f,   // half length, half width, brightness
  @location(2) color: vec3f,
  @location(3) flare: f32,   // 0 for an ordinary star; up to 1 for a bright one with diffraction spikes
};

fn cornerOf(vi: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  return c[vi];
}

fn toClip(px: vec2f) -> vec4f {
  return vec4f(px.x / u.res.x * 2.0 - 1.0, 1.0 - px.y / u.res.y * 2.0, 0.0, 1.0);
}

// Star colour from temperature, h = 0 (cool: orange-red) … 1 (hot: blue-white).
fn starTint(h: f32) -> vec3f {
  let a = mix(vec3f(1.0, 0.52, 0.30), vec3f(1.0, 0.85, 0.64), smoothstep(0.0, 0.4, h));
  let b = mix(a, vec3f(1.0, 0.97, 0.92), smoothstep(0.35, 0.65, h));
  return mix(b, vec3f(0.62, 0.75, 1.0), smoothstep(0.72, 1.0, h));
}

// A glowing streak from tail to head (canvas px). A near-zero length makes a round
// star, and its direction then sets how the diffraction spikes of a bright one are turned.
fn streak(vi: u32, tail: vec2f, head: vec2f, width: f32, color: vec3f, brightness: f32, flare: f32) -> StarOut {
  let c = cornerOf(vi);
  let delta = head - tail;
  let len = max(length(delta), 0.001);
  var n = vec2f(1.0, 0.0);
  if (length(delta) > 0.0005) { n = delta / len; }
  let side = vec2f(-n.y, n.x);
  let halfLen = len * 0.5;
  let pad = width * (3.0 + 34.0 * flare);
  let mid = (head + tail) * 0.5;
  let along = c.x * (halfLen + pad);
  let across = c.y * pad;
  var o: StarOut;
  o.pos = toClip(mid + n * along + side * across);
  o.rel = vec2f(along, across);
  o.seg = vec3f(halfLen, width, brightness);
  o.color = color;
  o.flare = flare;
  return o;
}

@fragment
fn fsStar(in: StarOut) -> @location(0) vec4f {
  let w = max(in.seg.y, 0.001);
  let dx = max(abs(in.rel.x) - in.seg.x, 0.0);
  let d = length(vec2f(dx, in.rel.y)) / w;
  let core = exp(-d * d * 1.6);
  let halo = exp(-d * 0.9) * 0.28;
  // Brighter at the head, fading along the tail.
  let along = clamp((in.rel.x + in.seg.x) / max(in.seg.x * 2.0, 0.001), 0.0, 1.0);
  let fade = mix(0.12, 1.0, along * along);
  var light = (core + halo) * fade;
  if (in.flare > 0.0) {
    // A real bright star: a wide soft bloom and a cross of diffraction spikes.
    let reach = w * (5.0 + 30.0 * in.flare);
    let ax = abs(in.rel.x - clamp(in.rel.x, -in.seg.x, in.seg.x));
    let spikes = exp(-ax / reach) * exp(-abs(in.rel.y) / (w * 0.22)) + exp(-abs(in.rel.y) / reach) * exp(-ax / (w * 0.22));
    light = light + exp(-d * 0.22) * 0.07 * in.flare + spikes * 0.55 * in.flare;
  }
  let lit = in.color * light * in.seg.z;
  // Premultiplied and additive: alpha follows the brightest channel so the colour stays valid.
  return vec4f(lit, min(max(lit.r, max(lit.g, lit.b)), 1.0));
}

fn rnd(i: u32, k: u32) -> f32 { return hash21(vec2f(f32(i) * 0.6180339 + f32(k) * 31.7, f32(k) * 7.31 + f32(i % 251u))); }

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
