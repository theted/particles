// One frame of simulation. Particles never read each other, so every invocation runs all
// substeps on its own particle in registers: one read and one write per particle per frame.
// Prepended with noise.wgsl.

struct Sim {
  cursor: vec4f,       // xyz position, w > 0 while the cursor force is on
  cursorAxis: vec4f,   // xyz swirl axis (camera forward)
  cursorForce: vec4f,  // radial strength (+ attracts), swirl strength
  attractor: vec4f,    // softening², falloff exponent (shared by cursor and pins)
  gravity: vec4f,      // xyz constant acceleration, w drag
  noise: vec4f,        // amplitude, frequency, time offset, home spring
  bounds: vec4f,       // mode, half size, restitution, max speed
  step: vec4f,         // dt per substep, substeps, particle count, pin count
  pins: array<vec4f, 32>, // pairs: (position xyz, -), (radial strength, swirl strength, -, -)
}

@group(0) @binding(0) var<uniform> S: Sim;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read> home: array<vec4f>;

// Pull toward c with magnitude 1/r^k (softened), plus a swirl around `axis` through c.
fn pull(p: vec3f, c: vec3f, axis: vec3f, radial: f32, swirl: f32) -> vec3f {
  let d = c - p;
  let inv = inverseSqrt(dot(d, d) + S.attractor.x);
  let s = inv * pow(inv, S.attractor.y);
  return (d * radial + cross(axis, d) * swirl) * s;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= u32(S.step.z)) { return; }

  let p0 = pos[i];
  var p = p0.xyz;
  var v = vel[i].xyz;
  // The sim is memory-bound: only read home positions when the spring needs them.
  var h = vec3f(0.0);
  if (S.noise.w != 0.0) { h = home[i].xyz; }

  let dt = S.step.x;
  let substeps = u32(S.step.y);
  let pinCount = u32(S.step.w);
  let damp = exp(-S.gravity.w * dt);
  let mode = u32(S.bounds.x);
  let L = S.bounds.y;
  let restitution = S.bounds.z;
  let maxSpeed = S.bounds.w;

  // The flow field barely changes within a frame: sample it once, not per substep.
  // 0.35 brings its typical magnitude to about 1, so the amplitude reads as an acceleration.
  var wind = vec3f(0.0);
  if (S.noise.x != 0.0) {
    wind = flow(p * S.noise.y + vec3f(0.0, 0.0, S.noise.z)) * (S.noise.x * 0.35);
  }

  for (var s = 0u; s < substeps; s++) {
    var a = S.gravity.xyz + wind;
    if (S.cursor.w > 0.0) {
      a += pull(p, S.cursor.xyz, S.cursorAxis.xyz, S.cursorForce.x, S.cursorForce.y);
    }
    for (var j = 0u; j < pinCount; j++) {
      let f = S.pins[2u * j + 1u];
      a += pull(p, S.pins[2u * j].xyz, vec3f(0.0, 1.0, 0.0), f.x, f.y);
    }
    if (S.noise.w != 0.0) {
      a += (h - p) * S.noise.w;
    }

    v = (v + a * dt) * damp;
    let speed = length(v);
    if (speed > maxSpeed) { v *= maxSpeed / speed; }
    p += v * dt;

    if (mode == 1u) {
      p = p - 2.0 * L * floor((p + L) / (2.0 * L));
    } else if (mode == 2u) {
      let outside = abs(p) > vec3f(L);
      if (any(outside)) {
        p = clamp(p, vec3f(-L), vec3f(L));
        v = select(v, -v * restitution, outside & (sign(v) == sign(p)));
      }
    } else if (mode == 3u) {
      let r = length(p);
      if (r > L) {
        let n = p / r;
        p = n * L;
        let vn = dot(v, n);
        if (vn > 0.0) { v -= (1.0 + restitution) * vn * n; }
      }
    }
  }

  pos[i] = vec4f(p, p0.w);
  vel[i] = vec4f(v, 0.0);
}
