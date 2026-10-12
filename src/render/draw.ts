import gizmoCode from './gizmo.wgsl?raw';
import particlesCode from './particles.wgsl?raw';
import postCode from './post.wgsl?raw';
import type { OrbitCamera } from '../camera';
import { shaderModule } from '../gpu/device';
import type { GpuTimer } from '../gpu/timer';
import type { Params } from '../params';
import type { ParticleSystem } from '../sim/particles';

const HDR: GPUTextureFormat = 'rgba16float';
const MAX_BLOOM_LEVELS = 6;
const MAX_MARKERS = 18;
const MIN_SPRITE_PX = 1.25;
/** Subtracted from the trail every frame, so faint trails reach zero instead of sticking in fp16. */
const FADE_EPS = 0.0015;

const additive: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
const premultiplied: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };

export interface Marker {
  pos: ArrayLike<number>;
  radius: number;
  filled: boolean;
  color: [number, number, number, number];
}

export interface RenderFrame {
  params: Params;
  camera: OrbitCamera;
  cursor: ArrayLike<number>;
  /** Trail decay for this frame: 0 clears the trails. */
  trailDecay: number;
  markers: Marker[];
  /** Device pixels per CSS pixel (devicePixelRatio times the resolution setting). */
  pixelScale: number;
  timer?: GpuTimer;
}

/**
 * Each frame:
 * 1. Particles are added onto accum[cur], which holds the faded previous frame.
 * 2. Bloom is built from accum[cur].
 * 3. The tonemap pass writes the screen, and also a faded accum[cur] into accum[next].
 * 4. Gizmos are drawn on top.
 */
export class Renderer {
  private width = 0;
  private height = 0;
  private current = 0;

  private readonly renderData = new Float32Array(64);
  private readonly postData = new Float32Array(8);
  private readonly gizmoData = new Float32Array(20 + MAX_MARKERS * 8);
  private readonly renderUniform: GPUBuffer;
  private readonly postUniform: GPUBuffer;
  private readonly gizmoUniform: GPUBuffer;

  private readonly particleLayout: GPUBindGroupLayout;
  private readonly postLayout: GPUBindGroupLayout;
  private readonly particlePipelines: GPURenderPipeline[];
  private readonly downFirst: GPURenderPipeline;
  private readonly down: GPURenderPipeline;
  private readonly up: GPURenderPipeline;
  private readonly tonemap: GPURenderPipeline;
  private readonly gizmo: GPURenderPipeline;
  private readonly gizmoGroup: GPUBindGroup;
  private readonly sampler: GPUSampler;
  private readonly dummyView: GPUTextureView;

  private particleGroup?: GPUBindGroup;
  private particleGeneration = -1;
  private accum: GPUTexture[] = [];
  private accumViews: GPUTextureView[] = [];
  private bloom?: GPUTexture;
  private bloomViews: GPUTextureView[] = [];
  private downFirstGroups: GPUBindGroup[] = [];
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  private tonemapGroups: GPUBindGroup[] = [];

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    const uniform = (label: string, size: number) =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.renderUniform = uniform('render params', this.renderData.byteLength);
    this.postUniform = uniform('post params', this.postData.byteLength);
    this.gizmoUniform = uniform('gizmo params', this.gizmoData.byteLength);
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.dummyView = device
      .createTexture({ size: [1, 1], format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView();

    const particleModule = shaderModule(device, 'particles.wgsl', particlesCode);
    this.particleLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const particlePipeline = (name: string, topology: GPUPrimitiveTopology) =>
      device.createRenderPipeline({
        label: name,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.particleLayout] }),
        vertex: { module: particleModule, entryPoint: `vs_${name}` },
        fragment: {
          module: particleModule,
          entryPoint: `fs_${name}`,
          targets: [{ format: HDR, blend: { color: additive, alpha: additive } }],
        },
        primitive: { topology },
      });
    this.particlePipelines = [
      particlePipeline('points', 'point-list'),
      particlePipeline('sprites', 'triangle-list'),
      particlePipeline('streaks', 'triangle-list'),
    ];

    const postModule = shaderModule(device, 'post.wgsl', postCode);
    this.postLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const postPipeline = (entryPoint: string, targets: GPUColorTargetState[]) =>
      device.createRenderPipeline({
        label: entryPoint,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
        vertex: { module: postModule, entryPoint: 'vs_full' },
        fragment: { module: postModule, entryPoint, targets },
      });
    this.downFirst = postPipeline('fs_down_first', [{ format: HDR }]);
    this.down = postPipeline('fs_down', [{ format: HDR }]);
    this.up = postPipeline('fs_up', [{ format: HDR, blend: { color: additive, alpha: additive } }]);
    this.tonemap = postPipeline('fs_tonemap', [{ format }, { format: HDR }]);

    const gizmoModule = shaderModule(device, 'gizmo.wgsl', gizmoCode);
    this.gizmo = device.createRenderPipeline({
      label: 'gizmo',
      layout: 'auto',
      vertex: { module: gizmoModule, entryPoint: 'vs_gizmo' },
      fragment: {
        module: gizmoModule,
        entryPoint: 'fs_gizmo',
        targets: [{ format, blend: { color: premultiplied, alpha: premultiplied } }],
      },
    });
    this.gizmoGroup = device.createBindGroup({
      layout: this.gizmo.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.gizmoUniform } }],
    });
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (const t of this.accum) t.destroy();
    this.bloom?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.accum = [0, 1].map((i) =>
      this.device.createTexture({ label: `accum ${i}`, size: [width, height], format: HDR, usage }),
    );
    this.accumViews = this.accum.map((t) => t.createView());

    const bw = Math.max(1, width >> 1);
    const bh = Math.max(1, height >> 1);
    let levels = 1;
    while (levels < MAX_BLOOM_LEVELS && Math.min(bw, bh) >> levels >= 8) levels++;
    const bloom = this.device.createTexture({ label: 'bloom', size: [bw, bh], format: HDR, usage, mipLevelCount: levels });
    this.bloom = bloom;
    this.bloomViews = Array.from({ length: levels }, (_, l) => bloom.createView({ baseMipLevel: l, mipLevelCount: 1 }));

    const group = (src: GPUTextureView, bloomTex = this.dummyView) =>
      this.device.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: { buffer: this.postUniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: src },
          { binding: 3, resource: bloomTex },
        ],
      });
    this.downFirstGroups = this.accumViews.map((v) => group(v));
    this.downGroups = this.bloomViews.slice(0, -1).map((v) => group(v)); // reads mip i, writes i+1
    this.upGroups = this.bloomViews.slice(1).map((v) => group(v)); // reads mip i+1, writes i
    this.tonemapGroups = this.accumViews.map((v) => group(v, this.bloomViews[0]));
  }

  render(encoder: GPUCommandEncoder, target: GPUTextureView, particles: ParticleSystem, f: RenderFrame): void {
    const p = f.params;
    if (particles.generation !== this.particleGeneration) {
      this.particleGeneration = particles.generation;
      this.particleGroup = this.device.createBindGroup({
        layout: this.particleLayout,
        entries: [
          { binding: 0, resource: { buffer: this.renderUniform } },
          { binding: 1, resource: { buffer: particles.pos } },
          { binding: 2, resource: { buffer: particles.vel } },
        ],
      });
    }
    this.writeUniforms(f, particles.count);

    const cur = this.current;
    const next = 1 - cur;
    const markers = p.render.gizmos ? f.markers.slice(0, MAX_MARKERS) : [];

    const pass = encoder.beginRenderPass({
      label: 'particles',
      colorAttachments: [{ view: this.accumViews[cur], loadOp: 'load', storeOp: 'store' }],
      timestampWrites: f.timer?.renderBegin,
    });
    const mode = Math.min(Math.max(Math.round(p.render.mode), 0), 2);
    pass.setPipeline(this.particlePipelines[mode]);
    pass.setBindGroup(0, this.particleGroup);
    if (mode === 0) pass.draw(particles.count);
    else pass.draw(6, particles.count);
    pass.end();

    if (p.bloom.enabled) {
      const levels = this.bloomViews.length;
      this.fullscreen(encoder, this.bloomViews[0], this.downFirst, this.downFirstGroups[cur], 'clear');
      for (let i = 1; i < levels; i++) this.fullscreen(encoder, this.bloomViews[i], this.down, this.downGroups[i - 1], 'clear');
      for (let i = levels - 2; i >= 0; i--) this.fullscreen(encoder, this.bloomViews[i], this.up, this.upGroups[i], 'load');
    }

    const tone = encoder.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [
        { view: target, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' },
        { view: this.accumViews[next], loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: markers.length ? undefined : f.timer?.renderEnd,
    });
    tone.setPipeline(this.tonemap);
    tone.setBindGroup(0, this.tonemapGroups[cur]);
    tone.draw(3);
    tone.end();

    if (markers.length) {
      const g = encoder.beginRenderPass({
        label: 'gizmos',
        colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: f.timer?.renderEnd,
      });
      g.setPipeline(this.gizmo);
      g.setBindGroup(0, this.gizmoGroup);
      g.draw(6, markers.length);
      g.end();
    }

    this.current = next;
  }

  private fullscreen(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    pipeline: GPURenderPipeline,
    group: GPUBindGroup,
    loadOp: GPULoadOp,
  ): void {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp, storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  private writeUniforms(f: RenderFrame, count: number): void {
    const { params: p, camera, cursor } = f;
    const { render: rp, bloom } = p;
    const color = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b, 0];

    const r = this.renderData;
    r.set(camera.proj, 0);
    r.set(camera.view, 16);
    // Intensity is per million particles, so changing the count changes detail, not brightness.
    // 1px points also spread thinner on dense displays: compensate by the pixel area.
    const px = f.pixelScale;
    const intensity = ((rp.intensity * (1 << 20)) / count) * (rp.mode === 0 ? px * px : 1);
    r.set([this.width, this.height, MIN_SPRITE_PX * px, 0], 32);
    r.set([rp.size, intensity, rp.colorMode, rp.colorRange], 36);
    r.set(color(rp.colorA), 40);
    r.set(color(rp.colorB), 44);
    r.set(color(rp.colorC), 48);
    r.set([cursor[0], cursor[1], cursor[2], 0], 52);
    r.set([camera.eye[0], camera.eye[1], camera.eye[2], camera.distance], 56);
    r.set([rp.streakLength, rp.streakWidth * px, 0, 0], 60);
    this.device.queue.writeBuffer(this.renderUniform, 0, r);

    this.postData.set([
      rp.exposure,
      f.trailDecay,
      FADE_EPS,
      bloom.intensity,
      bloom.threshold,
      Math.max(bloom.threshold * 0.5, 1e-3),
      bloom.radius,
      bloom.enabled ? 1 : 0,
    ]);
    this.device.queue.writeBuffer(this.postUniform, 0, this.postData);

    const g = this.gizmoData;
    g.set(camera.viewProj, 0);
    g.set([this.width, this.height, 0, 0], 16);
    f.markers.slice(0, MAX_MARKERS).forEach((m, i) => {
      g.set([m.pos[0], m.pos[1], m.pos[2], m.filled ? m.radius : -m.radius], 20 + i * 4);
      g.set(m.color, 20 + MAX_MARKERS * 4 + i * 4);
    });
    this.device.queue.writeBuffer(this.gizmoUniform, 0, g);
  }
}
