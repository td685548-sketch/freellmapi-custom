import { prelude, rgb, type Effect } from './effect'

/**
 * Thruline → FreeLLMAPI: a singularity, in FreeLLMAPI's own black and white.
 * It is the galaxy's opposite: that one blooms out of the button, this one
 * collapses onto it.
 *
 *   0.00 – 0.48  a ring of swirling marbled ink closes in on the switch button,
 *                eating the page from the edges inward
 *   0.40 – 0.56  one bright dot is left where the button is (the FreeLLMAPI mark)
 *   0.52 – 1.00  the dot detonates: a shock ring runs outward and uncovers the
 *                new page, trailing thin ripples of light behind it
 */
const shader = /* wgsl */ `
// Domain-warped noise read as marble veins, 0..1.
fn marble(p: vec2f, tt: f32) -> f32 {
  var q = p;
  q = q + 0.9 * vec2f(fbm(q * 1.3 + vec2f(0.0, tt)), fbm(q * 1.3 + vec2f(5.2, 1.3 - tt)));
  q = q + 0.7 * vec2f(fbm(q * 2.1 + vec2f(1.7, 9.2)), fbm(q * 2.1 + vec2f(8.3, 2.8)));
  let n = fbm(q * 1.7);
  return 0.5 + 0.5 * sin(q.x * 3.5 + n * 7.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let t = u.t;
  let o = frag.xy - u.origin;
  let d = o / u.reach;
  let r = length(d);
  let ang = atan2(d.y, d.x);

  // ---- closing in, then opening out ----
  let xa = clamp(t / 0.48, 0.0, 1.0);
  let closing = 1.35 * pow(1.0 - xa, 1.7) - 0.25 * xa;
  let xb = clamp((t - 0.52) / 0.48, 0.0, 1.0);
  let opening = 1.45 * (1.0 - pow(1.0 - xb, 2.3));

  // The boundary is not a clean circle: it throws spiral tendrils.
  // The roughness shrinks with the circle, so the last thing left is a clean dot.
  let early = 1.0 - step(0.5, t);
  let amp = mix(clamp(opening * 0.35, 0.0, 1.0), clamp(closing * 0.6, 0.0, 1.0), early);
  let rough = (fbm(d * 3.0 + vec2f(t * 1.2, -t)) - 0.5) * 0.12 * amp;
  let tendril = 0.05 * sin(ang * 5.0 + r * 14.0 - t * 18.0) * amp;
  let reff = r + rough + tendril;

  let inkIn = max(smoothstep(closing, closing + 0.14, reff), smoothstep(0.40, 0.48, t));
  let holeOut = 1.0 - smoothstep(opening - 0.16, opening, reff);
  let cover = mix(1.0 - holeOut, inkIn, early);

  // ---- the ink: marbled, and swirling faster the closer it is to the centre ----
  let a0 = ang + (1.2 + 5.0 * t) / (r + 0.25);
  let p = vec2f(cos(a0), sin(a0)) * r * 2.4 + vec2f(0.0, t * 0.6);
  let m = marble(p, t * 0.8);
  var col = mix(u.c0.rgb, u.c1.rgb, smoothstep(0.15, 0.85, m));
  col = mix(col, u.c2.rgb, pow(m, 6.0) * 0.8);

  // ---- bright ring on the closing edge, then on the opening edge ----
  let ringIn = (exp(-pow((reff - closing - 0.06) / 0.02, 2.0)) + 0.18 * exp(-pow((reff - closing - 0.05) / 0.12, 2.0))) * early;
  let ringOut = (exp(-pow((reff - opening + 0.08) / 0.02, 2.0)) + 0.18 * exp(-pow((reff - opening + 0.08) / 0.12, 2.0))) * (1.0 - early) * smoothstep(0.0, 0.05, xb);
  var ripples = 0.0;
  for (var k = 1; k < 4; k = k + 1) {
    let kk = f32(k);
    ripples = ripples + exp(-pow((r - (opening - 0.16 * kk)) / 0.011, 2.0)) * (0.5 / kk);
  }
  ripples = ripples * (1.0 - early) * smoothstep(0.0, 0.06, xb) * (1.0 - smoothstep(0.55, 1.0, xb)) * step(0.0, opening - 0.16);

  // ---- the dot ----
  let radiusPx = 5.0 * u.scale;
  let rp = length(o);
  let dotCore = 1.0 - smoothstep(radiusPx * 0.8, radiusPx, rp);
  let dotHalo = exp(-rp / (radiusPx * 6.0)) * 0.55;
  let dotAmount = smoothstep(0.40, 0.47, t) * (1.0 - smoothstep(0.52, 0.60, t));

  var alpha = cover;
  let lit = max(ringIn, ringOut) * 1.1 + dotCore * dotAmount + dotHalo * dotAmount;
  col = mix(col, u.c3.rgb, clamp(lit, 0.0, 1.0));
  alpha = max(alpha, clamp(max(max(ringIn, ringOut), max(dotCore, dotHalo) * dotAmount), 0.0, 1.0));
  // Ripples are light lying on top of the new page, composited over the cover.
  let rippleAlpha = clamp(ripples, 0.0, 1.0) * 0.55 * (1.0 - alpha);
  return vec4f(col * alpha + u.c3.rgb * rippleAlpha, alpha + rippleAlpha);
}
`

export const inkEffect: Effect = {
  id: 'ink',
  duration: 2400,
  coveredAt: 0.5,
  wgsl: prelude + shader,
  palette: dark => dark
    ? [rgb('#08090c'), rgb('#1b1e25'), rgb('#b4bccb'), rgb('#f4f7fb')]
    : [rgb('#f3f5f8'), rgb('#cdd3dc'), rgb('#2b3038'), rgb('#12151b')],
}
