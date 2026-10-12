import centroidCode from './centroid.wgsl?raw';
import noiseCode from './noise.wgsl?raw';
import seedCode from './seed.wgsl?raw';
import stepCode from './step.wgsl?raw';
import { shaderModule } from '../gpu/device';
import { MAX_PINS, type Params, type Pin } from '../params';

const WORKGROUP = 256;
const CENTROID_GROUPS = 64;
const SIM_FLOATS = 8 * 4 + 32 * 4;

/** Workgroup counts for `count` threads, split over y once x hits its 65535 limit. */
export function dispatchSize(count: number): [number, number] {
  const groups = Math.ceil(count / WORKGROUP);
  const x = Math.min(groups, 65535);
  return [x, Math.ceil(groups / x)];
}

/** Radial and swirl strength for a force tool. Inverting turns pull into push and reverses a swirl. */
export function toolForce(tool: number, strength: number, swirlPull: number, invert: boolean): [number, number] {
  const sign = invert ? -1 : 1;
  if (tool === 1) return [-strength * sign, 0];
  if (tool === 2) return [strength * swirlPull, strength * sign];
  return [strength * sign, 0];
}

export interface SimFrame {
  dt: number;
  time: number;
  cursor: ArrayLike<number>;
  cursorOn: boolean;
  invert: boolean;
  /** Swirl axis for the cursor: the camera's forward direction. */
  axis: ArrayLike<number>;
  /** Pins at their current (possibly orbiting) positions. */
  pins: Pin[];
}

/** Particle state on the GPU (positions, velocities, home shape) and the compute passes on it. */
export class ParticleSystem {
  count = 0;
  pos!: GPUBuffer;
  vel!: GPUBuffer;
  home!: GPUBuffer;
  /** Bumped whenever the buffers are reallocated, so bind groups elsewhere know to rebuild. */
  generation = 0;
  /** Mean position of a sample of particles, refreshed while the camera follows the swarm. */
  centroid: [number, number, number] | null = null;

  private readonly sim = new Float32Array(SIM_FLOATS);
  private readonly simUniform: GPUBuffer;
  private readonly seedUniform: GPUBuffer;
  private readonly centroidUniform: GPUBuffer;
  private readonly partial: GPUBuffer;
  private readonly partialRead: GPUBuffer;
  private readonly stepPipeline: GPUComputePipeline;
  private readonly seedPipeline: GPUComputePipeline;
  private readonly centroidPipeline: GPUComputePipeline;
  private stepGroup!: GPUBindGroup;
  private seedGroup!: GPUBindGroup;
  private centroidGroup!: GPUBindGroup;
  private centroidPending = false;
  private centroidCopied = false;

  constructor(private readonly device: GPUDevice, count: number) {
    const uniform = (label: string, size: number) =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.simUniform = uniform('sim params', SIM_FLOATS * 4);
    this.seedUniform = uniform('seed params', 32);
    this.centroidUniform = uniform('centroid params', 16);
    this.partial = device.createBuffer({
      label: 'centroid partial sums',
      size: CENTROID_GROUPS * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.partialRead = device.createBuffer({
      label: 'centroid readback',
      size: CENTROID_GROUPS * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const compute = (label: string, code: string) =>
      device.createComputePipeline({
        label,
        layout: 'auto',
        compute: { module: shaderModule(device, label, code), entryPoint: 'main' },
      });
    this.stepPipeline = compute('step.wgsl', noiseCode + stepCode);
    this.seedPipeline = compute('seed.wgsl', seedCode);
    this.centroidPipeline = compute('centroid.wgsl', centroidCode);
    this.allocate(count);
  }

  allocate(count: number): void {
    for (const b of [this.pos, this.vel, this.home]) b?.destroy();
    const storage = (label: string) =>
      this.device.createBuffer({ label, size: count * 16, usage: GPUBufferUsage.STORAGE });
    this.pos = storage('positions');
    this.vel = storage('velocities');
    this.home = storage('home positions');
    this.count = count;
    this.generation++;
    this.centroid = null;

    const group = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) =>
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    this.stepGroup = group(this.stepPipeline, [this.simUniform, this.pos, this.vel, this.home]);
    this.seedGroup = group(this.seedPipeline, [this.seedUniform, this.pos, this.vel, this.home]);
    this.centroidGroup = group(this.centroidPipeline, [this.pos, this.partial, this.centroidUniform]);
  }

  /** Lays particles out on the seed shape. With homeOnly, moves only their homes (a morph). */
  seed(shape: Params['shape'], homeOnly: boolean): void {
    const data = new ArrayBuffer(32);
    new Uint32Array(data, 0, 4).set([shape.shape, this.count, shape.seed, homeOnly ? 1 : 0]);
    new Float32Array(data, 16, 2).set([shape.size, shape.spin]);
    this.device.queue.writeBuffer(this.seedUniform, 0, data);
    const encoder = this.device.createCommandEncoder({ label: 'seed' });
    this.dispatch(encoder, this.seedPipeline, this.seedGroup, 'seed');
    this.device.queue.submit([encoder.finish()]);
  }

  /** Packs the frame's params into the sim uniform. */
  update(p: Params, f: SimFrame): void {
    const s = this.sim;
    const [radial, swirl] = toolForce(p.cursor.tool, p.cursor.strength, p.cursor.swirlPull, f.invert);
    const substeps = Math.max(1, Math.round(p.sim.substeps));
    const pins = f.pins.slice(0, MAX_PINS);
    s.set([f.cursor[0], f.cursor[1], f.cursor[2], f.cursorOn ? 1 : 0], 0);
    s.set([f.axis[0], f.axis[1], f.axis[2], 0], 4);
    s.set([radial, swirl, 0, 0], 8);
    s.set([p.forces.softening ** 2, p.forces.falloff, 0, 0], 12);
    s.set([p.forces.gravity.x, p.forces.gravity.y, p.forces.gravity.z, p.forces.drag], 16);
    s.set([p.forces.noise, p.forces.noiseScale, (f.time * p.forces.noiseSpeed) % 289, p.forces.homeSpring], 20);
    s.set([p.bounds.mode, p.bounds.size, p.bounds.restitution, p.forces.maxSpeed], 24);
    s.set([f.dt / substeps, substeps, this.count, pins.length], 28);
    pins.forEach((pin, j) => {
      const [pr, ps] = toolForce(pin.tool, p.pins.strength, p.pins.swirlPull, false);
      s.set([pin.x, pin.y, pin.z, 0, pr, ps, 0, 0], 32 + j * 8);
    });
  }

  step(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.device.queue.writeBuffer(this.simUniform, 0, this.sim);
    this.dispatch(encoder, this.stepPipeline, this.stepGroup, 'step', timestampWrites);
  }

  /** Encodes a centroid measurement unless one is already being read back. */
  requestCentroid(encoder: GPUCommandEncoder): void {
    if (this.centroidPending) return;
    const stride = Math.max(1, Math.floor(this.count / (CENTROID_GROUPS * WORKGROUP)));
    this.device.queue.writeBuffer(this.centroidUniform, 0, new Uint32Array([this.count, stride, 0, 0]));
    const pass = encoder.beginComputePass({ label: 'centroid' });
    pass.setPipeline(this.centroidPipeline);
    pass.setBindGroup(0, this.centroidGroup);
    pass.dispatchWorkgroups(CENTROID_GROUPS);
    pass.end();
    encoder.copyBufferToBuffer(this.partial, 0, this.partialRead, 0, CENTROID_GROUPS * 16);
    this.centroidCopied = true;
  }

  /** Call after submit: starts the readback of a centroid encoded this frame. */
  collectCentroid(): void {
    if (!this.centroidCopied) return;
    this.centroidCopied = false;
    this.centroidPending = true;
    const generation = this.generation;
    this.partialRead.mapAsync(GPUMapMode.READ).then(() => {
      const sums = new Float32Array(this.partialRead.getMappedRange().slice(0));
      this.partialRead.unmap();
      this.centroidPending = false;
      let x = 0, y = 0, z = 0, n = 0;
      for (let i = 0; i < sums.length; i += 4) {
        x += sums[i];
        y += sums[i + 1];
        z += sums[i + 2];
        n += sums[i + 3];
      }
      if (n > 0 && generation === this.generation) this.centroid = [x / n, y / n, z / n];
    }, () => (this.centroidPending = false));
  }

  private dispatch(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    group: GPUBindGroup,
    label: string,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    const pass = encoder.beginComputePass({ label, timestampWrites });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(...dispatchSize(this.count));
    pass.end();
  }
}
