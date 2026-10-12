// Full-screen passes: bloom (downsample and upsample chain) and the final tonemap.
// The tonemap pass also writes the faded copy of the HDR image that next frame's particles
// are drawn on top of. That copy is what makes trails.

struct Post {
  exposure: f32,
  decay: f32,     // trail decay per frame (0 clears)
  fadeEps: f32,   // subtracted per frame so faint trails reach zero in half precision
  bloomIntensity: f32,
  threshold: f32,
  knee: f32,
  radius: f32,
  bloomOn: f32,
}

@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct FsIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> FsIn {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FsIn;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

// 13-tap downsample (Jimenez, "Next Generation Post Processing in Call of Duty").
fn down13(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src, 0));
  let a = tap(uv + t * vec2f(-2.0, 2.0));
  let b = tap(uv + t * vec2f(0.0, 2.0));
  let c = tap(uv + t * vec2f(2.0, 2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0));
  let e = tap(uv);
  let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, -2.0));
  let h = tap(uv + t * vec2f(0.0, -2.0));
  let i = tap(uv + t * vec2f(2.0, -2.0));
  let j = tap(uv + t * vec2f(-1.0, 1.0));
  let k = tap(uv + t * vec2f(1.0, 1.0));
  let l = tap(uv + t * vec2f(-1.0, -1.0));
  let m = tap(uv + t * vec2f(1.0, -1.0));
  return e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}

@fragment
fn fs_down_first(in: FsIn) -> @location(0) vec4f {
  let c = down13(in.uv);
  let brightness = max(c.r, max(c.g, c.b));
  var soft = clamp(brightness - P.threshold + P.knee, 0.0, 2.0 * P.knee);
  soft = soft * soft / (4.0 * P.knee + 1e-5);
  let contribution = max(soft, brightness - P.threshold) / max(brightness, 1e-5);
  return vec4f(c * contribution, 1.0);
}

@fragment
fn fs_down(in: FsIn) -> @location(0) vec4f {
  return vec4f(down13(in.uv), 1.0);
}

// 3x3 tent upsample, blended additively onto the next larger mip.
@fragment
fn fs_up(in: FsIn) -> @location(0) vec4f {
  let d = P.radius / vec2f(textureDimensions(src, 0));
  var s = tap(in.uv) * 4.0;
  s += (tap(in.uv + vec2f(d.x, 0.0)) + tap(in.uv - vec2f(d.x, 0.0))
      + tap(in.uv + vec2f(0.0, d.y)) + tap(in.uv - vec2f(0.0, d.y))) * 2.0;
  s += tap(in.uv + d) + tap(in.uv - d) + tap(in.uv + vec2f(d.x, -d.y)) + tap(in.uv + vec2f(-d.x, d.y));
  return vec4f(s / 16.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn toSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

struct ToneOut {
  @location(0) color: vec4f,
  @location(1) trail: vec4f,
}

@fragment
fn fs_tonemap(in: FsIn) -> ToneOut {
  let hdr = textureLoad(src, vec2i(in.pos.xy), 0).rgb;
  var c = hdr;
  if (P.bloomOn > 0.5) {
    c += textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * P.bloomIntensity;
  }
  var o: ToneOut;
  o.color = vec4f(toSrgb(aces(c * P.exposure)), 1.0);
  o.trail = vec4f(max(hdr * P.decay - P.fadeEps, vec3f(0.0)), 1.0);
  return o;
}
