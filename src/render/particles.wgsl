// Draws particles additively into the HDR accumulation target, reading positions straight
// from the simulation's storage buffers (no vertex buffers).
// WebGPU points are always 1px, so sprites and streaks are instanced quads.

struct Render {
  proj: mat4x4f,
  view: mat4x4f,
  viewport: vec4f, // width px, height px, minimum sprite radius px
  style: vec4f,    // sprite radius (world), intensity, color mode, color range
  colorA: vec4f,
  colorB: vec4f,
  colorC: vec4f,
  cursor: vec4f,   // xyz cursor position
  eye: vec4f,      // xyz camera position, w distance to the orbit target
  streak: vec4f,   // length (seconds of motion), half width px
}

@group(0) @binding(0) var<uniform> R: Render;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) uv: vec2f,
}

fn ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0) * 2.0;
  if (x < 1.0) { return mix(R.colorA.rgb, R.colorB.rgb, x); }
  return mix(R.colorB.rgb, R.colorC.rgb, x - 1.0);
}

fn colorOf(p: vec4f, v: vec3f) -> vec3f {
  let range = R.style.w;
  var c: vec3f;
  switch u32(R.style.z) {
    case 0u: { c = ramp(length(v) / range); }
    case 1u: {
      let speed = length(v);
      c = select(vec3f(0.5), v / speed * 0.5 + 0.5, speed > 1e-5);
    }
    case 2u: { c = ramp(0.5 + (distance(p.xyz, R.eye.xyz) - R.eye.w) / range); }
    case 3u: { c = ramp(distance(p.xyz, R.cursor.xyz) / range); }
    default: { c = ramp(p.w); }
  }
  // p.w is a random tag per particle: a little brightness variation reads as texture.
  return c * (0.6 + 0.8 * p.w) * R.style.y;
}

@vertex
fn vs_points(@builtin(vertex_index) i: u32) -> VOut {
  let p = pos[i];
  var o: VOut;
  o.clip = R.proj * (R.view * vec4f(p.xyz, 1.0));
  o.color = colorOf(p, vel[i].xyz);
  o.uv = vec2f(0.0);
  return o;
}

@fragment
fn fs_points(in: VOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}

@vertex
fn vs_sprites(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let corner = corners[vi];
  let p = pos[ii];
  let vp = R.view * vec4f(p.xyz, 1.0);

  // Sprites smaller than a pixel shimmer. Grow them to the minimum and dim them so the
  // energy they add stays the same.
  let pxPerUnit = R.proj[1][1] * R.viewport.y * 0.5 / max(-vp.z, 1e-4);
  var radius = R.style.x;
  var gain = 1.0;
  let px = radius * pxPerUnit;
  if (px < R.viewport.z) {
    radius = R.viewport.z / pxPerUnit;
    gain = (px / R.viewport.z) * (px / R.viewport.z);
  }

  var o: VOut;
  o.clip = R.proj * (vp + vec4f(corner * radius, 0.0, 0.0));
  o.color = colorOf(p, vel[ii].xyz) * gain;
  o.uv = corner;
  return o;
}

@fragment
fn fs_sprites(in: VOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let f = 1.0 - r2;
  return vec4f(in.color * f * f, 1.0);
}

@vertex
fn vs_streaks(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  // x: 0 at the tail, 1 at the head; y: side of the streak.
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(0.0, 1.0), vec2f(1.0, -1.0),
    vec2f(1.0, -1.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let p = pos[ii];
  let v = vel[ii].xyz;
  let head = R.proj * (R.view * vec4f(p.xyz, 1.0));
  let tail = R.proj * (R.view * vec4f(p.xyz - v * R.streak.x, 1.0));

  var o: VOut;
  if (head.w < 1e-3 || tail.w < 1e-3) {
    o.clip = vec4f(0.0, 0.0, -1.0, 1.0); // behind the camera: outside the clip volume
    return o;
  }

  let half = R.viewport.xy * 0.5;
  let hs = head.xy / head.w * half;
  let ts = tail.xy / tail.w * half;
  let along = hs - ts;
  let len = length(along);
  let dir = select(vec2f(1.0, 0.0), along / len, len > 1e-3);
  let side = vec2f(-dir.y, dir.x);
  let w = R.streak.y;

  // Extend past both ends by the half width, so a slow particle is a round dot.
  let base = select(tail, head, c.x > 0.5);
  let offset = side * c.y * w + dir * (c.x * 2.0 - 1.0) * w;
  o.clip = vec4f(base.xy + offset / half * base.w, base.zw);
  // A streak spreads the particle's light over its length, as motion blur would.
  o.color = colorOf(p, v) * (2.0 * w / (len + 2.0 * w));
  o.uv = c;
  return o;
}

@fragment
fn fs_streaks(in: VOut) -> @location(0) vec4f {
  let across = 1.0 - in.uv.y * in.uv.y;
  let along = mix(0.2, 1.0, in.uv.x);
  return vec4f(in.color * across * along, 1.0);
}
