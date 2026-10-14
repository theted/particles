import './styles/index.css';
import { vec3 } from 'wgpu-matrix';
import { OrbitCamera } from './camera';
import { Chrome } from './chrome';
import { initGpu, showError } from './gpu/device';
import { GpuTimer } from './gpu/timer';
import { Input, type Actions } from './input';
import { Navigator } from './navigator';
import {
  applyPreset,
  COUNTS,
  fromHash,
  makeDefaults,
  MAX_PINS,
  PRESETS,
  toHash,
  TOOL_NAMES,
  type Pin,
} from './params';
import { Renderer, type Marker } from './render/draw';
import { ParticleSystem } from './sim/particles';
import { countLabel, stats, Ui } from './ui';

// sRGB copies of --tool-attract, --tool-repel and --tool-swirl in style.css.
const TOOL_COLORS: [number, number, number][] = [
  [0.572, 0.79, 1.0],
  [0.965, 0.426, 0.402],
  [0.724, 0.585, 0.963],
];
const PIVOT_COLOR: [number, number, number] = [0.92, 0.95, 1.0];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function rotateY(p: { x: number; y: number; z: number }, angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  const { device, context } = gpu;

  const counts = COUNTS.filter((n) => n <= gpu.maxParticles);
  const validCount = (n: number) => (counts.includes(n) ? n : counts.filter((c) => c <= n).pop() ?? counts[0]);

  const params = makeDefaults();
  fromHash(params, location.hash);
  params.sim.count = validCount(params.sim.count);

  const camera = new OrbitCamera();
  const particles = new ParticleSystem(device, params.sim.count);
  particles.seed(params.shape, false);
  const renderer = new Renderer(device, gpu.format);
  const timer = gpu.timestamps ? new GpuTimer(device) : undefined;

  const cursor = vec3.create();
  let simTime = 0;
  let pinAngle = 0;
  let stepOnce = false;
  let sized = false;
  /** The auto-rotate speed that A turns back on. */
  let spin = params.camera.autoRotate || 0.15;

  const shapeKey = () => JSON.stringify({ ...params.shape, morph: null });
  let seededShape = shapeKey();

  /** Brings the GPU side in line with params: buffer size and seed shape. */
  function sync() {
    params.sim.count = validCount(params.sim.count);
    if (params.sim.count !== particles.count) {
      particles.allocate(params.sim.count);
      particles.seed(params.shape, false);
      chrome.toast(`${countLabel(params.sim.count)} particles`);
    } else if (shapeKey() !== seededShape) {
      particles.seed(params.shape, params.shape.morph);
    }
    seededShape = shapeKey();
    stats.pins = params.pins.list.length;
  }

  let hashTimer = 0;
  function writeHash() {
    const hash = toHash(params);
    history.replaceState(null, '', location.pathname + location.search + (hash ? `#${hash}` : ''));
  }
  function changed() {
    sync();
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(writeHash, 300);
  }

  function reseed() {
    particles.seed(params.shape, false);
    seededShape = shapeKey();
  }

  function loadPatch(patch: unknown, presetIndex: number, message: string) {
    applyPreset(params, patch as never);
    sync();
    reseed();
    simTime = 0;
    pinAngle = 0;
    ui.setPreset(presetIndex);
    changed();
    chrome.toast(message);
  }

  const actions: Actions = {
    togglePause() {
      params.sim.paused = !params.sim.paused;
      ui.refresh();
      changed();
    },
    stepOnce() {
      if (!params.sim.paused) actions.togglePause();
      stepOnce = true;
    },
    reseed,
    morph() {
      particles.seed(params.shape, true);
      if (params.forces.homeSpring === 0) chrome.toast('Morph moves the home shape. Raise the home spring to see particles travel.', 3200);
    },
    toggleUi: () => chrome.setUi(!chrome.uiVisible),
    toggleHelp: () => chrome.setHelp(!chrome.helpVisible),
    dismiss() {
      if (!chrome.uiVisible) chrome.setUi(true);
      else if (chrome.helpVisible) chrome.setHelp(false);
    },
    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (!document.fullscreenEnabled) chrome.toast('This browser has no full screen for pages');
      else document.documentElement.requestFullscreen().catch(() => chrome.toast('Full screen was refused'));
    },
    toggleFollow() {
      params.camera.follow = !params.camera.follow;
      ui.refresh();
      changed();
    },
    toggleAutoRotate() {
      const c = params.camera;
      if (c.autoRotate) spin = c.autoRotate;
      c.autoRotate = c.autoRotate ? 0 : spin;
      ui.refresh();
      changed();
      chrome.toast(c.autoRotate ? 'Auto-rotate on' : 'Auto-rotate off');
    },
    resetCamera: () => camera.reset(),
    preset(index) {
      if (index < PRESETS.length) loadPatch(PRESETS[index].patch, index, `${PRESETS[index].name}`);
    },
    setTool(tool) {
      params.cursor.tool = tool;
      ui.refresh();
      changed();
    },
    nudgeDepth(direction) {
      params.cursor.depth = clamp(params.cursor.depth + direction * 0.05 * camera.distance, -10, 10);
      ui.refresh();
      changed();
    },
    pin(invert) {
      if (params.pins.list.length >= MAX_PINS) {
        chrome.toast(`All ${MAX_PINS} pins are in use. Backspace removes the last one.`, 2600);
        return;
      }
      const t = params.cursor.tool;
      const tool = invert && t < 2 ? 1 - t : t;
      const base = rotateY({ x: cursor[0], y: cursor[1], z: cursor[2] }, -pinAngle);
      params.pins.list.push({ ...base, tool });
      changed();
      ui.refresh();
      chrome.toast(`Pinned ${TOOL_NAMES[tool].toLowerCase()} attractor ${params.pins.list.length} of ${MAX_PINS}`);
    },
    removePin() {
      if (!params.pins.list.length) return;
      params.pins.list.pop();
      changed();
      ui.refresh();
      chrome.toast('Removed the last pin');
    },
    clearPins() {
      const n = params.pins.list.length;
      params.pins.list = [];
      changed();
      ui.refresh();
      chrome.toast(n ? `Cleared ${n} pin${n === 1 ? '' : 's'}` : 'No pins yet. Ctrl+click to pin an attractor.');
    },
  };

  const chrome = new Chrome(actions, gpu.timestamps);
  const ui = new Ui(params, gpu.maxParticles, gpu.timestamps, {
    reseed,
    morph: actions.morph,
    preset: actions.preset,
    clearPins: actions.clearPins,
    resetCamera: actions.resetCamera,
    changed,
    copyLink() {
      writeHash();
      navigator.clipboard?.writeText(location.href).then(
        () => chrome.toast('Link copied'),
        () => chrome.toast('Could not copy. The address bar has the link.'),
      );
    },
    saveJson() {
      const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'particles.json';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    loadJson() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          loadPatch(JSON.parse(await file.text()), 0, `Loaded ${file.name}`);
        } catch (e) {
          showError(`Could not load ${file.name}: ${e instanceof Error ? e.message : e}`);
        }
      };
      input.click();
    },
  });
  stats.pins = params.pins.list.length;
  ui.refresh();

  const input = new Input(canvas, camera, actions);
  const nav = new Navigator(camera, input, actions);
  // The controls card is for the first look; '?' brings it back.
  canvas.addEventListener('pointerdown', () => chrome.setHelp(false), { once: true });

  function resize() {
    const dpr = window.devicePixelRatio * params.render.resolution;
    const max = device.limits.maxTextureDimension2D;
    const w = clamp(Math.round(canvas.clientWidth * dpr), 1, max);
    const h = clamp(Math.round(canvas.clientHeight * dpr), 1, max);
    if (sized && w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    renderer.resize(w, h);
    sized = true;
  }

  function markers(cursorOn: boolean, pins: Pin[]): Marker[] {
    if (!chrome.uiVisible) return [];
    const scale = window.devicePixelRatio * params.render.resolution;
    const out: Marker[] = pins.map((p) => ({
      pos: [p.x, p.y, p.z],
      radius: 6 * scale,
      filled: true,
      color: [...TOOL_COLORS[p.tool], 0.8],
    }));
    // While the camera is steered, mark the point it turns and zooms around.
    const pivot = clamp((1.2 - camera.idle) / 0.6, 0, 1);
    if (pivot > 0) {
      out.push({ pos: camera.target, radius: 5 * scale, filled: true, color: [...PIVOT_COLOR, 0.75 * pivot] });
    }
    const tool = input.shift && params.cursor.tool < 2 ? 1 - params.cursor.tool : params.cursor.tool;
    out.push({
      pos: cursor,
      radius: 11 * scale,
      filled: cursorOn,
      color: [...TOOL_COLORS[tool], cursorOn ? 0.9 : 0.35],
    });
    return out;
  }

  /** One frame: advance the simulation by dt (unless paused) and draw. */
  function frame(dt: number) {
    resize();
    const p = params;
    camera.drive(input.drive(), dt);
    camera.update(dt, p.camera.damping, p.camera.autoRotate, p.camera.fov, canvas.width / canvas.height);
    if (p.camera.follow && particles.centroid) camera.follow(particles.centroid, dt);
    nav.update(camera, p);
    camera.cursorPoint(input.ndcX, input.ndcY, p.cursor.depth, cursor);
    const cursorOn = input.forceHeld || (p.cursor.hover && input.hovering);

    const running = !p.sim.paused || stepOnce;
    const simDt = (p.sim.paused ? 1 / 60 : Math.min(dt, 1 / 30)) * p.sim.timeScale;
    stepOnce = false;
    if (running) {
      simTime += simDt;
      pinAngle += p.pins.orbit * simDt;
    }
    const pins = p.pins.list.map((pin) => ({ ...rotateY(pin, pinAngle), tool: pin.tool }));

    const encoder = device.createCommandEncoder({ label: 'frame' });
    if (running) {
      particles.update(p, { dt: simDt, time: simTime, cursor, cursorOn, invert: input.shift, axis: camera.forward, pins });
      particles.step(encoder, timer?.sim);
    }
    if (p.camera.follow) particles.requestCentroid(encoder);
    renderer.render(encoder, context.getCurrentTexture().createView(), particles, {
      params: p,
      camera,
      cursor,
      trailDecay: p.render.clearOnCamera && camera.moving ? 0 : p.render.trail,
      markers: markers(cursorOn, pins),
      pixelScale: window.devicePixelRatio * p.render.resolution,
      timer,
    });
    timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    particles.collectCentroid();
    timer?.collect(running);
  }

  let hudAge = 0;
  function updateStats(dt: number) {
    chrome.sync(params, input.shift);
    stats.frameMs = stats.frameMs * 0.9 + dt * 1000 * 0.1;
    stats.fps = 1000 / Math.max(stats.frameMs, 1e-3);
    if (timer) {
      stats.simMs = timer.simMs;
      stats.renderMs = timer.renderMs;
    }
    hudAge += dt;
    if (hudAge < 0.25) return;
    hudAge = 0;
    chrome.stats(stats.fps, particles.count, stats.simMs, stats.renderMs);
  }

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frame(dt);
    updateStats(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  chrome.ready();

  if (import.meta.env.DEV) {
    // Lets scripts drive frames where requestAnimationFrame never fires (hidden automation tabs).
    Object.assign(window, {
      particles: {
        params,
        camera,
        input,
        actions,
        stats,
        step(frames = 60, dt = 1 / 60) {
          for (let i = 0; i < frames; i++) {
            frame(dt);
            updateStats(dt);
          }
          return device.queue.onSubmittedWorkDone();
        },
        get centroid() {
          return particles.centroid;
        },
        sync() {
          changed();
          ui.refresh();
        },
      },
    });
  }
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
