import { CANONICAL_Z_LAYERS, resolveModalCssVars } from '@francogp/auditor/modals';
import gsap from 'gsap';
import { Flip } from 'gsap/Flip';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import { computed, onUnmounted, type ComputedRef, type Ref } from 'vue';

gsap.registerPlugin(Flip, ScrollToPlugin);

const ENTER_DURATION_SEC = 0.28;
const ENTER_Y_OFFSET_PX = 10;
const STAGGER_SEC = 0.03;
const INTERACTION_DURATION_SEC = 0.16;
const PANEL_DURATION_IN_SEC = 0.22;
const PANEL_DURATION_OUT_SEC = 0.15;
const PANEL_REVEAL_OFFSET_PX = 8;
const PANEL_SCALE_Y = 0.96;
const MODAL_ENTER_DURATION_SEC = 0.28;
const MODAL_LEAVE_DURATION_SEC = 0.18;
const MODAL_ENTER_Y_PX = 20;
const MODAL_LEAVE_Y_PX = 12;
const MODAL_ENTER_SCALE = 0.94;
const MODAL_LEAVE_SCALE = 0.95;
const MODAL_STAGGER_SEC = 0.04;
const TOAST_OFFSET_X_PX = 32;
const TOAST_ENTER_DURATION_SEC = 0.26;
const TAB_SLIDE_X_PX = 24;
const TAB_DURATION_SEC = 0.22;
const FLIP_DURATION_SEC = 0.28;
const SCROLL_DURATION_SEC = 0.45;
const SCROLL_OFFSET_Y_PX = 16;
const LIST_STAGGER_SEC = 0.025;
const MAX_STAGGER_ELEMENTS = 20;
const GANTT_GROW_DURATION_SEC = 0.35;
const GANTT_STAGGER_SEC = 0.04;
const BUTTON_HOVER_Y_PX = -2;
const BUTTON_HOVER_SCALE = 1.03;
const BUTTON_PRESS_SCALE = 0.94;
const BUTTON_PRESS_Y_PX = 1;
const BUTTON_PRESS_DURATION_SEC = 0.09;
const BUTTON_RELEASE_DURATION_SEC = 0.2;
const INPUT_FOCUS_SCALE = 1.018;
const CHANGE_PULSE_SCALE = 0.94;
const CHANGE_PULSE_DURATION_SEC = 0.22;

const INTERACTIVE_TRIGGER_SELECTOR =
  '.vo-btn, .vo-tab, .vo-lang-bar__add-btn, .vo-lang-chip__btn, .vo-lang-picker__option, .vo-error-toast__close';
const INTERACTIVE_CONTROL_SELECTOR =
  '.vo-input, .vo-select, .vo-switch, .vo-lang-picker__search, input[type="range"]';
const INTERACTIVE_CHANGE_SELECTOR =
  '.vo-switch, input[type="checkbox"], input[type="radio"], .vo-select';
const INTERACTIVE_ROW_SELECTOR = '.vo-operator-row';

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function resolveHtmlElement(el: Element): HTMLElement | null {
  return el instanceof HTMLElement ? el : null;
}

function runEnterTween(
  el: Element,
  fromVars: gsap.TweenVars,
  toVars: gsap.TweenVars,
  done: () => void
): void {
  const target = resolveHtmlElement(el);
  if (!target || prefersReducedMotion()) {
    done();
    return;
  }
  gsap.fromTo(target, fromVars, {
    ...toVars,
    overwrite: 'auto',
    onComplete: done
  });
}

function runLeaveTween(el: Element, toVars: gsap.TweenVars, done: () => void): void {
  const target = resolveHtmlElement(el);
  if (!target || prefersReducedMotion()) {
    done();
    return;
  }
  gsap.to(target, {
    ...toVars,
    overwrite: 'auto',
    onComplete: done
  });
}

/** Returns reactive modal z-index CSS custom properties for a given stack layer. */
export function useModalVars(
  layerIndex: number
): ComputedRef<ReturnType<typeof resolveModalCssVars>> {
  const baseZ =
    CANONICAL_Z_LAYERS.MODAL + CANONICAL_Z_LAYERS.MODAL_STEP * Math.max(0, layerIndex - 1);
  return computed(() =>
    resolveModalCssVars({
      zIndex: baseZ,
      backdropZIndex: baseZ,
      contentZIndex: baseZ + CANONICAL_Z_LAYERS.MODAL_STEP
    })
  );
}

/** Vue `<Transition>` enter hook for modals (backdrop fade + card scale/lift + body stagger). */
export function animateModalEnter(el: Element, done: () => void): void {
  const backdrop = resolveHtmlElement(el);
  if (!backdrop || prefersReducedMotion()) {
    done();
    return;
  }
  const card = backdrop.querySelector<HTMLElement>('.vo-operator-modal');
  const bodyChildren = card
    ? Array.from(card.querySelectorAll<HTMLElement>('.vo-operator-modal__body > *')).slice(
        0,
        MAX_STAGGER_ELEMENTS
      )
    : [];

  const tl = gsap.timeline({ onComplete: done });
  tl.fromTo(
    backdrop,
    { opacity: 0 },
    { opacity: 1, duration: PANEL_DURATION_IN_SEC, ease: 'power2.out', clearProps: 'opacity' },
    0
  );
  if (card) {
    tl.fromTo(
      card,
      { opacity: 0, y: MODAL_ENTER_Y_PX, scale: MODAL_ENTER_SCALE },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: MODAL_ENTER_DURATION_SEC,
        ease: 'power3.out',
        clearProps: 'transform,opacity'
      },
      0
    );
  }
  if (bodyChildren.length > 0) {
    tl.fromTo(
      bodyChildren,
      { opacity: 0, y: ENTER_Y_OFFSET_PX },
      {
        opacity: 1,
        y: 0,
        duration: PANEL_DURATION_IN_SEC,
        stagger: MODAL_STAGGER_SEC,
        ease: 'power2.out',
        clearProps: 'transform,opacity'
      },
      '<0.08'
    );
  }
}

/** Vue `<Transition>` leave hook for modals (backdrop fade + card drop/scale). */
export function animateModalLeave(el: Element, done: () => void): void {
  const backdrop = resolveHtmlElement(el);
  if (!backdrop || prefersReducedMotion()) {
    done();
    return;
  }
  const card = backdrop.querySelector<HTMLElement>('.vo-operator-modal');
  const tl = gsap.timeline({ onComplete: done });
  tl.to(backdrop, { opacity: 0, duration: MODAL_LEAVE_DURATION_SEC, ease: 'power2.in' }, 0);
  if (card) {
    tl.to(
      card,
      {
        opacity: 0,
        y: MODAL_LEAVE_Y_PX,
        scale: MODAL_LEAVE_SCALE,
        duration: MODAL_LEAVE_DURATION_SEC,
        ease: 'power2.in'
      },
      0
    );
  }
}

/** Vue `<Transition>` enter hook for drawers, dropdowns, banners, and collapsible panels. */
export function animatePanelEnter(el: Element, done: () => void): void {
  runEnterTween(
    el,
    {
      opacity: 0,
      y: -PANEL_REVEAL_OFFSET_PX,
      scaleY: PANEL_SCALE_Y,
      transformOrigin: 'top center'
    },
    {
      opacity: 1,
      y: 0,
      scaleY: 1,
      duration: PANEL_DURATION_IN_SEC,
      ease: 'power2.out',
      clearProps: 'transform,opacity,transformOrigin'
    },
    done
  );
}

/** Vue `<Transition>` leave hook for drawers, dropdowns, banners, and collapsible panels. */
export function animatePanelLeave(el: Element, done: () => void): void {
  runLeaveTween(
    el,
    {
      opacity: 0,
      y: -PANEL_REVEAL_OFFSET_PX,
      scaleY: PANEL_SCALE_Y,
      transformOrigin: 'top center',
      duration: PANEL_DURATION_OUT_SEC,
      ease: 'power2.in'
    },
    done
  );
}

/** Vue `<Transition>` enter hook for right-anchored floating error toasts. */
export function animateToastEnter(el: Element, done: () => void): void {
  runEnterTween(
    el,
    { opacity: 0, x: TOAST_OFFSET_X_PX },
    {
      opacity: 1,
      x: 0,
      duration: TOAST_ENTER_DURATION_SEC,
      ease: 'power3.out',
      clearProps: 'transform,opacity'
    },
    done
  );
}

/** Vue `<Transition>` leave hook for floating error toasts. */
export function animateToastLeave(el: Element, done: () => void): void {
  runLeaveTween(
    el,
    {
      opacity: 0,
      x: TOAST_OFFSET_X_PX,
      duration: MODAL_LEAVE_DURATION_SEC,
      ease: 'power2.in'
    },
    done
  );
}

/** Vue `<Transition>` directional enter hook for workspace tab switches. */
export function animateTabViewEnter(el: Element, done: () => void, direction: -1 | 1): void {
  runEnterTween(
    el,
    { opacity: 0, x: direction * TAB_SLIDE_X_PX },
    {
      opacity: 1,
      x: 0,
      duration: TAB_DURATION_SEC,
      ease: 'power2.out',
      clearProps: 'transform,opacity'
    },
    done
  );
}

/** Vue `<Transition>` directional leave hook for workspace tab switches. */
export function animateTabViewLeave(el: Element, done: () => void, direction: -1 | 1): void {
  runLeaveTween(
    el,
    {
      opacity: 0,
      x: -direction * TAB_SLIDE_X_PX,
      duration: PANEL_DURATION_OUT_SEC,
      ease: 'power2.in'
    },
    done
  );
}

/** Animates staggered list/card items cleanly on mount or search refresh. */
export function animateStaggerList(container: HTMLElement | null, selector: string): void {
  if (!container || prefersReducedMotion()) {
    return;
  }
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).slice(
    0,
    MAX_STAGGER_ELEMENTS
  );
  if (items.length === 0) {
    return;
  }
  gsap.fromTo(
    items,
    { opacity: 0, y: ENTER_Y_OFFSET_PX },
    {
      opacity: 1,
      y: 0,
      duration: PANEL_DURATION_IN_SEC,
      stagger: LIST_STAGGER_SEC,
      ease: 'power2.out',
      overwrite: 'auto',
      clearProps: 'transform,opacity'
    }
  );
}

/** Animates proportional Gantt bar segments growing along the X-axis via GPU scaleX. */
export function animateGanttSegments(container: HTMLElement | null): void {
  if (!container || prefersReducedMotion()) {
    return;
  }
  const segments = Array.from(container.querySelectorAll<HTMLElement>('.vo-slot-seg'));
  if (segments.length === 0) {
    return;
  }
  gsap.fromTo(
    segments,
    { scaleX: 0, transformOrigin: 'left center' },
    {
      scaleX: 1,
      duration: GANTT_GROW_DURATION_SEC,
      stagger: GANTT_STAGGER_SEC,
      ease: 'power3.out',
      overwrite: 'auto',
      clearProps: 'transform,transformOrigin'
    }
  );
}

/** Captures a GSAP Flip layout snapshot for chip/row reordering transitions. */
export function captureFlipState(targets: string | Element | Element[]): Flip.FlipState | null {
  if (prefersReducedMotion()) {
    return null;
  }
  return Flip.getState(targets);
}

/** Plays a GSAP Flip transition from a previously captured layout snapshot. */
export function playFlip(state: Flip.FlipState | null): void {
  if (!state || prefersReducedMotion()) {
    return;
  }
  Flip.from(state, {
    duration: FLIP_DURATION_SEC,
    ease: 'power2.inOut',
    simple: true,
    clearProps: 'transform'
  });
}

/** Smoothly scrolls the viewport to `target` using GSAP ScrollToPlugin. */
export function smoothScrollToElement(target: HTMLElement | null): void {
  if (!target) {
    return;
  }
  if (prefersReducedMotion()) {
    target.scrollIntoView({ block: 'start' });
    return;
  }
  gsap.to(globalThis, {
    duration: SCROLL_DURATION_SEC,
    scrollTo: { y: target, offsetY: SCROLL_OFFSET_Y_PX },
    ease: 'power2.out'
  });
}

function isDisabledTarget(el: Element): boolean {
  if (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.disabled;
  }
  return el.getAttribute('aria-disabled') === 'true';
}

function resolveDelegatedTarget(
  eventTarget: EventTarget | null,
  selector: string
): HTMLElement | null {
  if (!(eventTarget instanceof Element)) {
    return null;
  }
  const matched = eventTarget.closest(selector);
  if (!(matched instanceof HTMLElement) || isDisabledTarget(matched)) {
    return null;
  }
  return matched;
}

/**
 * Manages scoped GSAP timelines, row entrances, and delegated GPU micro-interactions
 * with isolated contexts and `prefers-reduced-motion` support.
 */
export function useGsapMotion(rootRef: Ref<HTMLElement | null>): {
  readonly animateShellTimeline: () => void;
  readonly animateEntrance: (selector: string) => void;
  readonly attachInteractiveMotion: () => void;
} {
  let shellCtx: gsap.Context | undefined;
  let rowsCtx: gsap.Context | undefined;
  let cleanupListeners: (() => void) | undefined;

  function animateShellTimeline(): void {
    if (!rootRef.value) {
      return;
    }
    shellCtx?.revert();
    shellCtx = gsap.context((): void => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', (): void => {
        const tl = gsap.timeline({
          defaults: { duration: ENTER_DURATION_SEC, ease: 'power3.out' }
        });
        tl.fromTo(
          '.vo-header',
          { opacity: 0, y: -ENTER_Y_OFFSET_PX },
          { opacity: 1, y: 0, clearProps: 'transform,opacity' }
        ).fromTo(
          '.vo-panel:not(.vo-header)',
          { opacity: 0, y: ENTER_Y_OFFSET_PX },
          { opacity: 1, y: 0, stagger: STAGGER_SEC, clearProps: 'transform,opacity' },
          '<0.06'
        );
      });
    }, rootRef.value);
  }

  function animateEntrance(selector: string): void {
    if (!rootRef.value) {
      return;
    }
    rowsCtx?.revert();
    rowsCtx = gsap.context((): void => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', (): void => {
        gsap.fromTo(
          selector,
          { opacity: 0, y: ENTER_Y_OFFSET_PX },
          {
            opacity: 1,
            y: 0,
            duration: ENTER_DURATION_SEC,
            stagger: STAGGER_SEC,
            ease: 'power2.out',
            overwrite: 'auto',
            clearProps: 'transform,opacity'
          }
        );
      });
    }, rootRef.value);
  }

  function animateDelegatedTarget(
    evt: Event,
    selector: string,
    vars: gsap.TweenVars,
    checkRelated: boolean,
    mouseOnly = false
  ): void {
    if (prefersReducedMotion()) {
      return;
    }
    if (
      mouseOnly &&
      evt instanceof PointerEvent &&
      evt.pointerType &&
      evt.pointerType !== 'mouse'
    ) {
      return;
    }
    const el = resolveDelegatedTarget(evt.target, selector);
    if (!el) {
      return;
    }
    if (
      checkRelated &&
      evt instanceof PointerEvent &&
      evt.relatedTarget instanceof Node &&
      el.contains(evt.relatedTarget)
    ) {
      return;
    }
    gsap.to(el, vars);
  }

  function attachInteractiveMotion(): void {
    cleanupListeners?.();
    cleanupListeners = undefined;
    const root = rootRef.value;
    if (!root) {
      return;
    }

    const restoreTransform: gsap.TweenVars = {
      x: 0,
      y: 0,
      scale: 1,
      duration: INTERACTION_DURATION_SEC,
      ease: 'power2.out',
      overwrite: 'auto',
      clearProps: 'transform'
    };

    const bindings: ReadonlyArray<
      readonly [keyof HTMLElementEventMap, string, gsap.TweenVars, boolean, boolean]
    > = [
      [
        'pointerover',
        INTERACTIVE_TRIGGER_SELECTOR,
        {
          y: BUTTON_HOVER_Y_PX,
          scale: BUTTON_HOVER_SCALE,
          duration: INTERACTION_DURATION_SEC,
          ease: 'power2.out',
          overwrite: 'auto'
        },
        true,
        true
      ],
      ['pointerout', INTERACTIVE_TRIGGER_SELECTOR, restoreTransform, true, true],
      [
        'pointerover',
        INTERACTIVE_ROW_SELECTOR,
        {
          x: 3,
          duration: INTERACTION_DURATION_SEC,
          ease: 'power2.out',
          overwrite: 'auto'
        },
        true,
        true
      ],
      ['pointerout', INTERACTIVE_ROW_SELECTOR, restoreTransform, true, true],
      [
        'pointerdown',
        INTERACTIVE_TRIGGER_SELECTOR,
        {
          y: BUTTON_PRESS_Y_PX,
          scale: BUTTON_PRESS_SCALE,
          duration: BUTTON_PRESS_DURATION_SEC,
          ease: 'power2.out',
          overwrite: 'auto'
        },
        false,
        false
      ],
      [
        'pointerup',
        INTERACTIVE_TRIGGER_SELECTOR,
        {
          y: 0,
          scale: 1,
          duration: BUTTON_RELEASE_DURATION_SEC,
          ease: 'back.out(2)',
          overwrite: 'auto',
          clearProps: 'transform'
        },
        false,
        false
      ],
      ['pointercancel', INTERACTIVE_TRIGGER_SELECTOR, restoreTransform, false, false],
      [
        'focusin',
        INTERACTIVE_CONTROL_SELECTOR,
        {
          scale: INPUT_FOCUS_SCALE,
          duration: INTERACTION_DURATION_SEC,
          ease: 'power2.out',
          overwrite: 'auto'
        },
        false,
        false
      ],
      ['focusout', INTERACTIVE_CONTROL_SELECTOR, restoreTransform, false, false]
    ];

    const onControlChange = (evt: Event): void => {
      if (prefersReducedMotion()) {
        return;
      }
      const ctrl = resolveDelegatedTarget(evt.target, INTERACTIVE_CHANGE_SELECTOR);
      if (!ctrl) {
        return;
      }
      gsap.fromTo(
        ctrl,
        { scale: CHANGE_PULSE_SCALE },
        {
          scale: 1,
          duration: CHANGE_PULSE_DURATION_SEC,
          ease: 'back.out(2.2)',
          overwrite: 'auto',
          clearProps: 'transform'
        }
      );
    };

    const disposers = bindings.map(([eventName, selector, vars, checkRelated, mouseOnly]) => {
      const handler = (evt: Event): void => {
        animateDelegatedTarget(evt, selector, vars, checkRelated, mouseOnly);
      };
      root.addEventListener(eventName, handler);
      return (): void => {
        root.removeEventListener(eventName, handler);
      };
    });
    root.addEventListener('change', onControlChange);

    cleanupListeners = (): void => {
      for (const dispose of disposers) {
        dispose();
      }
      root.removeEventListener('change', onControlChange);
    };
  }

  onUnmounted((): void => {
    cleanupListeners?.();
    shellCtx?.revert();
    rowsCtx?.revert();
  });

  return { animateShellTimeline, animateEntrance, attachInteractiveMotion };
}
