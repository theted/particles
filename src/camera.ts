import { mat4, vec3, type Vec3 } from 'wgpu-matrix';

const UP = vec3.fromValues(0, 1, 0);

interface Pose {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
}

const homePose = (): Pose => ({ target: vec3.create(0, 0, 0), yaw: 0.6, pitch: 0.35, distance: 4.5 });
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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

  private pose = homePose();
  private goal = homePose();
  private fovY = (50 * Math.PI) / 180;
  private readonly invViewProj = mat4.identity();

  get distance(): number {
    return this.pose.distance;
  }

  orbit(dx: number, dy: number): void {
    this.goal.yaw -= dx * 0.005;
    this.goal.pitch = clamp(this.goal.pitch + dy * 0.005, -1.54, 1.54);
  }

  /** Pans by a screen-space drag, so the point under the mouse stays under the mouse. */
  pan(dx: number, dy: number, viewportHeight: number): void {
    const s = (2 * this.goal.distance * Math.tan(this.fovY / 2)) / viewportHeight;
    vec3.addScaled(this.goal.target, this.right, -dx * s, this.goal.target);
    vec3.addScaled(this.goal.target, this.up, dy * s, this.goal.target);
  }

  zoom(delta: number): void {
    this.goal.distance = clamp(this.goal.distance * Math.exp(delta * 0.0015), 0.05, 500);
  }

  /** Eases the orbit target toward a point (follow mode). */
  follow(point: ArrayLike<number>, dt: number): void {
    vec3.lerp(this.goal.target, point, 1 - Math.exp(-dt * 2), this.goal.target);
  }

  reset(): void {
    this.goal = homePose();
  }

  update(dt: number, damping: number, autoRotate: number, fovDeg: number, aspect: number): void {
    const p = this.pose;
    const g = this.goal;
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
