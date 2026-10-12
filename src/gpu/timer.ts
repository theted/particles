/**
 * GPU time for the simulation and the rendering, from timestamp queries. Readback is
 * asynchronous; while one is in flight, later frames skip the copy.
 */
export class GpuTimer {
  simMs = 0;
  renderMs = 0;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private pending = false;
  private copied = false;

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
    this.resolveBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  get sim(): GPUComputePassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }
  get renderBegin(): GPURenderPassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 2 };
  }
  get renderEnd(): GPURenderPassTimestampWrites {
    return { querySet: this.querySet, endOfPassWriteIndex: 3 };
  }

  resolve(encoder: GPUCommandEncoder): void {
    if (this.pending) return;
    encoder.resolveQuerySet(this.querySet, 0, 4, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 32);
    this.copied = true;
  }

  /** Call after submit. `simRan` is false when the sim pass was skipped (paused). */
  collect(simRan: boolean): void {
    if (!this.copied) return;
    this.copied = false;
    this.pending = true;
    this.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(this.readBuffer.getMappedRange().slice(0));
      this.readBuffer.unmap();
      this.pending = false;
      const ms = (a: bigint, b: bigint) => (b > a ? Number(b - a) / 1e6 : 0);
      this.simMs = smooth(this.simMs, simRan ? ms(t[0], t[1]) : 0);
      this.renderMs = smooth(this.renderMs, ms(t[2], t[3]));
    }, () => (this.pending = false));
  }
}

const smooth = (prev: number, next: number) => prev * 0.8 + next * 0.2;
