import type { OrbitCamera } from './camera';
import type { Actions, Hold, Input } from './input';
import type { Params } from './params';

const SVG = 'http://www.w3.org/2000/svg';
/** Length of an axis on the compass, in viewBox units (the box is 100 across). */
const REACH = 31;
/** Pixels a press can wander before it counts as a drag, not a click. */
const SLOP = 4;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

interface Axis {
  group: SVGGElement;
  stem?: SVGLineElement;
  axis: number;
  sign: number;
}

/**
 * Pointer drags with capture: `move` gets each step in pixels and whether the press has
 * become a drag, `end` whether it ever did.
 */
function draggable(
  el: Element,
  move: (dx: number, dy: number, e: PointerEvent) => void,
  end?: (dragged: boolean, e: PointerEvent) => void,
) {
  let start: { x: number; y: number } | null = null;
  let last = { x: 0, y: 0 };
  let dragged = false;
  el.addEventListener('pointerdown', (e) => {
    const p = e as PointerEvent;
    if (p.button !== 0) return;
    el.setPointerCapture(p.pointerId);
    start = last = { x: p.clientX, y: p.clientY };
    dragged = false;
  });
  el.addEventListener('pointermove', (e) => {
    const p = e as PointerEvent;
    if (!start) return;
    if (!dragged && Math.hypot(p.clientX - start.x, p.clientY - start.y) < SLOP) return;
    dragged = true;
    move(p.clientX - last.x, p.clientY - last.y, p);
    last = { x: p.clientX, y: p.clientY };
  });
  const stop = (e: Event) => {
    if (!start) return;
    start = null;
    end?.(dragged, e as PointerEvent);
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

/**
 * The camera controls in the corner: a compass of the world axes that turns with the view
 * (drag it to orbit, click an axis to look along it) and buttons to zoom, pan, auto-rotate
 * and reset the view.
 */
export class Navigator {
  private readonly axes: Axis[] = [];
  private readonly compass: SVGSVGElement;
  private readonly spin: HTMLElement;
  private lastBasis = '';
  private lastOrder = '';
  private lastSpin = '';

  constructor(camera: OrbitCamera, input: Input, actions: Pick<Actions, 'toggleAutoRotate' | 'resetCamera'>) {
    const byId = (id: string) => document.getElementById(id) as HTMLElement;
    this.compass = document.querySelector<SVGSVGElement>('#nav-compass')!;
    this.spin = byId('nav-spin');

    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        const name = `${sign > 0 ? '' : '−'}${'XYZ'[axis]}`;
        const group = svg('g', { class: `axis axis-${'xyz'[axis]} ${sign > 0 ? 'pos' : 'neg'}`, 'data-axis': axis, 'data-sign': sign });
        const title = svg('title');
        title.textContent = `Look from ${name}`;
        const stem = sign > 0 ? svg('line', { class: 'stem', x1: 0, y1: 0, x2: 0, y2: 0 }) : undefined;
        if (stem) group.append(stem);
        group.append(title, svg('circle', { r: sign > 0 ? 9 : 6.5 }));
        if (sign > 0) {
          const label = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
          label.textContent = 'XYZ'[axis];
          group.append(label);
        }
        this.compass.append(group);
        this.axes.push({ group, stem, axis, sign });
      }
    }

    // Dragging the compass grabs the scene; a click on an axis looks along it.
    let picked: Axis | undefined;
    this.compass.addEventListener('pointerdown', (e) => {
      const g = (e.target as Element).closest('[data-axis]');
      picked = this.axes.find((a) => a.group === g);
    });
    draggable(
      this.compass,
      (dx, dy) => camera.orbit(dx * 2, dy * 2),
      (dragged) => {
        if (!dragged && picked) camera.lookFrom(picked.axis, picked.sign);
        picked = undefined;
      },
    );

    draggable(byId('nav-pan'), (dx, dy) => camera.pan(dx, dy, window.innerHeight));

    // Zoom while held. A keyboard press (no pointer) zooms one step.
    for (const button of document.querySelectorAll<HTMLButtonElement>('#nav [data-hold]')) {
      const control = button.dataset.hold as Hold;
      const release = () => input.hold('nav', null);
      button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        button.setPointerCapture(e.pointerId);
        input.hold('nav', control);
      });
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
      button.addEventListener('click', (e) => {
        if (e.detail === 0) camera.zoomBy(control === 'in' ? 0.8 : 1.25);
      });
    }

    this.spin.addEventListener('click', actions.toggleAutoRotate);
    byId('nav-home').addEventListener('click', actions.resetCamera);
  }

  /** Turns the compass with the camera. Cheap to call every frame. */
  update(camera: OrbitCamera, params: Params): void {
    const spin = String(params.camera.autoRotate !== 0);
    if (spin !== this.lastSpin) {
      this.lastSpin = spin;
      this.spin.setAttribute('aria-pressed', spin);
    }

    const { right, up, forward } = camera;
    const basis = [...right, ...up, ...forward].map((v) => v.toFixed(4)).join();
    if (basis === this.lastBasis) return;
    this.lastBasis = basis;

    // Each world axis seen from the camera: across, up the screen, and toward the viewer.
    const placed = this.axes.map((a) => {
      const x = right[a.axis] * a.sign * REACH;
      const y = -up[a.axis] * a.sign * REACH;
      const near = -forward[a.axis] * a.sign;
      a.group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      a.stem?.setAttribute('x1', (-x).toFixed(2));
      a.stem?.setAttribute('y1', (-y).toFixed(2));
      a.group.style.opacity = (0.62 + 0.38 * near).toFixed(3);
      return { a, near };
    });
    // Nearer axes draw on top. Reorder only when the order changes, so hover isn't disturbed.
    placed.sort((p, q) => p.near - q.near);
    const order = placed.map(({ a }) => this.axes.indexOf(a)).join();
    if (order === this.lastOrder) return;
    this.lastOrder = order;
    for (const { a } of placed) this.compass.append(a.group);
  }
}
