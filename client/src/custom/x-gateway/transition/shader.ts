/**
 * WGSL for the Thruline transition. A wall of thin 3D tiles fills the view and
 * draws the Thruline mark out of whole tiles:
 *   1. tiles swing in from behind, rippling outward from the click point,
 *   2. each tile flips over its X axis, showing its other face,
 *   3. the live line of the mark lights up tile by tile and reaches its node,
 *   4. tiles tumble toward the camera and past it, uncovering the new page.
 * Tile placement, timing and colour are computed per instance in the vertex
 * stage, so the only vertex data is one unit cube.
 */
export const shader = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  grid: vec4f,       // cols, rows, cell size, tile thickness
  anim: vec4f,       // origin.xy (world), progress 0..1, entering (1) or leaving (0)
  hostColor: vec4f,  // FreeLLMAPI face
  brandColor: vec4f, // Thruline face
  liveColor: vec4f,  // lit track and node
  backdrop: vec4f,
  wall: vec4f,       // wall width, wall height, camera distance, max ripple distance
};
@group(0) @binding(0) var<uniform> u: Uniforms;

const PI = 3.14159265;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn easeOut(x: f32) -> f32 { let k = 1.0 - x; return 1.0 - k * k * k; }
fn easeInOut(x: f32) -> f32 { return x * x * (3.0 - 2.0 * x); }
fn rotX(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
fn rotY(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }

struct TileOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) world: vec3f,
  @location(3) glow: f32,
};

@vertex
fn tileVertex(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32) -> TileOut {
  let cols = u32(u.grid.x);
  let cellIndex = vec2f(f32(instance % cols), f32(instance / cols));
  let cell = u.grid.z;
  let center = vec2f((cellIndex.x + 0.5) * cell - u.wall.x * 0.5, u.wall.y * 0.5 - (cellIndex.y + 0.5) * cell);
  let t = u.anim.z;
  let entering = u.anim.w;
  let r1 = hash(cellIndex);
  let r2 = hash(cellIndex + vec2f(7.3, 2.9));

  let fromClick = distance(center, u.anim.xy) / u.wall.w;
  let fromCenter = length(center) / (0.5 * length(u.wall.xy));
  let arrive = easeOut(clamp((t - fromClick * 0.21 - r1 * 0.02) / 0.16, 0.0, 1.0));
  let flip = easeInOut(clamp((t - 0.38 - fromCenter * 0.05) / 0.10, 0.0, 1.0));
  let leaveLinear = clamp((t - 0.71 - fromCenter * 0.13 - r1 * 0.03) / 0.13, 0.0, 1.0);
  let leave = leaveLinear * leaveLinear;

  // The mark, in a centred square with q in -1..1 (y up): two standby routes
  // bend in from the left and join the live line, which ends at its node.
  let q = center / (u.wall.y * 0.34);
  let halfTile = cell / (u.wall.y * 0.34) * 0.5;
  let onLive = step(abs(q.y - halfTile * 0.5), halfTile * 2.0) * step(-0.92, q.x) * step(q.x, 0.5);
  let node = step(distance(q, vec2f(0.74, halfTile * 0.5)), max(0.24, halfTile * 2.2));
  let feederY = clamp(0.1 - q.x, 0.0, 0.62);
  let onStandby = step(abs(abs(q.y - halfTile * 0.5) - feederY), halfTile * 1.15) * step(-0.92, q.x) * step(q.x, 0.1) * step(halfTile * 2.1, abs(q.y - halfTile * 0.5));

  // Traffic runs through: light travels along the live line, then the node lands.
  let sweep = mix(-1.0, 0.6, clamp((t - 0.50) / 0.15, 0.0, 1.0));
  let lit = max(step(q.x, sweep), 1.0 - entering);
  let nodeLit = max(step(0.655, t), 1.0 - entering);
  let liveAmount = max(onLive * lit, node * nodeLit);
  let pulse = node * nodeLit * (1.0 - smoothstep(0.655, 0.80, t)) * entering;

  let brandBase = u.brandColor.rgb * (0.84 + 0.3 * r2);
  let dim = mix(brandBase, u.liveColor.rgb, 0.3);
  var brandFace = mix(brandBase, dim, max(onStandby, max(onLive, node)));
  brandFace = mix(brandFace, u.liveColor.rgb, liveAmount);
  let hostFace = u.hostColor.rgb * (0.93 + 0.14 * r1);
  let front = mix(brandFace, hostFace, entering);
  let back = mix(hostFace, brandFace, entering);
  var color = mix(front, back, 0.5) * 0.6; // tile edges
  if (normal.z > 0.5) { color = front; }
  if (normal.z < -0.5) { color = back; }

  // Lit tiles stand proud of the wall, so the mark reads as raised.
  let raise = liveAmount * cell * 0.5 * flip * (1.0 - leave);
  let scale = arrive * (1.0 - leave * 0.55) * (1.0 + pulse * 0.25);
  let rotation = rotY((1.0 - arrive) * -2.2 + leave * (r2 - 0.5) * 5.0) * rotX(flip * PI + leave * (r1 - 0.5) * 5.0);
  let local = position * vec3f(cell * 0.94 * scale, cell * 0.94 * scale, u.grid.w * scale);
  let depth = -(1.0 - arrive) * cell * 6.0 + raise + leave * u.wall.z * 1.05;
  let world = rotation * local + vec3f(center * (1.0 + leave * 0.9), depth);

  var out: TileOut;
  out.position = u.viewProj * vec4f(world, 1.0);
  out.normal = rotation * normal;
  out.color = color;
  out.world = world;
  out.glow = pulse;
  return out;
}

@fragment
fn tileFragment(in: TileOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let light = normalize(vec3f(-0.35, 0.55, 0.8));
  let view = normalize(vec3f(0.0, 0.0, u.wall.z) - in.world);
  let diffuse = max(dot(n, light), 0.0);
  let specular = pow(max(dot(n, normalize(light + view)), 0.0), 48.0) * 0.22;
  let lit = in.color * (0.5 + 0.6 * diffuse) + vec3f(specular) + vec3f(in.glow * 0.25);
  return vec4f(lit, 1.0);
}

// Opaque veil behind the wall while the route swaps, so gaps between turning
// tiles never show a half-rendered page.
@vertex
fn veilVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.9999, 1.0);
}

@fragment
fn veilFragment() -> @location(0) vec4f {
  let t = u.anim.z;
  let alpha = smoothstep(0.24, 0.34, t) * (1.0 - smoothstep(0.73, 0.88, t));
  return vec4f(u.backdrop.rgb * alpha, alpha); // premultiplied
}
`
