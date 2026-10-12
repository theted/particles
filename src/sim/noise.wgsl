// 3D simplex noise gradient, ported from webgl-noise (Ian McEwan, Stefan Gustavson; MIT).
// Only the gradient is returned: the flow field below needs nothing else.

fn mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x: vec4f) -> vec4f { return mod289_4(((x * 34.0) + 10.0) * x); }
fn taylorInvSqrt4(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }

fn snoiseGrad(v: vec3f) -> vec3f {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);

  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);

  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);

  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;

  i = mod289_3(i);
  let p = permute4(permute4(permute4(
            i.z + vec4f(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4f(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4f(0.0, i1.x, i2.x, 1.0));

  let ns = 0.142857142857 * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);

  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;

  let norm = taylorInvSqrt4(vec4f(
    dot(vec3f(a0.xy, h.x), vec3f(a0.xy, h.x)),
    dot(vec3f(a0.zw, h.y), vec3f(a0.zw, h.y)),
    dot(vec3f(a1.xy, h.z), vec3f(a1.xy, h.z)),
    dot(vec3f(a1.zw, h.w), vec3f(a1.zw, h.w))));
  let p0 = vec3f(a0.xy, h.x) * norm.x;
  let p1 = vec3f(a0.zw, h.y) * norm.y;
  let p2 = vec3f(a1.xy, h.z) * norm.z;
  let p3 = vec3f(a1.zw, h.w) * norm.w;

  let m = max(0.5 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  let m2 = m * m;
  let m4 = m2 * m2;
  let pdotx = vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  let t = m2 * m * pdotx;
  var grad = -8.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return grad * 105.0;
}

// Divergence-free flow ("bitangent noise"): the cross product of two noise gradients.
// Two gradient evaluations instead of the three a classic curl-noise needs.
fn flow(p: vec3f) -> vec3f {
  return cross(snoiseGrad(p), snoiseGrad(p + vec3f(31.416, -47.853, 12.679)));
}
