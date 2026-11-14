import { prelude, rgb, type Effect } from './effect'

/**
 * FreeLLMAPI → Thruline: a dive through a galaxy and a jump to light speed.
 *
 *   0.00 – 0.30  a spiral galaxy of 70,000 stars blooms out of the switch and
 *                swallows the page, nebula clouds glowing between the arms
 *   0.15 – 0.50  the camera dives into it: the arms rush outward and the stars
 *                stretch into hyperspace streaks; a ringed gas giant, an
 *                Earth-like world and a cratered moon sweep past, lit from the core
 *   0.48 – 0.56  the jump: a flash with an anamorphic flare; the route changes
 *                at its peak, hidden inside it
 *   0.52 – 0.64  a wormhole of contracting rings, and a lit line with a node
 *                (the Thruline mark) runs across the middle of the screen
 *   0.60 – 1.00  the line splits like a slit and opens onto the new page behind a
 *                rim of split-colour light, stardust streaming past
 *
 * Stars are instanced sprites whose positions are a pure function of (id, t), so
 * there is no simulation state; the background is one full-screen fragment pass.
 */
const STARS = 70000
const WARP = 1500

const shader = /* wgsl */ `
const NG: u32 = ${STARS}u;
const NW: u32 = ${WARP}u;
const GOLD = vec3f(1.0, 0.82, 0.55);
const MAGENTA = vec3f(0.75, 0.22, 0.70);

fn spinOf(t: f32) -> f32 { return 5.0 * t + 5.0 * t * t; }
fn growOf(t: f32) -> f32 { return 1.0 - pow(1.0 - clamp(t / 0.46, 0.0, 1.0), 2.4); }
// Where the camera is aiming the warp: the button first, then the middle of the screen.
fn warpCentre(t: f32) -> vec2f { return mix(u.origin, u.res * 0.5, smoothstep(0.30, 0.55, t)); }
// The dive: everything is pulled outward from the galaxy's heart.
fn zoomOf(t: f32) -> f32 { return 1.0 + 5.0 * smoothstep(0.26, 0.52, t); }

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

// Gas clouds between the arms: violet, magenta and cyan, drifting.
fn nebula(d: vec2f, t: f32) -> vec3f {
  let n1 = fbm(d * 2.2 + vec2f(3.0, t * 0.5));
  let n2 = fbm(d * 4.6 - vec2f(t * 0.4, 7.0));
  var col = mix(u.c1.rgb, MAGENTA, smoothstep(0.35, 0.85, n1)) * smoothstep(0.30, 0.80, n2) * 0.75;
  col = col + u.c3.rgb * smoothstep(0.62, 0.95, n1 * n2 * 1.7) * 0.28;
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

// A star of the galaxy at time tt, in canvas pixels.
fn galaxyStar(i: u32, tt: f32) -> vec2f {
  let g = pow(rnd(i, 0u), 1.6);
  let arm = floor(rnd(i, 1u) * 2.0);
  let scatter = (rnd(i, 2u) - 0.5) * (0.55 * (1.0 - g * 0.5) + 0.06);
  let ang = arm * 3.14159265 - 2.9 * log(g + 0.07) + spinOf(tt) + scatter;
  let R = max(growOf(tt), 0.0) * 1.32 + 0.05;
  let local = vec2f(cos(ang), sin(ang)) * (R * g * u.reach);
  let p = u.origin + local;
  let c = warpCentre(tt);
  return c + (p - c) * zoomOf(tt);
}

// ---------------- planets ----------------
// Lit from the upper right, where the galaxy core is.
const SUN = vec3f(0.5, 0.42, 0.75);

fn over(base: vec4f, top: vec4f) -> vec4f { return top + base * (1.0 - top.a); }

struct Surface {
  color: vec3f,
  shine: f32,
  haze: vec3f,
  hazeAmount: f32,
};

// kind 0: banded gas giant, 1: Earth-like world with clouds, 2: cratered moon.
fn surface(kind: i32, lon: f32, lat: f32, seed: f32, t: f32) -> Surface {
  var s: Surface;
  if (kind == 0) {
    let swirl = fbm(vec2f(lon * 2.5 + seed, lat * 5.0)) - 0.5;
    let band = fbm(vec2f(lon * 0.6 + seed * 3.0, (lat + swirl * 0.35) * 10.0));
    var c = mix(vec3f(0.93, 0.78, 0.55), vec3f(0.56, 0.32, 0.18), smoothstep(0.3, 0.7, band));
    c = c + vec3f(0.12, 0.09, 0.05) * smoothstep(0.55, 0.85, fbm(vec2f(lon * 3.0, lat * 14.0 + seed)));
    s.color = c * (1.0 - 0.4 * pow(abs(lat) / 1.5708, 2.0));
    s.shine = 0.0;
    s.haze = vec3f(0.95, 0.68, 0.42);
    s.hazeAmount = 0.5;
  } else if (kind == 1) {
    let h = fbm(vec2f(lon * 1.6, lat * 2.0) + seed * 7.0);
    let ocean = mix(vec3f(0.015, 0.07, 0.26), vec3f(0.05, 0.26, 0.5), smoothstep(0.38, 0.54, h));
    var land = mix(vec3f(0.11, 0.30, 0.09), vec3f(0.42, 0.33, 0.2), smoothstep(0.56, 0.78, h));
    land = mix(land, vec3f(0.95, 0.97, 1.0), smoothstep(0.80, 0.9, h));
    var c = mix(ocean, land, smoothstep(0.52, 0.56, h));
    let ice = smoothstep(1.05, 1.25, abs(lat));
    c = mix(c, vec3f(0.95, 0.97, 1.0), ice);
    let cloud = smoothstep(0.52, 0.8, fbm(vec2f(lon * 2.2 + t * 0.6, lat * 3.5) + seed));
    c = mix(c, vec3f(1.0), cloud * 0.85);
    s.color = c;
    s.shine = (1.0 - smoothstep(0.52, 0.56, h)) * (1.0 - cloud) * (1.0 - ice);
    s.haze = vec3f(0.32, 0.55, 1.0);
    s.hazeAmount = 1.0;
  } else {
    let m = fbm(vec2f(lon, lat) * 3.5 + seed);
    let ridge = abs(fbm(vec2f(lon, lat) * 9.0 + seed * 2.0) - 0.5) * 2.0;
    s.color = mix(vec3f(0.30, 0.29, 0.28), vec3f(0.64, 0.62, 0.58), m) * (0.72 + 0.4 * smoothstep(0.0, 0.25, ridge));
    s.shine = 0.0;
    s.haze = vec3f(0.5, 0.5, 0.55);
    s.hazeAmount = 0.12;
  }
  return s;
}

// One planet in its own unit space (radius 1 at the centre), premultiplied.
fn drawPlanet(p: vec2f, kind: i32, seed: f32, spin: f32, aa: f32, ringed: bool, roll: f32, t: f32) -> vec4f {
  let L = normalize(SUN);
  var ringBack = vec4f(0.0);
  var ringFront = vec4f(0.0);
  if (ringed) {
    let cr = cos(roll);
    let sr = sin(roll);
    let q = vec2f(p.x * cr + p.y * sr, -p.x * sr + p.y * cr);
    let rho = length(vec2f(q.x, q.y / 0.27));
    let span = smoothstep(1.32, 1.38, rho) * (1.0 - smoothstep(2.28, 2.36, rho));
    let band = 0.5 + 0.5 * fbm(vec2f(rho * 18.0, 3.0));
    let division = 1.0 - 0.9 * (1.0 - smoothstep(0.0, 0.035, abs(rho - 1.93)));
    let a = span * (0.18 + 0.72 * band) * division;
    let tone = mix(vec3f(0.62, 0.52, 0.4), vec3f(0.95, 0.86, 0.7), band);
    // The sunlit side of the rings is brighter; they fade out in the planet's shadow.
    let sunny = 0.45 + 0.55 * smoothstep(-0.8, 0.9, dot(normalize(vec2f(q.x, -q.y) + vec2f(0.001)), L.xy / max(length(L.xy), 0.001)));
    let lit = vec4f(tone * sunny * a, a);
    if (q.y > 0.0) { ringFront = lit; } else { ringBack = lit; }
  }

  let r2 = dot(p, p);
  let r = sqrt(r2);
  var body = vec4f(0.0);
  if (r < 1.0 + aa) {
    let z = sqrt(max(1.0 - r2, 0.0));
    let n = vec3f(p.x, -p.y, z);
    let cs = cos(spin);
    let sn = sin(spin);
    let nr = vec3f(n.x * cs + n.z * sn, n.y, -n.x * sn + n.z * cs);
    let surf = surface(kind, atan2(nr.x, nr.z), asin(clamp(nr.y, -1.0, 1.0)), seed, t);
    let lambert = dot(n, L);
    let lit = smoothstep(-0.14, 0.5, lambert);
    var c = surf.color * (0.02 + 1.05 * lit);
    let H = normalize(L + vec3f(0.0, 0.0, 1.0));
    c = c + vec3f(1.0, 0.95, 0.85) * pow(max(dot(n, H), 0.0), 70.0) * 0.9 * surf.shine * lit;
    // Atmosphere: bright thin limb, strongest on the lit side, a faint glow on the night side.
    let limb = pow(1.0 - z, 3.0);
    c = c + surf.haze * limb * (0.08 + 1.1 * lit) * surf.hazeAmount;
    let edge = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    body = vec4f(c * edge, edge);
  }
  // Light scattered just above the limb.
  let up = vec2f(p.x, -p.y) / max(r, 0.001);
  let side = smoothstep(-0.4, 0.8, dot(up, normalize(L.xy)));
  let halo = exp(-(r - 1.0) * 22.0) * step(1.0, r) * side;
  let hazeTone = select(vec3f(0.5, 0.5, 0.55), select(vec3f(0.32, 0.55, 1.0), vec3f(0.95, 0.68, 0.42), kind == 0), kind != 2);
  let hazeAmount = select(0.0, 0.5, kind != 2);
  let glow = vec4f(hazeTone * halo * hazeAmount, halo * hazeAmount * 0.6);
  var out = over(vec4f(0.0), ringBack);
  out = over(out, glow);
  out = over(out, body);
  out = over(out, ringFront);
  return out;
}

// Three worlds that sweep past on the way in, each from its own side.
fn planets(frag: vec2f, t: f32) -> vec4f {
  let mn = min(u.res.x, u.res.y);
  let c = u.res * 0.5;
  let s = pow(clamp((t - 0.14) / 0.38, 0.0, 1.0), 1.5);
  let appear = smoothstep(0.15, 0.24, t) * (1.0 - smoothstep(0.44, 0.50, t));
  var acc = vec4f(0.0);
  {
    let k = mix(0.12, 0.95, s);
    let centre = c + vec2f(-0.85, 0.12) * mn * k;
    let radius = 0.55 * mn * k;
    let p = (frag - centre) / radius;
    if (dot(p, p) < 9.0) { acc = over(acc, drawPlanet(p, 0, 1.3, 0.4 + t * 0.7, 1.5 / radius, true, -0.38, t)); }
  }
  {
    let k = mix(0.16, 1.25, s);
    let centre = c + vec2f(0.62, -0.40) * mn * k;
    let radius = 0.34 * mn * k;
    let p = (frag - centre) / radius;
    if (dot(p, p) < 2.0) { acc = over(acc, drawPlanet(p, 1, 2.1, 0.5 + t * 0.9, 1.5 / radius, false, 0.0, t)); }
  }
  {
    let k = mix(0.20, 1.6, s);
    let centre = c + vec2f(0.18, 0.62) * mn * k;
    let radius = 0.15 * mn * k;
    let p = (frag - centre) / radius;
    if (dot(p, p) < 2.0) { acc = over(acc, drawPlanet(p, 2, 3.7, 0.3 + t * 0.5, 1.5 / radius, false, 0.0, t)); }
  }
  return acc * appear;
}

@vertex
fn vsStar(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> StarOut {
  let t = u.t;
  if (ii < NG) {
    let g = pow(rnd(ii, 0u), 1.6);
    var head = galaxyStar(ii, t);
    var tail = galaxyStar(ii, max(t - 0.006, 0.0));
    let seed = smoothstep(0.0, 0.05, t);
    let alive = seed * (1.0 - smoothstep(0.40, 0.50, t));
    // Magnitudes are heavy-tailed: a sea of faint stars and a few bright ones.
    let mag = pow(rnd(ii, 7u), 9.0);
    let big = step(0.9988, rnd(ii, 9u));
    // Colour follows temperature: yellow and red toward the core, blue-white out in the arms.
    let temp = clamp(mix(0.22, 0.78, smoothstep(0.0, 0.7, g)) + (rnd(ii, 5u) - 0.5) * 0.55, 0.0, 1.0);
    let twinkle = 0.78 + 0.22 * sin(t * 22.0 + rnd(ii, 4u) * 40.0);
    var width = (0.55 + 1.1 * mag) * u.scale;
    var bright = (0.08 + 1.5 * mag) * (1.0 - 0.45 * g) * twinkle * alive * 0.5;
    var flare = 0.0;
    if (big > 0.5) {
      // A bright star holds still enough to show its diffraction spikes, each turned its own way.
      let turn = rnd(ii, 8u) * 6.2831853;
      tail = head - vec2f(cos(turn), sin(turn)) * 0.01;
      width = (1.4 + 1.2 * rnd(ii, 6u)) * u.scale;
      bright = (2.2 + 2.0 * rnd(ii, 3u)) * twinkle * alive * 0.5;
      flare = 0.35 + 0.65 * rnd(ii, 2u);
    }
    return streak(vi, tail, head, width, starTint(temp), bright, flare);
  }

  // Hyperspace streaks: a fixed angle each, racing outward as they get closer.
  let j = ii - NG;
  let ang = rnd(j, 10u) * 6.2831853;
  let dir = vec2f(cos(ang), sin(ang));
  let c = warpCentre(t);
  let far = 0.5 * length(u.res) * 1.25;
  let speed = smoothstep(0.26, 0.50, t) * (1.0 - smoothstep(0.60, 0.74, t));
  let travel = 1.5 * t + 9.0 * t * t * t;
  let z = fract(rnd(j, 11u) + travel * (0.5 + 0.7 * rnd(j, 12u)));
  let zt = max(z - speed * (0.03 + 0.22 * z), 0.0);
  let head = c + dir * (pow(z, 2.2) * far);
  let tail = c + dir * (pow(zt, 2.2) * far);
  let born = smoothstep(0.0, 0.10, z);
  let hue = mix(vec3f(0.55, 0.72, 1.0), vec3f(0.85, 0.80, 1.0), rnd(j, 13u));
  let width = (0.45 + 0.9 * z) * (0.7 + 0.6 * rnd(j, 14u)) * u.scale;
  return streak(vi, tail, head, width, hue, speed * born * (0.2 + 0.8 * z) * 0.5, 0.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let t = u.t;
  let o = frag.xy - u.origin;
  let d = o / u.reach;
  let r = length(d);
  let mn = min(u.res.x, u.res.y);

  // ---- the galaxy swallows the page ----
  let R = max(growOf(t) * 1.32, 0.05);
  let spin = spinOf(t);
  let turb = (fbm(d * 3.0 + vec2f(t * 2.0, -t * 1.3)) - 0.5) * 0.22;
  let seed = smoothstep(0.0, 0.05, t);
  let disc = (1.0 - smoothstep(R - 0.18, R, r + turb)) * seed;

  // The dive: sample the arms and clouds from further and further in.
  let dz = d / zoomOf(t);
  let space = mix(u.c0.rgb, u.c1.rgb, fbm(dz * 1.5 + vec2f(4.0, 4.0)) * 0.8 * (1.0 - 0.9 * smoothstep(0.26, 0.46, t)));
  let gal = vec3f(1.0) - exp(-galaxy(dz, R, spin) * 1.1);
  let galaxyFade = 1.0 - 0.97 * smoothstep(0.26, 0.46, t);
  let cloudFade = 1.0 - 0.9 * smoothstep(0.30, 0.48, t);

  let still = starGrid(frag.xy - u.origin, 38.0 * u.scale, 1.0, t * 3.0)
            + starGrid(frag.xy - u.origin, 71.0 * u.scale, 5.0, t * 2.0) * 0.8;
  var col = space + gal * galaxyFade + nebula(dz, t) * cloudFade + vec3f(0.85, 0.92, 1.0) * still * 0.7 * (1.0 - smoothstep(0.30, 0.5, t));

  // Bright shock front on the leading edge of the bloom.
  let frontR = r + turb * 0.5 - R + 0.03;
  let front = (exp(-pow(frontR / 0.016, 2.0)) + 0.12 * exp(-pow(frontR / 0.10, 2.0))) * seed * (1.0 - smoothstep(0.30, 0.45, t));
  col = col + u.c3.rgb * front * 0.8;

  // ---- the jump to light speed: a flash with an anamorphic flare ----
  let dn = (frag.xy - u.res * 0.5) / (u.res * 0.5);
  let flash = exp(-pow((t - 0.515) / 0.024, 2.0));
  let centreDist = length((frag.xy - warpCentre(t)) / mn);
  col = col + vec3f(0.75, 0.88, 1.0) * flash * (0.3 + 2.4 * exp(-centreDist * 3.4));
  let flare = exp(-abs(dn.y * u.res.y * 0.5) / (9.0 * u.scale)) * exp(-abs(dn.x) * 1.1) * flash;
  col = col + vec3f(0.55, 0.75, 1.0) * flare * 3.0;

  // ---- the wormhole: rings rushing toward the middle ----
  let rc = max(length(dn * vec2f(u.res.x / mn, u.res.y / mn) * 0.5), 0.001);
  let tunnelOn = smoothstep(0.52, 0.56, t) * (1.0 - smoothstep(0.62, 0.72, t));
  let ringPhase = log(rc) * 7.0 + t * 38.0;
  let rings = pow(0.5 + 0.5 * sin(ringPhase), 6.0) * smoothstep(0.02, 0.25, rc) * tunnelOn;
  col = col + vec3f(0.35, 0.5, 1.0) * rings * 0.55 + vec3f(0.6, 0.25, 0.9) * pow(0.5 + 0.5 * sin(ringPhase * 0.5 + 1.7), 8.0) * tunnelOn * 0.25;

  // ---- the through-line, then the slit that opens onto the new page ----
  let sweepX = mix(-1.15, 1.15, smoothstep(0.52, 0.60, t));
  let lineOn = smoothstep(0.52, 0.55, t) * (1.0 - smoothstep(0.66, 0.76, t));
  let line = exp(-abs(dn.y * u.res.y * 0.5) / (3.0 * u.scale)) * step(dn.x, sweepX) * lineOn;
  let nodeAt = vec2f(u.res.x * 0.5 * 1.62, u.res.y * 0.5);
  let nodeDist = length(frag.xy - nodeAt) / (mn * 0.045);
  let node = (1.0 - smoothstep(0.55, 1.0, nodeDist)) * smoothstep(0.58, 0.61, t) * (1.0 - smoothstep(0.72, 0.82, t));
  let halo = exp(-nodeDist * 1.4) * 0.5 * smoothstep(0.58, 0.61, t) * (1.0 - smoothstep(0.72, 0.86, t));

  let hx = 1.75 * easeOut(clamp((t - 0.57) / 0.17, 0.0, 1.0));
  let hy = 0.010 + 1.95 * easeInOut(clamp((t - 0.66) / 0.34, 0.0, 1.0));
  let wobble = (fbm(dn * 4.0 + vec2f(t * 1.5, 3.0)) - 0.5) * 0.07;
  let e = length(vec2f(dn.x / max(hx, 0.001), dn.y / hy)) + wobble;
  let hole = 1.0 - smoothstep(0.86, 1.0, e);
  // The rim splits into colours, like light through a lens.
  let rimOn = smoothstep(0.57, 0.62, t) * (1.0 - smoothstep(0.92, 1.0, t));
  let rimR = exp(-pow((e - 0.955) / 0.05, 2.0));
  let rimG = exp(-pow((e - 0.94) / 0.05, 2.0));
  let rimB = exp(-pow((e - 0.925) / 0.05, 2.0));
  let rim = vec3f(rimR * 1.25, rimG * 1.1, rimB * 1.5) * rimOn;

  let light = u.c3.rgb * (line * 1.5 + halo) + vec3f(1.0) * (node * 1.4 + line * 0.4) + rim * vec3f(1.0, 0.85, 1.0);
  col = col + light;

  var alpha = disc * (1.0 - hole);
  // Light stays visible even where the page is already showing through.
  let lit = max(front, max(line, max(node, max(rim.r, max(rim.g, rim.b)))));
  alpha = max(alpha, clamp(lit, 0.0, 1.0));
  // Soft tone curve so the glow never clips into flat white.
  col = vec3f(1.0) - exp(-col * 1.25);
  // The worlds go on top of the sky (already tone-mapped, so they keep their own contrast).
  let world = planets(frag.xy, t) * disc;
  col = col * (1.0 - world.a) + world.rgb;
  alpha = max(alpha, world.a);
  return vec4f(col * alpha, alpha);
}
`

export const galaxyEffect: Effect = {
  id: 'galaxy',
  duration: 3400,
  coveredAt: 0.5,
  wgsl: prelude + shader,
  particles: STARS + WARP,
  palette: () => [
    rgb('#05060f'), // deep space
    rgb('#241a66'), // nebula violet
    rgb('#4d7cff'), // Thruline blue, lit
    rgb('#c4ecff'), // hot white-cyan
  ],
}
