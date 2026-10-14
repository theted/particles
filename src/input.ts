import type { Drive, OrbitCamera } from './camera';

export interface Actions {
  togglePause(): void;
  stepOnce(): void;
  reseed(): void;
  morph(): void;
  toggleUi(): void;
  toggleHelp(): void;
  /** Esc: brings a hidden interface back, or closes the controls card. */
  dismiss(): void;
  toggleFullscreen(): void;
  toggleFollow(): void;
  toggleAutoRotate(): void;
  resetCamera(): void;
  preset(index: number): void;
  setTool(tool: number): void;
  nudgeDepth(direction: number): void;
  pin(invert: boolean): void;
  removePin(): void;
  clearPins(): void;
}

/** A camera control that acts for as long as it is held: arrow keys, +/− and the zoom buttons. */
export type Hold = 'left' | 'right' | 'up' | 'down' | 'in' | 'out';

const HOLD_KEYS: Record<string, Hold> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  '+': 'in',
  '=': 'in',
  '-': 'out',
  _: 'out',
};

interface Point {
  x: number;
  y: number;
}

/** Centre of a set of touch points, and their mean distance from it. */
function spread(points: Iterable<Point>) {
  const list = [...points];
  const x = list.reduce((s, p) => s + p.x, 0) / list.length;
  const y = list.reduce((s, p) => s + p.y, 0) / list.length;
  const r = list.reduce((s, p) => s + Math.hypot(p.x - x, p.y - y), 0) / list.length;
  return { x, y, r };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Mouse, touch and keyboard. Camera and forces never share an input:
 * - left button or one finger: the force tool (Shift inverts it; Ctrl+click pins an attractor)
 * - right button or two fingers: orbit (Shift+right, the middle button or three fingers: pan)
 * - wheel or pinch: zoom (Alt+wheel: cursor depth)
 * - arrow keys orbit (with Shift: pan), + and − zoom
 */
export class Input {
  ndcX = 0;
  ndcY = 0;
  hovering = false;
  forceHeld = false;
  shift = false;

  private drag: 'orbit' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;
  /** Fingers on the canvas. Two or more make a camera gesture until they all lift. */
  private readonly touches = new Map<number, Point>();
  private gesture = false;
  /** Held camera controls, keyed by what holds them (a key code or a button). */
  private readonly held = new Map<string, Hold>();

  constructor(canvas: HTMLCanvasElement, camera: OrbitCamera, actions: Actions) {
    const track = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const rect = canvas.getBoundingClientRect();
      this.ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      this.shift = e.shiftKey;
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerenter', () => (this.hovering = true));
    canvas.addEventListener('pointerleave', () => (this.hovering = false));

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      track(e);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size > 1) this.gesture = true;
        if (this.gesture) {
          this.forceHeld = false;
          this.hovering = false;
          return;
        }
      }
      this.hovering = true;
      if (e.button === 0) {
        if (e.ctrlKey || e.metaKey) actions.pin(e.shiftKey);
        else this.forceHeld = true;
      } else if (e.button === 2) {
        this.drag = e.shiftKey ? 'pan' : 'orbit';
      } else if (e.button === 1) {
        e.preventDefault();
        this.drag = 'pan';
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const finger = this.touches.get(e.pointerId);
      if (finger && this.gesture) {
        const before = spread(this.touches.values());
        finger.x = e.clientX;
        finger.y = e.clientY;
        const after = spread(this.touches.values());
        const [dx, dy] = [after.x - before.x, after.y - before.y];
        if (this.touches.size === 2) camera.orbit(dx, dy);
        else camera.pan(dx, dy, canvas.clientHeight);
        if (before.r > 0 && after.r > 0) camera.zoomBy(before.r / after.r);
        return;
      }
      track(e);
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.drag === 'orbit') camera.orbit(dx, dy);
      else if (this.drag === 'pan') camera.pan(dx, dy, canvas.clientHeight);
    });

    const lift = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (!this.touches.size) this.gesture = false;
    };
    canvas.addEventListener('pointerup', (e) => {
      lift(e);
      if (e.button === 0) this.forceHeld = false;
      else this.drag = null;
    });
    canvas.addEventListener('pointercancel', (e) => {
      lift(e);
      this.forceHeld = false;
      this.drag = null;
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Firefox reports mouse wheels in lines: about 100px a notch, as elsewhere.
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        const delta = (e.deltaY || e.deltaX) * unit;
        if (e.altKey) actions.nudgeDepth(-Math.sign(delta));
        // Trackpad pinches arrive as Ctrl+wheel with small deltas.
        else camera.zoom(clamp(e.ctrlKey ? delta * 6 : delta, -150, 150));
      },
      { passive: false },
    );

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shift = false;
      this.held.delete(e.code);
    });
    // Keys released while another window has focus never send keyup.
    window.addEventListener('blur', () => {
      this.held.clear();
      this.shift = false;
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.shift = true;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      // A focused button handles its own Space and Enter.
      if (t?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const hold = HOLD_KEYS[e.key];
      // In the panel, arrow keys belong to the focused slider.
      if (hold && !t?.closest('#panel')) {
        this.held.set(e.code, hold);
        e.preventDefault();
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const handled = (() => {
        switch (key) {
          case ' ': actions.togglePause(); return true;
          case '.': actions.stepOnce(); return true;
          case 'r': actions.reseed(); return true;
          case 'm': actions.morph(); return true;
          case 'h': actions.toggleUi(); return true;
          case '?': actions.toggleHelp(); return true;
          case 'Escape': actions.dismiss(); return true;
          case 'f': if (e.shiftKey) actions.toggleFullscreen(); else actions.toggleFollow(); return true;
          case 'a': actions.toggleAutoRotate(); return true;
          case 'c': actions.resetCamera(); return true;
          case 'q': actions.setTool(0); return true;
          case 'w': actions.setTool(1); return true;
          case 'e': actions.setTool(2); return true;
          case '[': actions.nudgeDepth(-1); return true;
          case ']': actions.nudgeDepth(1); return true;
          case 'x': actions.clearPins(); return true;
          case 'Backspace': actions.removePin(); return true;
        }
        if (key >= '1' && key <= '9') {
          actions.preset(Number(key) - 1);
          return true;
        }
        return false;
      })();
      if (handled) e.preventDefault();
    });
  }

  /** Holds a camera control down from somewhere other than a key, such as a button. */
  hold(source: string, control: Hold | null): void {
    if (control) this.held.set(source, control);
    else this.held.delete(source);
  }

  /** The camera motion held down right now. Shift turns orbiting into panning. */
  drive(): Drive {
    const on = new Set(this.held.values());
    const axis = (plus: Hold, minus: Hold) => Number(on.has(plus)) - Number(on.has(minus));
    return { x: axis('right', 'left'), y: axis('up', 'down'), zoom: axis('in', 'out'), pan: this.shift };
  }
}
