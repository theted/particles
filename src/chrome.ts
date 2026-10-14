import type { Params } from './params';
import { countLabel } from './ui';

export interface ChromeActions {
  setTool(tool: number): void;
  togglePause(): void;
  reseed(): void;
  toggleFollow(): void;
  clearPins(): void;
  toggleHelp(): void;
  toggleUi(): void;
  toggleFullscreen(): void;
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** How long the pointer rests before it (and, with the interface hidden, the reveal pill) fades. */
const IDLE_MS = 2000;
/** With the interface hidden, the pointer this close to the bottom edge brings up the reveal pill. */
const PEEK_PX = 140;

/**
 * Everything around the canvas except the Tweakpane panel and the camera navigator: the
 * readout, the tool dock, the controls card, toasts and hiding it all. The page markup
 * lives in index.html; this keeps it in step with params.
 */
export class Chrome {
  private readonly body = document.body;
  private readonly canvas = byId<HTMLCanvasElement>('view');
  private readonly tools = [...document.querySelectorAll<HTMLButtonElement>('#dock [data-tool]')];
  private readonly swirl = document.querySelector('#dock .swirl') as SVGElement;
  private readonly fps = byId('hud-fps');
  private readonly count = byId('hud-count');
  private readonly sim = byId('hud-sim');
  private readonly draw = byId('hud-draw');
  private readonly paused = byId('hud-paused');
  private readonly following = byId('hud-follow');
  private readonly pause = byId('btn-pause');
  private readonly follow = byId('btn-follow');
  private readonly help = byId('btn-help');
  private readonly pinCount = byId('pin-count');
  private readonly toastEl = byId('toast');
  private toastTimer = 0;
  private idleTimer = 0;
  private hintTimer = 0;
  private lastState = '';

  constructor(actions: ChromeActions, timestamps: boolean) {
    byId('hud-gpu').hidden = !timestamps;
    for (const b of this.tools) b.addEventListener('click', () => actions.setTool(Number(b.dataset.tool)));
    const click = (id: string, fn: () => void) => byId(id).addEventListener('click', fn);
    click('btn-pause', actions.togglePause);
    click('btn-reseed', actions.reseed);
    click('btn-follow', actions.toggleFollow);
    click('btn-pins', actions.clearPins);
    click('btn-help', actions.toggleHelp);
    click('btn-fullscreen', actions.toggleFullscreen);
    click('btn-hide', actions.toggleUi);
    click('reveal', actions.toggleUi);

    const fullscreen = byId('btn-fullscreen');
    fullscreen.hidden = !document.fullscreenEnabled;
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      this.body.classList.toggle('fullscreen', on);
      fullscreen.setAttribute('aria-pressed', String(on));
      fullscreen.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
      fullscreen.dataset.tip = on ? 'Leave full screen (Shift+F)' : 'Full screen (Shift+F)';
    });

    // A mouse click must not leave focus on a button: Space and Enter would then press it
    // again instead of reaching the keyboard shortcuts. Keyboard focus still works.
    for (const root of [byId('dock'), byId('panel'), byId('nav'), byId('reveal')]) {
      root.addEventListener('mousedown', (e) => {
        if ((e.target as Element).closest('button')) e.preventDefault();
      });
    }

    // A resting pointer fades out; with the interface hidden, moving to the bottom edge
    // (where the dock was) offers a way back.
    const wake = (e: PointerEvent) => {
      this.body.classList.toggle('idle', false);
      this.body.classList.toggle('peek', e.clientY > window.innerHeight - PEEK_PX);
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => this.body.classList.add('idle'), IDLE_MS);
    };
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
  }

  /** Call once the first frame is on screen: the chrome settles in. */
  ready(): void {
    requestAnimationFrame(() => this.body.classList.remove('booting'));
  }

  /** Mirrors params into the dock and badges. Cheap to call every frame. */
  sync(p: Params, invert: boolean): void {
    const tool = p.cursor.tool;
    const lit = invert && tool < 2 ? 1 - tool : tool;
    const state = [lit, invert && tool === 2, p.sim.paused, p.camera.follow, p.pins.list.length, p.render.gizmos].join();
    if (state === this.lastState) return;
    this.lastState = state;

    this.tools.forEach((b, i) => b.setAttribute('aria-checked', String(i === lit)));
    this.swirl.classList.toggle('reversed', invert && tool === 2);
    this.body.classList.toggle('paused', p.sim.paused);
    this.pause.setAttribute('aria-label', p.sim.paused ? 'Resume' : 'Pause');
    this.pause.dataset.tip = p.sim.paused ? 'Resume (Space)' : 'Pause (Space)';
    this.pause.setAttribute('aria-pressed', String(p.sim.paused));
    this.paused.hidden = !p.sim.paused;
    this.follow.setAttribute('aria-pressed', String(p.camera.follow));
    this.following.hidden = !p.camera.follow;
    this.pinCount.textContent = String(p.pins.list.length);
    this.canvas.classList.toggle('plain-cursor', !p.render.gizmos);
  }

  stats(fps: number, particles: number, simMs: number, drawMs: number): void {
    this.fps.textContent = fps.toFixed(0);
    this.count.textContent = countLabel(particles);
    this.sim.textContent = simMs.toFixed(1);
    this.draw.textContent = drawMs.toFixed(1);
  }

  /** Shows a short message. Nothing shows while the interface is hidden. */
  toast(message: string, ms = 1800): void {
    if (!this.uiVisible) return;
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  get helpVisible(): boolean {
    return !this.body.classList.contains('help-hidden');
  }

  setHelp(visible: boolean): void {
    this.body.classList.toggle('help-hidden', !visible);
    this.help.setAttribute('aria-pressed', String(visible));
  }

  get uiVisible(): boolean {
    return !this.body.classList.contains('ui-hidden');
  }

  /**
   * Hiding takes everything off the screen, toasts and the canvas rings included. The reveal
   * pill shows for a moment so the way back is clear, then only near the bottom edge.
   */
  setUi(visible: boolean): void {
    this.body.classList.toggle('ui-hidden', !visible);
    clearTimeout(this.hintTimer);
    this.body.classList.toggle('hint', !visible);
    if (visible) return;
    this.toastEl.classList.remove('show');
    this.hintTimer = window.setTimeout(() => this.body.classList.remove('hint'), 2600);
  }
}
