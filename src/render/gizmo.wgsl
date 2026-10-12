// Screen-space rings marking the 3D cursor and the pinned attractors, drawn over the
// tonemapped image.

struct Gizmo {
  viewProj: mat4x4f,
  viewport: vec4f,
  markers: array<vec4f, 18>, // xyz position, w radius px (negative: hollow ring)
  colors: array<vec4f, 18>,
}

@group(0) @binding(0) var<uniform> G: Gizmo;

struct GOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) filled: f32,
  @location(3) radius: f32,
}

@vertex
fn vs_gizmo(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let m = G.markers[ii];
  let radius = abs(m.w);
  let clip = G.viewProj * vec4f(m.xyz, 1.0);
  var o: GOut;
  if (clip.w < 1e-3) {
    o.clip = vec4f(0.0, 0.0, -1.0, 1.0);
    return o;
  }
  o.clip = vec4f(clip.xy + c * radius * 2.0 / G.viewport.xy * clip.w, 0.0, clip.w);
  o.uv = c;
  o.color = G.colors[ii];
  o.filled = select(1.0, 0.0, m.w < 0.0);
  o.radius = radius;
  return o;
}

@fragment
fn fs_gizmo(in: GOut) -> @location(0) vec4f {
  let d = length(in.uv);
  let px = 1.0 / in.radius; // one pixel in uv units
  let ring = 1.0 - smoothstep(0.75 * px, 1.75 * px, abs(d - (1.0 - 2.0 * px)));
  let center = (1.0 - smoothstep(0.22, 0.22 + 1.5 * px, d)) * in.filled;
  let a = max(ring, center) * in.color.a;
  return vec4f(in.color.rgb * a, a);
}
