// Every tweakable value lives in one params object. The panel binds to it, presets and the
// URL hash are diffs against the defaults, and each frame packs it into GPU uniforms.

export interface RGB { r: number; g: number; b: number }
export interface Pin { x: number; y: number; z: number; tool: number }

export const SHAPES = { Sphere: 0, 'Sphere shell': 1, Cube: 2, Galaxy: 3, Torus: 4, 'Gaussian cloud': 5 };
export const TOOLS = { Attract: 0, Repel: 1, Swirl: 2 };
export const TOOL_NAMES = ['Attract', 'Repel', 'Swirl'];
export const BOUNDS = { None: 0, 'Wrap (box)': 1, 'Bounce (box)': 2, 'Bounce (sphere)': 3 };
export const RENDER_MODES = { 'Points (1px)': 0, Sprites: 1, Streaks: 2 };
export const COLOR_MODES = { Speed: 0, Direction: 1, Depth: 2, 'Cursor distance': 3, 'Palette (random)': 4 };
export const MAX_PINS = 16;
export const COUNTS = [1 << 16, 1 << 18, 1 << 19, 1 << 20, 1 << 21, 1 << 22, 1 << 23, 1 << 24];

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

export const PALETTES: Record<string, [RGB, RGB, RGB]> = {
  Ember: [rgb(0.55, 0.06, 0.02), rgb(1.0, 0.45, 0.08), rgb(1.0, 0.92, 0.7)],
  Ice: [rgb(0.03, 0.12, 0.45), rgb(0.2, 0.6, 1.0), rgb(0.85, 0.97, 1.0)],
  Neon: [rgb(0.45, 0.0, 0.85), rgb(1.0, 0.1, 0.55), rgb(0.1, 1.0, 0.85)],
  Aurora: [rgb(0.0, 0.5, 0.35), rgb(0.1, 0.9, 0.5), rgb(0.6, 0.35, 1.0)],
  Galaxy: [rgb(1.0, 0.8, 0.5), rgb(1.0, 0.45, 0.6), rgb(0.35, 0.55, 1.0)],
  Mono: [rgb(0.5, 0.5, 0.5), rgb(0.8, 0.8, 0.8), rgb(1.0, 1.0, 1.0)],
};

export function makeDefaults() {
  const [colorA, colorB, colorC] = PALETTES.Ember.map((c) => ({ ...c }));
  return {
    sim: { count: 1 << 20, paused: false, timeScale: 1, substeps: 2 },
    shape: { shape: 0, size: 1, spin: 0, seed: 1, morph: false },
    cursor: { tool: 0, strength: 3, swirlPull: 0.3, hover: false, depth: 0 },
    pins: { strength: 2, swirlPull: 0.3, orbit: 0, list: [] as Pin[] },
    forces: {
      falloff: 1,
      softening: 0.1,
      gravity: { x: 0, y: 0, z: 0 },
      drag: 0.4,
      maxSpeed: 20,
      noise: 0,
      noiseScale: 1,
      noiseSpeed: 0.2,
      homeSpring: 0,
    },
    bounds: { mode: 0, size: 3, restitution: 0.5 },
    render: {
      mode: 0,
      size: 0.006,
      streakLength: 0.05,
      streakWidth: 1,
      intensity: 0.02,
      exposure: 1,
      trail: 0.8,
      clearOnCamera: true,
      colorMode: 0,
      colorRange: 3,
      colorA,
      colorB,
      colorC,
      resolution: 1,
      gizmos: true,
    },
    bloom: { enabled: true, threshold: 0.8, intensity: 0.6, radius: 1 },
    camera: { fov: 50, autoRotate: 0, damping: 0.08, follow: false },
  };
}

export type Params = ReturnType<typeof makeDefaults>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ParamsPatch = DeepPartial<Params>;

const pal = (name: keyof typeof PALETTES) => {
  const [colorA, colorB, colorC] = PALETTES[name];
  return { colorA, colorB, colorC };
};

export const PRESETS: { name: string; patch: ParamsPatch }[] = [
  { name: 'Gravity well', patch: {} },
  {
    name: 'Galaxy',
    patch: {
      shape: { shape: 3, size: 1.6, spin: 1 },
      cursor: { strength: 1.5 },
      pins: { strength: 1, list: [{ x: 0, y: 0, z: 0, tool: 0 }] },
      forces: { drag: 0, softening: 0.15 },
      render: { trail: 0.9, colorMode: 4, intensity: 0.008, ...pal('Galaxy') },
    },
  },
  {
    name: 'Curl flow',
    patch: {
      shape: { shape: 5, size: 1.5 },
      forces: { noise: 2, noiseScale: 0.8, noiseSpeed: 0.15, homeSpring: 1.2, drag: 1 },
      render: { mode: 1, size: 0.004, intensity: 0.04, trail: 0.7, colorMode: 1 },
    },
  },
  {
    name: 'Light painting',
    patch: {
      shape: { shape: 1 },
      cursor: { strength: 4, hover: true },
      forces: { falloff: 0.5, drag: 1.2, noise: 1.5, noiseScale: 1.5 },
      render: { trail: 0.97, intensity: 0.003, colorMode: 1 },
      bloom: { intensity: 0.4 },
    },
  },
  {
    name: 'Sandbox',
    patch: {
      shape: { shape: 2, size: 0.8 },
      cursor: { tool: 1, strength: 6 },
      forces: { gravity: { x: 0, y: -3, z: 0 }, drag: 0.2 },
      bounds: { mode: 2, size: 1.5, restitution: 0.4 },
      render: { trail: 0.5, colorRange: 4, ...pal('Ice') },
    },
  },
  {
    name: 'Elastic torus',
    patch: {
      shape: { shape: 4, size: 1.4 },
      cursor: { tool: 1, strength: 4, hover: true },
      forces: { homeSpring: 6, drag: 2.5, falloff: 2, softening: 0.15 },
      render: { trail: 0.6, colorRange: 2, ...pal('Aurora') },
    },
  },
  {
    name: 'Whirlpool',
    patch: {
      shape: { shape: 5, size: 1.2 },
      cursor: { tool: 2, strength: 4, swirlPull: 0.6, hover: true },
      forces: { noise: 0.5, drag: 0.6 },
      render: { mode: 2, intensity: 0.08, trail: 0.6, ...pal('Neon') },
    },
  },
  {
    name: 'Nebula',
    patch: {
      shape: { shape: 5, size: 2 },
      forces: { noise: 1.5, noiseScale: 0.5, noiseSpeed: 0.05, drag: 1.5, homeSpring: 0.2 },
      render: { mode: 1, size: 0.03, intensity: 0.008, trail: 0, colorMode: 2, colorRange: 4, ...pal('Aurora') },
      bloom: { threshold: 0.5, intensity: 1.2, radius: 1.5 },
    },
  },
  {
    name: 'Black hole',
    patch: {
      shape: { shape: 3, size: 1.8, spin: 1.2 },
      pins: { strength: 1.5, list: [{ x: 0, y: 0, z: 0, tool: 0 }] },
      forces: { drag: 0, falloff: 1, softening: 0.03 },
      render: { mode: 2, streakLength: 0.08, intensity: 0.12, trail: 0.3, colorRange: 4, ...pal('Ember') },
      bloom: { intensity: 1 },
    },
  },
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Copies `src` into `target` in place. Nested objects stay the same objects, because the
 * panel holds references to them. Unknown keys and mismatched types are ignored, so an old
 * URL can't break the app.
 */
export function mergeInto(target: Record<string, unknown>, src: unknown): void {
  if (!isObject(src)) return;
  for (const [key, value] of Object.entries(src)) {
    if (!(key in target)) continue;
    const current = target[key];
    if (isObject(current)) mergeInto(current, value);
    else if (Array.isArray(current) && Array.isArray(value)) target[key] = structuredClone(value);
    else if (typeof current === typeof value) target[key] = value;
  }
}

/** The values in `current` that differ from `base`, as a nested patch. */
export function diff(current: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const b = base[key];
    if (isObject(value) && isObject(b)) {
      const d = diff(value, b);
      if (Object.keys(d).length) out[key] = d;
    } else if (JSON.stringify(value) !== JSON.stringify(b)) {
      out[key] = value;
    }
  }
  return out;
}

/** Resets params to defaults plus the preset, keeping the values that suit this machine. */
export function applyPreset(params: Params, patch: ParamsPatch): void {
  const keep = { count: params.sim.count, resolution: params.render.resolution };
  params.pins.list = [];
  mergeInto(params, makeDefaults());
  mergeInto(params, patch);
  if (patch.sim?.count === undefined) params.sim.count = keep.count;
  params.render.resolution = keep.resolution;
}

export function toHash(params: Params): string {
  const d = diff(params, makeDefaults());
  if (!Object.keys(d).length) return '';
  return btoa(JSON.stringify(d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromHash(params: Params, hash: string): void {
  const s = hash.replace(/^#/, '');
  if (!s) return;
  try {
    mergeInto(params, JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    console.warn('Ignoring an unreadable URL hash');
  }
}
