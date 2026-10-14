import { mat4, vec3, type Vec3 } from 'wgpu-matrix';

const UP = vec3.fromValues(0, 1, 0);
const PITCH_LIMIT = 1.54;
/** Radians of orbit per pixel of drag. */
const ORBIT_GAIN = 0.005;

interface Pose {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
}

/** Camera motion held down on keys or buttons. Each axis is -1, 0 or 1. */
export interface Drive {
  /** Move the camera right (orbit, or slide with `pan`). */
  x: number;
  /** Move the camera up. */
  y: number;
  /** Move in toward the target. */
  zoom: number;
  pan: boolean;
}

const homePose = (): Pose => ({ target: vec3.create(0, 0, 0), yaw: 0.6, pitch: 0.35, distance: 4.5 });
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** An angle wrapped into [-π, π], so easing toward it turns the short way round. */
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * Orbit camera. Input moves a goal pose; the rendered pose eases toward it, so motion is
 * damped. `moving` reports whether the rendered pose changed this frame.
 */
export class OrbitCamera {
  readonly eye = vec3.create();
  readonly forward = vec3.create();
  readonly right = vec3.create();
  readonly up = vec3.create();
  readonly view = mat4.identity();
  readonly proj = mat4.identity();
  readonly viewProj = mat4.identity();
  moving = false;
  /** Seconds since the camera was last steered (follow and auto-rotate don't count). */
  idle = Infinity;

  private pose = homePose();
  private goal = homePose();
  private fovY = (50 * Math.PI) / 180;
  private readonly invViewProj = mat4.identity();

  get distance(): number {
    return this.pose.distance;
  }

  /** The point the camera orbits around. */
  get target(): Vec3 {
    return this.pose.target;
  }

  /** Turns the camera around the target, in radians. */
  rotate(yaw: number, pitch: number): void {
    this.goal.yaw += yaw;
    this.goal.pitch = clamp(this.goal.pitch + pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.idle = 0;
  }

  /** Orbits by a screen-space drag, turning the scene the way the mouse moves. */
  orbit(dx: number, dy: number): void {
    this.rotate(-dx * ORBIT_GAIN, dy * ORBIT_GAIN);
  }

  /** Moves the target across the view, in view heights. */
  slide(right: number, up: number): void {
    const height = 2 * this.goal.distance * Math.tan(this.fovY / 2);
    vec3.addScaled(this.goal.target, this.right, right * height, this.goal.target);
    vec3.addScaled(this.goal.target, this.up, up * height, this.goal.target);
    this.idle = 0;
  }

  /** Pans by a screen-space drag, so the point under the mouse stays under the mouse. */
  pan(dx: number, dy: number, viewportHeight: number): void {
    this.slide(-dx / viewportHeight, dy / viewportHeight);
  }

  /** Multiplies the distance to the target: below 1 zooms in. */
  zoomBy(factor: number): void {
    this.goal.distance = clamp(this.goal.distance * factor, 0.05, 500);
    this.idle = 0;
  }

  /** Zooms by a wheel delta in pixels. */
  zoom(delta: number): void {
    this.zoomBy(Math.exp(delta * 0.0015));
  }

  /** Applies held-down motion for one frame. */
  drive({ x, y, zoom, pan }: Drive, dt: number): void {
    if (pan) {
      if (x || y) this.slide(x * 0.6 * dt, y * 0.6 * dt);
    } else if (x || y) {
      this.rotate(x * 1.4 * dt, y * 1.0 * dt);
    }
    if (zoom) this.zoomBy(Math.exp(-zoom * 1.2 * dt));
  }

  /**
   * Eases round to look at the target from one side of a world axis (0 = x, 1 = y, 2 = z).
   * Asking for the view it already has turns it round to the opposite side.
   */
  lookFrom(axis: number, sign: number): void {
    const g = this.goal;
    const quarter = Math.PI / 2;
    const view = (s: number) => ({
      // Top and bottom views keep the nearest square-on heading.
      yaw: axis === 0 ? s * quarter : axis === 2 ? (s > 0 ? 0 : Math.PI) : Math.round(g.yaw / quarter) * quarter,
      pitch: axis === 1 ? s * PITCH_LIMIT : 0,
    });
    let v = view(sign);
    if (Math.abs(wrap(v.yaw - g.yaw)) < 1e-3 && Math.abs(v.pitch - g.pitch) < 1e-3) v = view(-sign);
    g.yaw += wrap(v.yaw - g.yaw);
    g.pitch = v.pitch;
    this.idle = 0;
  }

  /** Eases the orbit target toward a point (follow mode). */
  follow(point: ArrayLike<number>, dt: number): void {
    vec3.lerp(this.goal.target, point, 1 - Math.exp(-dt * 2), this.goal.target);
  }

  reset(): void {
    // Turn the short way home, not back through every turn orbited or auto-rotated so far.
    const home = homePose();
    home.yaw = this.goal.yaw + wrap(home.yaw - this.goal.yaw);
    this.goal = home;
    this.idle = 0;
  }

  update(dt: number, damping: number, autoRotate: number, fovDeg: number, aspect: number): void {
    const p = this.pose;
    const g = this.goal;
    this.idle += dt;
    g.yaw += autoRotate * dt;
    const k = damping > 0 ? 1 - Math.exp(-dt / damping) : 1;
    const before = [p.yaw, p.pitch, p.distance, p.target[0], p.target[1], p.target[2]];
    p.yaw += (g.yaw - p.yaw) * k;
    p.pitch += (g.pitch - p.pitch) * k;
    p.distance += (g.distance - p.distance) * k;
    vec3.lerp(p.target, g.target, k, p.target);
    const angular = Math.abs(p.yaw - before[0]) + Math.abs(p.pitch - before[1]);
    const linear = (Math.abs(p.distance - before[2]) + vec3.distance(p.target, before.slice(3))) / p.distance;
    this.moving = angular > 1e-4 || linear > 1e-4;

    this.fovY = (fovDeg * Math.PI) / 180;
    const cp = Math.cos(p.pitch);
    vec3.set(cp * Math.sin(p.yaw), Math.sin(p.pitch), cp * Math.cos(p.yaw), this.eye);
    vec3.addScaled(p.target, this.eye, p.distance, this.eye);
    mat4.lookAt(this.eye, p.target, UP, this.view);
    mat4.perspective(this.fovY, aspect, Math.max(p.distance * 0.002, 1e-3), p.distance * 50 + 100, this.proj);
    mat4.multiply(this.proj, this.view, this.viewProj);
    mat4.inverse(this.viewProj, this.invViewProj);
    vec3.normalize(vec3.subtract(p.target, this.eye, this.forward), this.forward);
    vec3.normalize(vec3.cross(this.forward, UP, this.right), this.right);
    vec3.cross(this.right, this.forward, this.up);
  }

  /**
   * The 3D cursor: where the mouse ray meets a plane facing the camera, `depth` beyond the
   * orbit target (negative depth is nearer the camera).
   */
  cursorPoint(ndcX: number, ndcY: number, depth: number, out: Vec3): Vec3 {
    const far = vec3.transformMat4([ndcX, ndcY, 1], this.invViewProj);
    const dir = vec3.normalize(vec3.subtract(far, this.eye));
    const along = Math.max(this.pose.distance + depth, this.pose.distance * 0.05);
    const t = along / Math.max(vec3.dot(dir, this.forward), 1e-3);
    return vec3.addScaled(this.eye, dir, t, out);
  }
}
