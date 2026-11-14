import { prelude, rgb, type Effect } from './effect'

/**
 * FreeLLMAPI → Thruline: a spiral galaxy.
 *
 *   0.00 – 0.46  a galaxy blooms out of the switch button and swallows the page;
 *                its arms turn and stars begin to fly outward
 *   0.46 – 0.55  the page is fully hidden; the stars stretch into hyperspace
 *                streaks and the route changes
 *   0.55 – 0.62  a lit line runs across the middle of the screen and ends in a
 *                node: the Thruline mark, drawn as a through-line
 *   0.60 – 1.00  that line opens like a slit, then widens until the whole new
 *                page is showing, with a bright rim on the opening
 */
const shader = /* wgsl */ `
const GOLD = vec3f(1.0, 0.82, 0.55);

fn galaxy(d: vec2f, R: f32, spin: f32) -> vec3f {
  let g = length(d) / R;
  let ang = atan2(d.y, d.x);
  // A logarithmic spiral; cos/sin keep the noise free of the atan2 seam.
  let a = ang + 2.9 * log(g + 0.07) - spin;
  let armWave = 0.5 + 0.5 * cos(a * 2.0);
  var arms = pow(armWave, 2.4);
  let dust = fbm(vec2f(cos(a), sin(a)) * 1.6 + vec2f(g * 3.0, g * 3.0) + 7.0);
  // Fine dust lanes cut across the arms so they read as structure, not soft blobs.
  let lanes = fbm(vec2f(cos(a), sin(a)) * 5.0 + vec2f(g * 9.0, g * 9.0) + 31.0);
  arms = arms * (0.25 + 1.3 * dust) * (0.45 + 0.9 * lanes);
  let falloff = exp(-g * 1.7);
  let core = exp(-g * g * 55.0) * 2.2 + exp(-g * 7.0) * 0.5;
  let hue = mix(u.c2.rgb, u.c1.rgb * 2.2 + vec3f(0.1, 0.0, 0.25), smoothstep(0.1, 0.9, g));
  var col = hue * arms * falloff * 2.4;
  col = col + GOLD * core;
  let knots = pow(armWave, 9.0) * smoothstep(0.55, 0.9, dust) * falloff;
  col = col + u.c3.rgb * knots * 1.4;
  return col;
}

// Fixed, twinkling background stars on a jittered grid.
fn starGrid(px: vec2f, cell: f32, seed: f32, tw: f32) -> f32 {
  let q = px / cell;
  let id = floor(q);
  let f = fract(q) - 0.5;
  let h = hash21(id + seed);
  let off = (hash22(id + seed * 1.7 + 3.3) - 0.5) * 0.6;
  let dist = length(f - off);
  let size = mix(0.05, 0.16, h * h);
  let blink = 0.65 + 0.35 * sin(tw * (4.0 + 11.0 * h) + h * 40.0);
  return step(0.78, h) * (1.0 - smoothstep(0.0, size, dist)) * blink;
}

// Stars flying outward from a centre. Each angular bin owns one star per layer;
// the head runs away from the centre and drags a tail that lengthens with speed.
fn warpStars(dc: vec2f, tt: f32, speed: f32) -> f32 {
  var acc = 0.0;
  let rc = length(dc);
  let turn = atan2(dc.y, dc.x) / TAU + 0.5;
  for (var layer = 0; layer < 3; layer = layer + 1) {
    let L = f32(layer);
    let bins = 120.0 + L * 70.0;
    let x = turn * bins;
    let cell = floor(x);
    let h = hash21(vec2f(cell, L * 31.7 + 3.1));
    let h2 = hash21(vec2f(cell + 91.3, L * 7.7));
    let across = abs(fract(x) - 0.5);
    let phase = fract(h * 13.0 + tt * (0.35 + 0.22 * L) + L * 0.37);
    let head = phase * phase * 1.9;
    let len = 0.012 + speed * (0.05 + head * 0.55);
    let dr = head - rc;
    let inTail = step(0.0, dr) * (1.0 - smoothstep(0.0, len, dr));
    let thin = 1.0 - smoothstep(0.0, 0.09, across);
    let born = smoothstep(0.02, 0.16, head);
    acc = acc + inTail * inTail * thin * born * step(0.55, h2) * (0.45 + 0.55 * h);
  }
  return acc;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let t = u.t;
  let o = frag.xy - u.origin;
  let d = o / u.reach;
  let r = length(d);
  let mn = min(u.res.x, u.res.y);

  // ---- the galaxy swallows the page ----
  let x = clamp(t / 0.46, 0.0, 1.0);
  let grow = 1.0 - pow(1.0 - x, 2.4);
  let R = max(grow * 1.32, 0.05);
  let spin = 5.0 * t + 5.0 * t * t;
  let turb = (fbm(d * 3.0 + vec2f(t * 2.0, -t * 1.3)) - 0.5) * 0.22;
  let seed = smoothstep(0.0, 0.05, t);
  let disc = (1.0 - smoothstep(R - 0.18, R, r + turb)) * seed;

  let space = mix(u.c0.rgb, u.c1.rgb, fbm(d * 1.5 + vec2f(4.0, 4.0)) * 0.8);
  let gal = vec3f(1.0) - exp(-galaxy(d, R, spin) * 1.1);
  let galaxyFade = 1.0 - 0.7 * smoothstep(0.40, 0.62, t);

  // ---- stars: fixed ones, plus ones that fly out and stretch ----
  let still = starGrid(frag.xy - u.origin, 38.0 * u.scale, 1.0, t * 3.0)
            + starGrid(frag.xy - u.origin, 71.0 * u.scale, 5.0, t * 2.0) * 0.8;
  let warpCentre = mix(u.origin, u.res * 0.5, smoothstep(0.30, 0.58, t));
  let speed = smoothstep(0.22, 0.55, t) * (1.0 - smoothstep(0.62, 0.95, t));
  let flying = warpStars((frag.xy - warpCentre) / mn, 3.0 * t + 6.0 * t * t * t, speed);
  let starTint = mix(vec3f(1.0), u.c3.rgb, 0.45);
  var col = space + gal * galaxyFade + starTint * (still * 0.9 + flying * 1.6);

  // Bright shock front on the leading edge of the bloom.
  let frontR = r + turb * 0.5 - R + 0.03;
  let front = (exp(-pow(frontR / 0.016, 2.0)) + 0.22 * exp(-pow(frontR / 0.10, 2.0))) * seed * (1.0 - smoothstep(0.38, 0.47, t));
  col = col + u.c3.rgb * front * 1.3;

  // ---- the through-line, then the slit that opens onto the new page ----
  let dn = (frag.xy - u.res * 0.5) / (u.res * 0.5);
  let sweepX = mix(-1.15, 1.15, smoothstep(0.50, 0.58, t));
  let lineOn = smoothstep(0.50, 0.53, t) * (1.0 - smoothstep(0.64, 0.74, t));
  let line = exp(-abs(dn.y * u.res.y * 0.5) / (3.0 * u.scale)) * step(dn.x, sweepX) * lineOn;
  let nodeAt = vec2f(u.res.x * 0.5 * 1.62, u.res.y * 0.5);
  let nodeDist = length(frag.xy - nodeAt) / (mn * 0.045);
  let node = (1.0 - smoothstep(0.55, 1.0, nodeDist)) * smoothstep(0.56, 0.59, t) * (1.0 - smoothstep(0.70, 0.80, t));
  let halo = exp(-nodeDist * 1.4) * 0.5 * smoothstep(0.56, 0.59, t) * (1.0 - smoothstep(0.70, 0.84, t));

  let hx = 1.75 * easeOut(clamp((t - 0.55) / 0.17, 0.0, 1.0));
  let hy = 0.010 + 1.95 * easeInOut(clamp((t - 0.64) / 0.36, 0.0, 1.0));
  let wobble = (fbm(dn * 4.0 + vec2f(t * 1.5, 3.0)) - 0.5) * 0.07;
  let e = length(vec2f(dn.x / max(hx, 0.001), dn.y / hy)) + wobble;
  let hole = 1.0 - smoothstep(0.86, 1.0, e);
  let rim = exp(-pow((e - 0.94) / 0.05, 2.0)) * smoothstep(0.55, 0.60, t) * (1.0 - smoothstep(0.90, 1.0, t));

  let light = u.c3.rgb * (line * 1.5 + rim * 1.3 + halo) + vec3f(1.0) * (node * 1.4 + line * 0.4);
  col = col + light;

  var alpha = disc * (1.0 - hole);
  // Light stays visible even where the page is already showing through.
  alpha = max(alpha, clamp(max(front, max(line, max(node, rim))), 0.0, 1.0));
  // Soft tone curve so the glow never clips into flat white.
  col = vec3f(1.0) - exp(-col * 1.25);
  return vec4f(col * alpha, alpha);
}
`

export const galaxyEffect: Effect = {
  id: 'galaxy',
  duration: 2800,
  coveredAt: 0.5,
  wgsl: prelude + shader,
  palette: () => [
    rgb('#05060f'), // deep space
    rgb('#241a66'), // nebula violet
    rgb('#4d7cff'), // Thruline blue, lit
    rgb('#c4ecff'), // hot white-cyan
  ],
}
