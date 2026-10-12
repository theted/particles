# The math behind Particles

Notes on the equations the shaders actually run, and why they look the way they do.
Symbols: $\mathbf p$ is a particle's position, $\mathbf v$ its velocity, $\mathbf a$ its acceleration
and $\Delta t$ the length of one substep. File references point at the code that implements each part.

- [Integration](#integration)
- [Attractors: the force law](#attractors-the-force-law)
- [Orbits and the galaxy presets](#orbits-and-the-galaxy-presets)
- [Swirl](#swirl)
- [Turbulence: divergence-free noise](#turbulence-divergence-free-noise)
- [Home spring and drag: a damped oscillator](#home-spring-and-drag-a-damped-oscillator)
- [Bounds](#bounds)
- [Seed shapes: sampling](#seed-shapes-sampling)
- [Camera and the 3D cursor](#camera-and-the-3d-cursor)
- [Drawing particles](#drawing-particles)
- [Trails](#trails)
- [Bloom and tonemapping](#bloom-and-tonemapping)
- [Why the simulation is memory-bound](#why-the-simulation-is-memory-bound)

## Integration

`src/sim/step.wgsl`

Each frame advances the simulation by $\min(\text{frame time}, 1/30\,\text{s}) \times \text{time scale}$,
split into $n$ substeps of length $\Delta t$. Every substep does a **semi-implicit (symplectic) Euler** step,
followed by exponential drag:

$$
\mathbf v \leftarrow (\mathbf v + \mathbf a\,\Delta t)\,e^{-c\,\Delta t},
\qquad
\mathbf p \leftarrow \mathbf p + \mathbf v\,\Delta t
$$

The position update uses the *new* velocity, and that one detail matters for orbits. Explicit Euler, which
updates the position with the old velocity, adds a little energy every step: orbits spiral outward and springs
ring louder over time. The semi-implicit variant is symplectic. It keeps a slightly perturbed energy bounded
forever, so a particle orbiting an attractor stays in orbit indefinitely.

The drag factor $e^{-c\Delta t}$ is the exact solution of $\dot{\mathbf v} = -c\,\mathbf v$ over one step. It
behaves the same at any frame rate, and it can never overshoot and reverse a particle the way
$\mathbf v(1 - c\Delta t)$ can when $c\Delta t > 1$.

Speed is clamped to $|\mathbf v| \le v_{max}$ after the update. That is a safety valve for the near-singular
centre of an attractor (see stability below), not physics.

Substeps loop inside the shader, in registers: each particle is read once and written once per frame, however
many substeps run. That is possible because particles never read each other's state.

## Attractors: the force law

`pull()` in `src/sim/step.wgsl`

The cursor and every pinned attractor apply the same softened power law. With $\mathbf d = \mathbf c - \mathbf p$
the vector from the particle to the attractor, $s$ the strength, $k$ the falloff exponent and $\varepsilon$ the
softening length:

$$
\mathbf a = s\,\frac{\mathbf d}{\left(|\mathbf d|^2 + \varepsilon^2\right)^{(k+1)/2}}
$$

Far from the attractor, $|\mathbf d| \gg \varepsilon$, the magnitude is $s/|\mathbf d|^k$:

| $k$ | Field | Feel |
|---|---|---|
| 0 | constant pull | everything falls in at the same rate, wherever it is |
| 1 | $1/r$, like an infinite line mass in 2D | the default: long reach, soft core |
| 2 | $1/r^2$, Newtonian gravity | a tight core and a weak reach |

Softening (Plummer softening in N-body codes) removes the singularity at $\mathbf d = 0$. Inside
$|\mathbf d| \lesssim \varepsilon$ the force grows linearly with distance, so the core is a harmonic well:

$$
\mathbf a \approx -\frac{s}{\varepsilon^{k+1}}\,(\mathbf p - \mathbf c)
\quad\Rightarrow\quad
\omega_{core}^2 = \frac{s}{\varepsilon^{k+1}}
$$

**Stability.** Symplectic Euler on a harmonic oscillator is stable only when $\omega\,\Delta t < 2$. A
particle falling through the core therefore stays well-behaved when

$$
\varepsilon > \left(\frac{s\,\Delta t^2}{4}\right)^{1/(k+1)}
$$

With the defaults ($s = 3$, $k = 1$, two substeps at 60 fps, so $\Delta t = 1/120$) this needs
$\varepsilon > 0.007$. The default softening of 0.1 is far inside the safe range. If you turn softening right
down and strength right up and particles explode out of the core, this inequality is why. More substeps
(a smaller $\Delta t$) or more softening fix it.

Tools set the signs: attract is $(+s, 0)$, repel $(-s, 0)$, swirl $(\text{pull}\cdot s,\ s)$ as (radial, swirl)
strengths. Holding Shift flips the radial sign for attract and repel, and the swirl direction for swirl.

## Orbits and the galaxy presets

For a circular orbit of radius $r$ the attractor has to supply the centripetal acceleration:

$$
\frac{v^2}{r} = \frac{s}{r^k}
\quad\Rightarrow\quad
v_{circ} = \sqrt{s\,r^{\,1-k}}
$$

At $k = 1$ the radius drops out: $v_{circ} = \sqrt{s}$ at every distance. That is a **flat rotation curve**,
the same shape astronomers measure for real spiral galaxies (where dark matter makes it flat).

So the seed shader's spin is a *constant tangential speed*, not a rigid rotation:

$$
\mathbf v_0 = \text{spin}\cdot\frac{\hat{\mathbf y}\times\mathbf p}{|\hat{\mathbf y}\times\mathbf p|}
$$

(faded to zero within $0.05R$ of the axis, where the direction is undefined). Set spin to $\sqrt{s}$ of a pin at
the origin and the whole disc orbits stably. The Galaxy preset uses $s = 1$, spin $= 1$. Black hole uses
$s = 1.5$, spin $= 1.2 \approx \sqrt{1.5}$, so the disc keeps its shape while it winds up. Softening lowers
the speed near the centre:
$v_{circ}^2 = s\,r^2 / (r^2 + \varepsilon^2)^{(k+1)/2}$. That is why the bulge orbits more slowly and smears
into streaks.

Because $v_{circ}$ doesn't depend on $r$, the angular speed $v/r$ does: inner particles lap outer ones. The
three spiral arms therefore wind up over time (the winding problem of real galaxies), which is most of what
makes these presets fun to watch.

## Swirl

The swirl term is $\mathbf a_{swirl} = w\,(\hat{\mathbf n} \times \mathbf d)\,/\,(|\mathbf d|^2 + \varepsilon^2)^{(k+1)/2}$,
with the same falloff as the pull. Since $|\hat{\mathbf n}\times\mathbf d| = |\mathbf d_\perp|$, the distance
from the axis, it is a vortex around the line through the attractor along $\hat{\mathbf n}$. For the cursor,
$\hat{\mathbf n}$ is the camera's forward direction, so the swirl spins in the screen plane. For pins it is
world up.

A pure vortex only adds tangential speed, and fast tangential motion flings particles outward. The swirl tool
therefore mixes in a radial pull ("swirl pull", 0.3 by default) that bends them back into a whirlpool.

## Turbulence: divergence-free noise

`src/sim/noise.wgsl`

Turbulence is an acceleration field built from simplex noise $n$. Pushing particles along a noise gradient
$\nabla n$ makes them pile up at the noise maxima, because a gradient field has sinks. A field with no sinks
or sources has zero divergence. The cross product of two gradients has exactly that property:

$$
\mathbf f(\mathbf x) = \nabla n_1(\mathbf x) \times \nabla n_2(\mathbf x),
\qquad
\nabla\cdot(\nabla a \times \nabla b) = \nabla b\cdot(\nabla\times\nabla a) - \nabla a\cdot(\nabla\times\nabla b) = 0
$$

since the curl of a gradient is zero. Here $n_2$ is $n_1$ sampled at an offset position. This is "bitangent
noise". It costs two noise gradients where classic curl noise needs three, and the flow it produces is
incompressible: particles stream and fold like smoke instead of clumping.

The gradient is analytic, not finite-differenced. 3D simplex noise is a sum over the four corners of the
simplex containing $\mathbf x$, with $\mathbf x_i$ the offset to corner $i$ and $\mathbf g_i$ its pseudo-random
gradient:

$$
n = 105\sum_i m_i^4\,(\mathbf g_i\cdot\mathbf x_i), \qquad m_i = \max(0.5 - |\mathbf x_i|^2,\ 0)
$$

$$
\nabla n = 105\sum_i \left( m_i^4\,\mathbf g_i \;-\; 8\,m_i^3\,(\mathbf g_i\cdot\mathbf x_i)\,\mathbf x_i \right)
$$

The field is sampled at $\mathbf p\cdot f + (0, 0, t\cdot\text{speed})$, so the frequency $f$ sets the eddy
size and the slow drift along $z$ makes the pattern evolve. The offset wraps at 289, the period of the noise's
permutation polynomial, to keep float precision. The result is scaled by 0.35, which brings its typical
magnitude to about 1, so the turbulence slider reads as an acceleration.

The field is sampled once per frame rather than per substep: it changes too slowly for the difference to show.

## Home spring and drag: a damped oscillator

Each particle remembers a home position $\mathbf h$ on its seed shape. The home spring is Hooke's law
$\mathbf a = \kappa\,(\mathbf h - \mathbf p)$. Together with drag $c$, each particle is a damped harmonic oscillator:

$$
\ddot{\mathbf x} + c\,\dot{\mathbf x} + \kappa\,\mathbf x = 0,
\qquad \omega_0 = \sqrt{\kappa},\qquad \zeta = \frac{c}{2\sqrt{\kappa}}
$$

- $\zeta < 1$: underdamped. A disturbed shape wobbles back, overshooting with angular frequency
  $\omega_0\sqrt{1-\zeta^2}$.
- $\zeta = 1$: critically damped, the fastest return with no overshoot.
- $\zeta > 1$: overdamped, a slow creep home.

Elastic torus uses $\kappa = 6$, $c = 2.5$, so $\zeta \approx 0.51$. Poke it and it jiggles back with a period
of about 3 s. **Morph** rewrites only the home positions: with the spring on, every particle travels from where
it is to its new home, and that journey is the morph animation.

Drag alone also sets a terminal speed under a constant acceleration $g$: $v_\infty = g/c$. Sandbox's gravity
of 3 with drag 0.2 allows 15 units/s, under the 20 cap.

## Bounds

- **Wrap** (a periodic box of half size $L$): $\ p \leftarrow p - 2L\,\lfloor (p + L)/2L \rfloor$ per axis.
- **Bounce in a box**: clamp to $[-L, L]$, and multiply each velocity component that still points outward by $-e$
  (restitution).
- **Bounce in a sphere**: project onto the sphere and reflect the outward normal component,
  $\mathbf v \leftarrow \mathbf v - (1 + e)(\mathbf v\cdot\hat{\mathbf n})\,\hat{\mathbf n}$ when $\mathbf v\cdot\hat{\mathbf n} > 0$.

## Seed shapes: sampling

`src/sim/seed.wgsl`

Random numbers come from a PCG hash of the particle index and seed. Taking the top 24 bits and dividing by
$2^{24}$ keeps every value exactly representable as a float in $[0, 1)$.

- **Uniform direction:** $z = 2u_1 - 1$ and $\varphi = 2\pi u_2$. By Archimedes' hat-box theorem, the area of a
  sphere between two heights is proportional to their difference, so a uniform $z$ is uniform on the sphere.
- **Filled ball:** the volume inside radius $r$ grows as $r^3$, so $r = R\,u^{1/3}$. Using $r = Ru$ would
  crowd the centre.
- **Gaussian cloud:** Box–Muller, $g = \sqrt{-2\ln u_1}\,\cos(2\pi u_2)$, with $\sigma = R/2$.
- **Torus:** the tube cross-section is sampled uniformly in its disc ($\rho = 0.25R\sqrt u$), and both angles
  uniformly. That is not exactly uniform in volume: the true volume element carries a factor
  $(R_{major} + \rho\cos v)$, so the inner side of the ring is slightly denser than it should be. It reads as
  shading, so it stays.
- **Galaxy:** 15% of particles form a Gaussian bulge. The rest sit on three arms at angle
  $\theta = \tfrac{2\pi}{3}\,\text{arm} + 3.5\,t + \text{noise}/(1 + 3t)$, with $t = u^{1.3}$ the radial fraction.
  The angular spread narrows outward, and the disc gets thinner as $t$ grows.

## Camera and the 3D cursor

`src/camera.ts`

The orbit camera sits on a sphere around its target, with yaw $\theta$, pitch $\phi$ and distance $d$:

$$
\mathbf e = \mathbf t + d\,(\cos\phi\sin\theta,\ \sin\phi,\ \cos\phi\cos\theta)
$$

Input moves a *goal* pose, and the rendered pose eases toward it with
$x \leftarrow x + (x_{goal} - x)(1 - e^{-\Delta t/\tau})$. That is frame-rate independent exponential
smoothing with time constant $\tau$ (the damping setting). Panning moves the target by
$2d\tan(\text{fov}/2)/H$ world units per pixel, so the point under the mouse stays under the mouse.

**The 3D cursor** is a ray–plane intersection. The mouse's NDC position $(x, y)$ is unprojected through
$(PV)^{-1}$ at the far plane, $z = 1$, then divided by $w$. That gives a ray from the eye with direction
$\hat{\mathbf r}$. The cursor plane faces the camera, $\hat{\mathbf f}$ (forward) is its normal, and it lies at
distance $d + \delta$ from the eye, where $\delta$ is the cursor depth. So:

$$
\mathbf c = \mathbf e + \hat{\mathbf r}\,\frac{d + \delta}{\hat{\mathbf r}\cdot\hat{\mathbf f}}
$$

Because the plane passes through the orbit target, a depth of 0 means "at the centre of what you're looking at",
however far you zoom.

## Drawing particles

`src/render/particles.wgsl`

The vertex shaders read positions and velocities straight from the simulation's storage buffers. There are no
vertex buffers, and nothing is copied.

- **Points** are 1 device pixel each (WebGPU points have no size).
- **Sprites** are camera-facing quads of world radius $r$. Their radius in pixels is
  $r_{px} = r\,P_{11}\,\tfrac{H}{2}\,/\,z_{view}$, where $P_{11} = 1/\tan(\text{fov}/2)$. Below
  $r_{min} = 1.25$ px they would shimmer, so they are grown to $r_{min}$ and dimmed by the area ratio
  $(r_{px}/r_{min})^2$, which keeps the light they add constant. The profile is $(1 - \rho^2)^2$ on the unit disc.
- **Streaks** run from $\mathbf p$ back to $\mathbf p - \mathbf v T$ in screen space, with half width $w$, and
  extend by $w$ past both ends so a slow particle is a round dot. Like motion blur, a streak spreads the
  particle's light over its length: its brightness is scaled by $2w / (L + 2w)$ for a screen length of $L$ pixels.

**Brightness is normalized** so changing the count or the display changes detail, not exposure:

$$
I_{eff} = I \cdot \frac{2^{20}}{N} \cdot s^2 \quad(\text{points only})
$$

Here $s$ is device pixels per CSS pixel. With twice the pixel density, a 1 px point covers a quarter of the
area, so it gets four times the intensity.

Colour comes from a three-stop gradient evaluated at speed $|\mathbf v|/R$, depth
$\tfrac12 + (|\mathbf p - \mathbf e| - d)/R$, cursor distance $|\mathbf p - \mathbf c|/R$, or a per-particle
random tag, with $R$ the colour range. "Direction" maps $\hat{\mathbf v}$ to RGB as $\hat{\mathbf v}/2 + 1/2$.
Every particle's brightness is also scaled by $0.6 + 0.8\,\text{tag}$, which reads as texture.

## Trails

`src/render/post.wgsl`

The image accumulates in a half-float HDR texture. The tonemap pass, while it draws the screen, also writes a
faded copy of the accumulation buffer for the next frame (into a second render target):

$$
A_{n+1} = \max(d\,A_n - \epsilon,\ 0) + \text{particles}_{n+1}
$$

- A particle that stays still converges to brightness $I/(1 - d)$, the geometric series. That is why long
  trails need a lower intensity.
- A trail's half-life in frames is $\ln\tfrac12 / \ln d$: 3 frames at $d = 0.8$, 23 at 0.97, 46 at 0.985
  (0.77 s at 60 fps).
- $\epsilon = 0.0015$ is there because of half precision. fp16 has a 10-bit mantissa, so values are spaced
  about $2^{-10}$ apart relative to their size. When $d$ is close to 1, $d\cdot A$ rounds back to $A$ for small
  $A$, and faint trails would never fade. Subtracting $\epsilon$ guarantees they reach zero.

"Clear on orbit" sets $d = 0$ while the camera moves, because accumulated pixels belong to the old viewpoint.

## Bloom and tonemapping

**Prefilter** with a soft threshold $T$ and knee $K = T/2$, on brightness $b = \max(r, g, b)$:

$$
s = \frac{\operatorname{clamp}(b - T + K,\ 0,\ 2K)^2}{4K},
\qquad
\mathbf c' = \mathbf c\cdot\frac{\max(s,\ b - T)}{\max(b,\ 10^{-5})}
$$

The quadratic ramp around $T$ avoids the hard edge a plain `max(b - T, 0)` would draw around bright regions.

**Downsample** with the 13-tap filter from Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
Warfare" (SIGGRAPH 2014). The weights are 0.125 for the centre, 0.125 for each of the four inner diagonal taps,
0.0625 for each outer edge tap and 0.03125 for each outer corner; they sum to 1. It is a cheap, nearly
alias-free box blur. **Upsample** with a 3×3 tent (weights 1-2-1 over 16) and add each level onto the next
larger one, so each mip contributes a wider blur. The final image is $\mathbf c = A + \text{bloom}\cdot I_{bloom}$.

**Tonemap** with Narkowicz's fit of the ACES filmic curve:

$$
f(x) = \frac{x\,(2.51x + 0.03)}{x\,(2.43x + 0.59) + 0.14}
$$

This compresses unbounded HDR values into $[0, 1]$ with a gentle shoulder: dense cores saturate toward white
instead of clipping to flat colour. The result is encoded with the sRGB transfer function
($12.92c$ below $0.0031308$, otherwise $1.055c^{1/2.4} - 0.055$), because the canvas format is not sRGB.

## Why the simulation is memory-bound

Each particle per frame reads position and velocity (32 bytes), plus home (16) when the spring is on, and writes
position and velocity (32). That is 64–80 bytes. At 4M particles that is 256–320 MB per frame.

On an Intel Arc 140V the measured simulation time at 4M is about 3.2 ms, around 100 GB/s, close to what its
LPDDR5X memory can deliver. The arithmetic (a few attractors, a clamp, a bounds test) is nearly free next to
that traffic. That is why:

- substeps loop in registers instead of running as separate passes,
- the home buffer is read only when the home spring is on,
- the next speed-up would be packing state into half precision (`f16`), not cheaper maths.

The **follow** mode's centroid uses a strided sample of 16 384 particles. Each workgroup sums its 256 in shared
memory with a tree reduction ($\log_2 256 = 8$ steps), and the CPU adds the 64 partial sums. That is enough to
track the swarm without reading 16M positions back.
