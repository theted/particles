// Mean position of a strided sample of 16384 particles, for the camera's follow mode.
// Each workgroup sums 256 samples; the CPU adds up the 64 partial sums.

@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> partial: array<vec4f, 64>;
@group(0) @binding(2) var<uniform> info: vec4u; // count, stride

var<workgroup> acc: array<vec4f, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let idx = min((wg.x * 256u + li) * info.y, info.x - 1u);
  acc[li] = vec4f(clamp(pos[idx].xyz, vec3f(-1e4), vec3f(1e4)), 1.0);
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { acc[li] += acc[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) { partial[wg.x] = acc[0]; }
}
