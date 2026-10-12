import type { OrbitCamera } from './camera';

export interface Actions {
  togglePause(): void;
  stepOnce(): void;
  reseed(): void;
  morph(): void;
  toggleUi(): void;
  toggleHelp(): void;
  toggleFollow(): void;
  resetCamera(): void;
  preset(index: number): void;
  setTool(tool: number): void;
  nudgeDepth(direction: number): void;
  pin(invert: boolean): void;
  removePin(): void;
  clearPins(): void;
}

/**
 * Mouse and keyboard. Camera and forces never share an input:
 * - left button: the force tool (Shift inverts it; Ctrl+click pins an attractor)
 * - right button: orbit (Shift+right or the middle button: pan)
 * - wheel: zoom (Alt+wheel: cursor depth)
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

  constructor(canvas: HTMLCanvasElement, camera: OrbitCamera, actions: Actions) {
    const track = (e: PointerEvent) => {
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
      this.hovering = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
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
      track(e);
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.drag === 'orbit') camera.orbit(dx, dy);
      else if (this.drag === 'pan') camera.pan(dx, dy, canvas.clientHeight);
    });

    const release = (e: PointerEvent) => {
      if (e.button === 0) this.forceHeld = false;
      else this.drag = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => {
      this.forceHeld = false;
      this.drag = null;
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY || e.deltaX;
        if (e.altKey) actions.nudgeDepth(-Math.sign(delta));
        else camera.zoom(delta);
      },
      { passive: false },
    );

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shift = false;
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.shift = true;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      // A focused button handles its own Space and Enter.
      if (t?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const handled = (() => {
        switch (key) {
          case ' ': actions.togglePause(); return true;
          case '.': actions.stepOnce(); return true;
          case 'r': actions.reseed(); return true;
          case 'm': actions.morph(); return true;
          case 'h': actions.toggleUi(); return true;
          case '?': actions.toggleHelp(); return true;
          case 'f': actions.toggleFollow(); return true;
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
}
