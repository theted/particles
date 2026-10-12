// Places every particle on a seed shape. The shape is also written to `home`, which the
// home spring pulls toward. With homeOnly set, only `home` changes: that is a morph.

struct Seed {
  shape: u32,
  count: u32,
  seed: u32,
  homeOnly: u32,
  size: f32,
  spin: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> P: Seed;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> home: array<vec4f>;

const TAU = 6.283185307;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

var<private> rng: u32;

fn rand() -> f32 {
  rng = pcg(rng);
  return f32(rng >> 8u) * (1.0 / 16777216.0);
}

fn gauss() -> f32 {
  let u = max(rand(), 1e-7);
  return sqrt(-2.0 * log(u)) * cos(TAU * rand());
}

fn randDir() -> vec3f {
  let z = rand() * 2.0 - 1.0;
  let a = rand() * TAU;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), z, r * sin(a));
}

fn galaxy(s: f32) -> vec3f {
  if (rand() < 0.15) {
    return vec3f(gauss(), gauss() * 0.6, gauss()) * s * 0.12;
  }
  let arms = 3.0;
  let t = pow(rand(), 1.3);
  let r = s * (0.06 + 0.94 * t);
  let arm = floor(rand() * arms);
  let a = arm * TAU / arms + t * 3.5 + gauss() * 0.45 / (1.0 + 3.0 * t);
  let y = gauss() * s * (0.015 + 0.05 * (1.0 - t));
  return vec3f(cos(a) * r, y, sin(a) * r) + vec3f(gauss(), 0.0, gauss()) * s * 0.02;
}

fn torus(s: f32) -> vec3f {
  let major = s * 0.7;
  let minor = s * 0.25 * sqrt(rand());
  let u = rand() * TAU;
  let v = rand() * TAU;
  let ring = major + minor * cos(v);
  return vec3f(ring * cos(u), minor * sin(v), ring * sin(u));
}

fn shapePoint(shape: u32, s: f32) -> vec3f {
  var p: vec3f;
  switch shape {
    case 0u: { p = randDir() * s * pow(rand(), 1.0 / 3.0); }
    case 1u: { p = randDir() * s * (1.0 + 0.004 * gauss()); }
    case 2u: { p = (vec3f(rand(), rand(), rand()) * 2.0 - 1.0) * s; }
    case 3u: { p = galaxy(s); }
    case 4u: { p = torus(s); }
    default: { p = vec3f(gauss(), gauss(), gauss()) * s * 0.5; }
  }
  return p;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= P.count) { return; }
  rng = pcg(i ^ pcg(P.seed));
  let p = shapePoint(P.shape, P.size);
  home[i] = vec4f(p, 0.0);
  if (P.homeOnly == 1u) { return; }

  // Spin: a constant tangential speed around the y axis. In a 1/r field that is a stable orbit.
  let tangent = cross(vec3f(0.0, 1.0, 0.0), p);
  let axial = length(tangent);
  let v = tangent / max(axial, 1e-6) * P.spin * smoothstep(0.0, 0.05 * P.size, axial);
  pos[i] = vec4f(p, rand());
  vel[i] = vec4f(v, 0.0);
}
