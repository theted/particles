import { Pane, type BindingParams, type FolderApi } from 'tweakpane';
import {
  BOUNDS,
  COLOR_MODES,
  COUNTS,
  PALETTES,
  PRESETS,
  RENDER_MODES,
  SHAPES,
  TOOLS,
  type Params,
} from './params';

export interface UiActions {
  reseed(): void;
  morph(): void;
  preset(index: number): void;
  clearPins(): void;
  resetCamera(): void;
  copyLink(): void;
  saveJson(): void;
  loadJson(): void;
  /** Any value in the panel changed. */
  changed(): void;
}

export const stats = { fps: 0, frameMs: 0, simMs: 0, renderMs: 0, pins: 0 };

export const countLabel = (n: number) => (n >= 1 << 20 ? `${n / (1 << 20)}M` : `${n / 1024}k`);

/** The Tweakpane control panel, bound directly to the params object. */
export class Ui {
  readonly pane: Pane;
  private readonly state = { preset: 0, palette: 'Ember' };
  private refreshing = false;

  constructor(params: Params, maxParticles: number, timestamps: boolean, actions: UiActions) {
    const container = document.getElementById('panel-scroll') as HTMLElement;
    const pane = new Pane({ title: 'Particles', container });
    this.pane = pane;
    // Change handlers go on each input binding: pane-level 'change' also fires for monitor
    // updates (the fps graph), which would keep the URL-hash debounce from ever settling.
    const bind = <O extends object>(folder: FolderApi, obj: O, key: keyof O & string, opts?: BindingParams) =>
      folder.addBinding(obj, key, opts).on('change', () => {
        if (!this.refreshing) actions.changed();
      });

    pane
      .addBinding(this.state, 'preset', {
        label: 'preset',
        options: Object.fromEntries(PRESETS.map((p, i) => [`${i + 1}. ${p.name}`, i])),
      })
      .on('change', (ev) => {
        if (!this.refreshing) actions.preset(ev.value);
      });

    const sim = pane.addFolder({ title: 'Simulation' });
    const counts = COUNTS.filter((n) => n <= maxParticles);
    bind(sim, params.sim, 'count', {
      label: 'particles',
      options: Object.fromEntries(counts.map((n) => [countLabel(n), n])),
    });
    bind(sim, params.sim, 'paused');
    bind(sim, params.sim, 'timeScale', { label: 'time scale', min: 0, max: 4, step: 0.05 });
    bind(sim, params.sim, 'substeps', { min: 1, max: 8, step: 1 });

    const shape = pane.addFolder({ title: 'Shape' });
    bind(shape, params.shape, 'shape', { options: SHAPES });
    bind(shape, params.shape, 'size', { min: 0.1, max: 5, step: 0.05 });
    bind(shape, params.shape, 'spin', { min: -5, max: 5, step: 0.05 });
    bind(shape, params.shape, 'seed', { min: 1, max: 999, step: 1 });
    bind(shape, params.shape, 'morph', { label: 'morph on change' });
    shape.addButton({ title: 'Reseed (R)' }).on('click', actions.reseed);
    shape.addButton({ title: 'Morph to shape (M)' }).on('click', actions.morph);

    const cursor = pane.addFolder({ title: 'Cursor tool' });
    bind(cursor, params.cursor, 'tool', { options: TOOLS });
    bind(cursor, params.cursor, 'strength', { min: 0, max: 30, step: 0.1 });
    bind(cursor, params.cursor, 'swirlPull', { label: 'swirl pull', min: 0, max: 1, step: 0.01 });
    bind(cursor, params.cursor, 'hover', { label: 'always on' });
    bind(cursor, params.cursor, 'depth', { min: -10, max: 10, step: 0.05 });

    const pins = pane.addFolder({ title: 'Pinned attractors', expanded: false });
    pins.addBinding(stats, 'pins', { readonly: true, format: (v) => `${v} (Ctrl+click)` });
    bind(pins, params.pins, 'strength', { min: 0, max: 30, step: 0.1 });
    bind(pins, params.pins, 'swirlPull', { label: 'swirl pull', min: 0, max: 1, step: 0.01 });
    bind(pins, params.pins, 'orbit', { label: 'orbit speed', min: -2, max: 2, step: 0.01 });
    pins.addButton({ title: 'Clear pins (X)' }).on('click', actions.clearPins);

    const forces = pane.addFolder({ title: 'Forces' });
    bind(forces, params.forces, 'falloff', { label: 'falloff 1/rᵏ', min: 0, max: 3, step: 0.05 });
    bind(forces, params.forces, 'softening', { min: 0.005, max: 1, step: 0.005 });
    bind(forces, params.forces, 'gravity', {
      x: { min: -10, max: 10 },
      y: { min: -10, max: 10 },
      z: { min: -10, max: 10 },
    });
    bind(forces, params.forces, 'drag', { min: 0, max: 5, step: 0.01 });
    bind(forces, params.forces, 'maxSpeed', { label: 'max speed', min: 0.1, max: 50, step: 0.1 });
    bind(forces, params.forces, 'noise', { label: 'turbulence', min: 0, max: 10, step: 0.05 });
    bind(forces, params.forces, 'noiseScale', { label: 'turb. scale', min: 0.05, max: 5, step: 0.05 });
    bind(forces, params.forces, 'noiseSpeed', { label: 'turb. speed', min: 0, max: 2, step: 0.01 });
    bind(forces, params.forces, 'homeSpring', { label: 'home spring', min: 0, max: 20, step: 0.05 });

    const bounds = pane.addFolder({ title: 'Bounds', expanded: false });
    bind(bounds, params.bounds, 'mode', { options: BOUNDS });
    bind(bounds, params.bounds, 'size', { label: 'half size', min: 0.2, max: 20, step: 0.1 });
    bind(bounds, params.bounds, 'restitution', { min: 0, max: 1, step: 0.01 });

    const render = pane.addFolder({ title: 'Render' });
    bind(render, params.render, 'mode', { options: RENDER_MODES });
    bind(render, params.render, 'size', { label: 'sprite size', min: 0.001, max: 0.1, step: 0.001 });
    bind(render, params.render, 'streakLength', { label: 'streak length', min: 0.005, max: 0.5, step: 0.005 });
    bind(render, params.render, 'streakWidth', { label: 'streak width', min: 0.5, max: 6, step: 0.1 });
    bind(render, params.render, 'intensity', { label: 'intensity /1M', min: 0.001, max: 2, step: 0.001 });
    bind(render, params.render, 'exposure', { min: 0.05, max: 8, step: 0.05 });
    bind(render, params.render, 'trail', { min: 0, max: 0.995, step: 0.005 });
    bind(render, params.render, 'clearOnCamera', { label: 'clear on orbit' });
    bind(render, params.render, 'colorMode', { label: 'color by', options: COLOR_MODES });
    bind(render, params.render, 'colorRange', { label: 'color range', min: 0.05, max: 20, step: 0.05 });
    render
      .addBinding(this.state, 'palette', { options: Object.fromEntries(Object.keys(PALETTES).map((k) => [k, k])) })
      .on('change', (ev) => {
        if (this.refreshing) return;
        const [a, b, c] = PALETTES[ev.value];
        Object.assign(params.render.colorA, a);
        Object.assign(params.render.colorB, b);
        Object.assign(params.render.colorC, c);
        this.refresh();
        actions.changed();
      });
    for (const key of ['colorA', 'colorB', 'colorC'] as const) {
      bind(render, params.render, key, { label: key.replace('color', 'color '), color: { type: 'float' } });
    }
    bind(render, params.render, 'resolution', { label: 'resolution', min: 0.25, max: 1, step: 0.05 });
    bind(render, params.render, 'gizmos');

    const bloom = pane.addFolder({ title: 'Bloom', expanded: false });
    bind(bloom, params.bloom, 'enabled');
    bind(bloom, params.bloom, 'threshold', { min: 0, max: 5, step: 0.05 });
    bind(bloom, params.bloom, 'intensity', { min: 0, max: 3, step: 0.05 });
    bind(bloom, params.bloom, 'radius', { min: 0.5, max: 3, step: 0.05 });

    const camera = pane.addFolder({ title: 'Camera', expanded: false });
    bind(camera, params.camera, 'fov', { min: 20, max: 110, step: 1 });
    bind(camera, params.camera, 'autoRotate', { label: 'auto rotate', min: -1, max: 1, step: 0.01 });
    bind(camera, params.camera, 'damping', { min: 0, max: 0.5, step: 0.01 });
    bind(camera, params.camera, 'follow', { label: 'follow swarm (F)' });
    camera.addButton({ title: 'Reset view (C)' }).on('click', actions.resetCamera);

    const perf = pane.addFolder({ title: 'Performance', expanded: false });
    perf.addBinding(stats, 'fps', { readonly: true, view: 'graph', min: 0, max: 150, interval: 250 });
    perf.addBinding(stats, 'frameMs', { label: 'frame ms', readonly: true, format: (v) => v.toFixed(2), interval: 250 });
    if (timestamps) {
      perf.addBinding(stats, 'simMs', { label: 'gpu sim ms', readonly: true, format: (v) => v.toFixed(2), interval: 250 });
      perf.addBinding(stats, 'renderMs', { label: 'gpu draw ms', readonly: true, format: (v) => v.toFixed(2), interval: 250 });
    }

    const files = pane.addFolder({ title: 'Save & share', expanded: false });
    files.addButton({ title: 'Copy link' }).on('click', actions.copyLink);
    files.addButton({ title: 'Save JSON' }).on('click', actions.saveJson);
    files.addButton({ title: 'Load JSON' }).on('click', actions.loadJson);

  }

  setPreset(index: number): void {
    this.state.preset = index;
    this.refresh();
  }

  /** Re-reads params into the panel without treating it as a user change. */
  refresh(): void {
    this.refreshing = true;
    this.pane.refresh();
    this.refreshing = false;
  }
}
