import { prelude, rgb, type Effect } from './effect'

/**
 * Thruline → FreeLLMAPI: a black hole, then a birth of light. The galaxy is cold
 * and blue and flies you through the sky; this one is warm, dark, and swallows.
 *
 *   0.00 – 0.46  the switch becomes a black hole. Its event horizon is a hard black
 *                disc, ringed by a white-gold photon ring, with a tilted accretion
 *                disk of plasma: hotter inward, brighter on the side turning toward
 *                you, and bent over the top and bottom of the hole by its gravity
 *                (the Interstellar look). The page dims to a night sky whose stars are
 *                gravitationally lensed: they pile into an Einstein ring and are
 *                pushed outward as the hole grows. The horizon swallows the screen.
 *   0.46 – 0.56  all black, then one point of white light, then a flash with a
 *                cross-shaped flare; the route changes inside it
 *   0.52 – 1.00  a shell of burning gas (white, gold, red, violet) and a thin blue
 *                shock front run outward and uncover the new page; the plasma, thrown
 *                back out, streaks away
 *
 * Stars and plasma are instanced sprites positioned from (id, t) alone.
 */
const SKY = 9000
const PLASMA = 36000

const shader = /* wgsl */ `
const NK: u32 = ${SKY}u;
const NP: u32 = ${PLASMA}u;
const ROLL = -0.32;   // how the disk is turned on screen
const TILT = 0.21;    // how open it is: small = seen nearly edge-on

// Fire: dark red → orange → gold → white-hot. x is 0..1.
fn fire(x: f32) -> vec3f {
  let k = clamp(x, 0.0, 1.0);
  let a = mix(vec3f(0.10, 0.01, 0.03), vec3f(0.85, 0.20, 0.06), smoothstep(0.0, 0.35, k));
  let b = mix(a, vec3f(1.0, 0.62, 0.18), smoothstep(0.3, 0.65, k));
  return mix(b, vec3f(1.0, 0.96, 0.85), smoothstep(0.6, 1.0, k));
}

// The horizon radius in canvas pixels: tiny at first, then it takes the whole screen.
fn horizonPx(t: f32) -> f32 {
  let x = clamp(t / 0.46, 0.0, 1.0);
  return (0.03 + 1.38 * pow(x, 3.4)) * u.reach;
}
fn nightOf(t: f32) -> f32 { return smoothstep(0.02, 0.34, t); }
fn openingOf(t: f32) -> f32 {
  let xb = clamp((t - 0.52) / 0.48, 0.0, 1.0);
  return 1.45 * (1.0 - pow(1.0 - xb, 2.3));
}

// Gravitational lensing of a point source: images are pushed out of the shadow.
fn lens(p: vec2f, t: f32) -> vec2f {
  let k = horizonPx(t);
  let d = p - u.origin;
  let r = max(length(d), 1.0);
  return u.origin + d / r * (0.5 * (r + sqrt(r * r + 4.0 * k * k)));
}

fn diskFrame(x: vec2f) -> vec2f {
  return vec2f(x.x * cos(ROLL) + x.y * sin(ROLL), -x.x * sin(ROLL) + x.y * cos(ROLL));
}
fn diskToScreen(X: f32, Y: f32, rh: f32) -> vec2f {
  return u.origin + vec2f(X * cos(ROLL) - Y * sin(ROLL), X * sin(ROLL) + Y * cos(ROLL)) * rh;
}

// Where an ejected spark is once the hole lets go.
fn ejected(i: u32, tt: f32) -> vec3f {
  let xb = clamp((tt - 0.5) / 0.5, 0.0, 1.0);
  let th = rnd(i, 4u) * 6.2831853;
  let v = u.reach * (0.3 + 1.5 * pow(rnd(i, 5u), 1.4));
  let r = v * (1.0 - pow(1.0 - xb, 2.6));
  return vec3f(u.origin + vec2f(cos(th), sin(th)) * r, 1.0 - xb);
}

// A plasma spark of the accretion disk at time tt: its place on the screen, and how
// hot it is (z). Inside the disk plane, spiralling in; hidden while behind the hole.
fn plasma(i: u32, tt: f32) -> vec4f {
  let rh = horizonPx(tt);
  let sA = pow(clamp(tt / 0.5, 0.0, 1.0), 1.3);
  let rho0 = 1.6 + 4.2 * pow(rnd(i, 0u), 0.8);
  let rho = rho0 * (1.0 - 0.78 * sA);
  let psi = rnd(i, 1u) * 6.2831853 + (9.0 / pow(rho, 1.5)) * tt * 1.1;
  let X = rho * cos(psi);
  let Y = TILT * rho * sin(psi);
  let p = diskToScreen(X, Y, rh);
  let behind = step(Y, 0.0) * (1.0 - step(1.0, length(vec2f(X, Y))));
  let doppler = mix(0.3, 1.55, 0.5 - 0.5 * X / rho);
  return vec4f(p, clamp(1.7 / rho, 0.0, 1.0), (1.0 - behind) * doppler);
}

@vertex
fn vsStar(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> StarOut {
  let t = u.t;
  if (ii < NK) {
    // The night sky, seen through the hole's gravity.
    let p0 = vec2f(rnd(ii, 0u) * u.res.x, rnd(ii, 1u) * u.res.y);
    var head = lens(p0, t);
    var tail = lens(p0, max(t - 0.006, 0.0));
    let mag = pow(rnd(ii, 7u), 9.0);
    let big = step(0.9965, rnd(ii, 9u));
    let temp = clamp(0.2 + 0.6 * rnd(ii, 5u) + (rnd(ii, 6u) - 0.5) * 0.3, 0.0, 1.0);
    let twinkle = 0.78 + 0.22 * sin(t * 18.0 + rnd(ii, 4u) * 40.0);
    let alive = nightOf(t) * (1.0 - smoothstep(0.40, 0.47, t));
    var width = (0.55 + 1.1 * mag) * u.scale;
    var bright = (0.15 + 1.6 * mag) * twinkle * alive * 0.55;
    var flare = 0.0;
    if (big > 0.5) {
      let turn = rnd(ii, 8u) * 6.2831853;
      tail = head - vec2f(cos(turn), sin(turn)) * 0.01;
      width = (1.4 + 1.2 * rnd(ii, 3u)) * u.scale;
      bright = (2.0 + 2.0 * rnd(ii, 2u)) * twinkle * alive * 0.55;
      flare = 0.35 + 0.65 * rnd(ii, 10u);
    }
    return streak(vi, tail, head, width, starTint(temp), bright, flare);
  }

  let j = ii - NK;
  var head: vec2f;
  var tail: vec2f;
  var heat: f32;
  var gain: f32;
  var tint: vec3f;
  if (t < 0.5) {
    let h = plasma(j, t);
    let g = plasma(j, max(t - 0.012, 0.0));
    head = h.xy;
    tail = g.xy;
    heat = h.z;
    tint = mix(fire(0.15 + 0.6 * heat), vec3f(0.7, 0.85, 1.0), smoothstep(1.2, 1.6, h.w) * 0.55);
    gain = h.w * smoothstep(0.03, 0.25, t) * (1.0 - smoothstep(0.42, 0.48, t)) * 0.05;
  } else {
    let h = ejected(j, t);
    let g = ejected(j, max(t - 0.012, 0.0));
    head = h.xy;
    tail = g.xy;
    heat = h.z;
    tint = fire(0.25 + 0.75 * h.z * (0.4 + 0.6 * rnd(j, 7u)));
    gain = smoothstep(0.0, 0.25, h.z) * 0.2;
  }
  let width = (0.6 + 1.5 * pow(rnd(j, 8u), 4.0)) * u.scale;
  let flicker = 0.7 + 0.3 * sin(t * 30.0 + rnd(j, 6u) * 50.0);
  return streak(vi, tail, head, width, tint, gain * flicker, 0.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let t = u.t;
  let o = frag.xy - u.origin;
  let rr = length(o) / u.reach;
  let ang = atan2(o.y, o.x);
  let early = 1.0 - step(0.5, t);

  // ---- the black hole, in units of its own horizon radius ----
  let rh = horizonPx(t);
  let x = o / rh;
  let r = length(x);
  let aa = 1.5 / rh;
  let hole = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  let d = diskFrame(x);
  let rho = length(vec2f(d.x, d.y / TILT));
  let psi = atan2(d.y / TILT, d.x);

  // The disk: hotter inward, and brighter on the side turning toward us.
  let inDisk = smoothstep(1.45, 1.62, rho) * (1.0 - smoothstep(4.3, 5.0, rho));
  let emis = pow(1.5 / max(rho, 1.0), 1.7);
  let doppler = mix(0.3, 1.55, 0.5 - 0.5 * d.x / max(rho, 0.001));
  let swirl = psi - t * 9.0 / pow(max(rho, 1.0), 1.5);
  let streaks = 0.5 + 0.9 * fbm(vec2f(cos(swirl) * 2.0 + rho * 1.7, sin(swirl) * 2.0));
  var diskTint = fire(clamp(emis * 1.4, 0.0, 1.0));
  diskTint = mix(diskTint, diskTint * vec3f(0.8, 0.92, 1.3), smoothstep(1.0, 1.5, doppler));
  // The half behind the hole is hidden by it; the half in front crosses over it.
  let front = step(0.0, d.y);
  let seen = mix(step(1.0, r), 1.0, front);
  var light = diskTint * emis * doppler * doppler * streaks * inDisk * seen * 0.95;

  // The far side of the disk, bent over the top and bottom of the hole.
  let polar = smoothstep(0.12, 0.7, abs(d.y) / max(r, 0.001));
  let arc = exp(-pow((r - 1.17) / 0.15, 2.0)) * polar * mix(1.0, 0.55, front);
  light = light + fire(0.55) * arc * (0.7 + 0.5 * doppler) * 0.9;
  // The photon ring hugging the horizon, and a faint warm glow around it.
  light = light + vec3f(1.0, 0.93, 0.75) * exp(-pow((r - 1.025) / 0.022, 2.0)) * 1.5;
  light = light + vec3f(0.9, 0.45, 0.15) * exp(-(r - 1.0) * 2.6) * 0.14 * step(1.0, r);
  light = light * early * smoothstep(0.0, 0.04, t);

  // ---- what covers the page ----
  let veil = nightOf(t) * 0.94;
  let openingEdge = openingOf(t);
  let xb = clamp((t - 0.52) / 0.48, 0.0, 1.0);
  let amp = clamp(openingEdge * 0.35, 0.0, 1.0);
  let rough = (fbm(vec2f(o / u.reach) * 3.0 + vec2f(t * 1.2, -t)) - 0.5) * 0.12 * amp;
  let tendril = 0.05 * sin(ang * 5.0 + rr * 14.0 - t * 18.0) * amp;
  let reff = rr + rough + tendril;
  let holeOut = 1.0 - smoothstep(openingEdge - 0.16, openingEdge, reff);
  let coverEarly = max(veil, hole);
  var cover = mix(1.0 - holeOut, coverEarly, early);
  // A hint of plum gas in the dark once the hole has taken everything.
  var col = mix(u.c0.rgb, u.c1.rgb, 0.45 * fbm(o / u.reach * 2.4 + vec2f(t, 0.0))) * (1.0 - early);

  // ---- the shell of burning gas on the opening edge ----
  let rimD = reff - openingEdge;
  let filaments = fbm(vec2f(cos(ang), sin(ang)) * 2.5 + vec2f(rr * 3.0, -t * 2.5));
  let thick = 0.035 + 0.11 * (1.0 - xb);
  let shell = exp(-pow((rimD + thick * 0.7) / thick, 2.0)) * (0.5 + 1.0 * filaments) * (1.0 - early);
  let shock = exp(-pow((rimD - 0.015) / 0.016, 2.0)) * (1.0 - early) * smoothstep(0.0, 0.03, xb);
  let afterglow = exp(rimD * 5.0) * step(rimD, 0.0) * (1.0 - xb) * (1.0 - early);
  col = col + fire(0.2 + 0.8 * shell) * shell * 1.3 + vec3f(0.45, 0.65, 1.0) * shock * 1.6 + vec3f(0.55, 0.15, 0.7) * shell * 0.25;
  let glowVeil = clamp(afterglow * 0.35 + shell * 0.6, 0.0, 1.0);

  // ---- the birth of light: a point, a flash and a cross-shaped flare ----
  let rp = length(o);
  let px = u.scale;
  let point = exp(-rp / (7.0 * px)) * smoothstep(0.44, 0.50, t) * (1.0 - smoothstep(0.50, 0.53, t));
  let flash = exp(-pow((t - 0.52) / 0.028, 2.0));
  let blast = exp(-rp / (u.reach * 0.14)) * flash;
  let spike = (exp(-abs(o.y) / (5.0 * px)) * exp(-abs(o.x) / (u.reach * 0.22))
             + exp(-abs(o.x) / (5.0 * px)) * exp(-abs(o.y) / (u.reach * 0.22))) * flash;
  col = col + vec3f(1.0, 0.95, 0.85) * (point * 2.0 + blast * 1.1 + spike * 2.0) + fire(0.7) * blast * 0.6;

  col = col + light;
  let lumLight = max(light.r, max(light.g, light.b));
  var alpha = cover;
  let lit = max(max(shock, max(point, max(blast, spike))), lumLight);
  alpha = max(alpha, clamp(max(lit, glowVeil), 0.0, 1.0));
  col = vec3f(1.0) - exp(-col * 1.3);
  return vec4f(col * alpha, alpha);
}
`

export const blackholeEffect: Effect = {
  id: 'blackhole',
  duration: 3200,
  coveredAt: 0.5,
  wgsl: prelude + shader,
  particles: SKY + PLASMA,
  palette: () => [
    rgb('#020207'), // the dark
    rgb('#2c1141'), // plum gas
    rgb('#ffb347'), // amber
    rgb('#fff4dc'), // white-hot
  ],
}
