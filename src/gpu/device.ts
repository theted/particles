export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  timestamps: boolean;
  /** Largest particle count whose vec4f buffers fit in one storage binding. */
  maxParticles: number;
}

const ENABLE_HINT =
  'In Chromium on Linux, open chrome://gpu and look for "WebGPU: Hardware accelerated". ' +
  'If it is not, start Chromium with --enable-unsafe-webgpu --enable-features=Vulkan ' +
  '(or turn on chrome://flags/#enable-unsafe-webgpu).';

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!('gpu' in navigator)) throw new Error(`This browser has no WebGPU.\n\n${ENABLE_HINT}`);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error(`WebGPU is present but found no usable GPU adapter.\n\n${ENABLE_HINT}`);

  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: timestamps ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') showError(`The GPU device was lost: ${info.message}`);
  });
  device.addEventListener('uncapturederror', (e) => showError((e as GPUUncapturedErrorEvent).error.message));

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not get a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const perBuffer = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  return { device, context, format, timestamps, maxParticles: Math.floor(perBuffer / 16) };
}

/** Creates a shader module and puts any WGSL compile errors on the page. */
export function shaderModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  module.getCompilationInfo().then((info) => {
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      showError(`WGSL error in ${label}:\n` + errors.map((m) => `  line ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    }
  });
  return module;
}

export function showError(message: string): void {
  console.error(message);
  const el = document.getElementById('error');
  if (!el) return;
  el.hidden = false;
  el.textContent += message + '\n\n';
}
