/**
 * Link hover tooltip + modifier-held open affordance (R5 / ADR-5).
 *
 * Does not change click-to-edit or Ctrl/Cmd+click open (those stay in
 * `linkNavigationPlugin`). Never opens the edit-link dialog.
 */

import { $prose } from '@milkdown/utils';
import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/** Delay before showing the href tooltip (WCAG 1.4.13: not immediate). */
export const LINK_HOVER_TOOLTIP_DELAY_MS = 400;
/** Grace so the pointer can leave the link and enter the tooltip. */
export const LINK_HOVER_TOOLTIP_HIDE_GRACE_MS = 120;

/** Class on the editor root while Ctrl/Cmd is held (gates pointer cursor). */
export const LINK_MOD_HELD_CLASS = 'lightink-mod-held';
export const LINK_HREF_TOOLTIP_CLASS = 'lightink-link-href-tooltip';

export interface LinkAffordanceHost {
  readonly dom: HTMLElement;
}

/**
 * Bare URL whose visible text already is the target: skip a redundant tooltip.
 * Modifier-held cursor affordance is independent of this helper.
 */
export function shouldSkipLinkHrefTooltip(href: string, visibleText: string): boolean {
  const target = href.trim();
  const text = visibleText.trim();
  if (target === '' || text === '') {
    return false;
  }
  if (target === text) {
    return true;
  }
  const stripSlash = (value: string): string => value.replace(/\/+$/, '');
  if (stripSlash(target) === stripSlash(text)) {
    return true;
  }
  try {
    return decodeURI(target) === text || target === decodeURI(text);
  } catch {
    return false;
  }
}

function findEditorLink(target: EventTarget | null, root: HTMLElement): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const link = target.closest('a');
  if (!(link instanceof HTMLAnchorElement) || !root.contains(link)) {
    return null;
  }
  return link;
}

function placeHrefTooltip(tooltip: HTMLElement, anchor: DOMRect): void {
  const gap = 6;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = anchor.bottom + gap;
  if (top + height + gap > vh && anchor.top - height - gap >= gap) {
    top = anchor.top - height - gap;
  }
  let left = anchor.left;
  const maxLeft = Math.max(gap, vw - width - gap);
  if (left > maxLeft) {
    left = maxLeft;
  }
  if (left < gap) {
    left = gap;
  }
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.left = `${Math.round(left)}px`;
}

/**
 * DOM controller for href tooltip + modifier class. Headless-testable with a
 * host element (no ProseMirror view required).
 */
export class LinkAffordanceController {
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private tooltip: HTMLElement | null = null;
  private hoveredLink: HTMLAnchorElement | null = null;
  private pointerOverTooltip = false;
  private modifierDown = false;
  private disposed = false;
  private readonly doc: Document;

  constructor(
    private readonly host: LinkAffordanceHost,
    doc: Document = document,
  ) {
    this.doc = doc;
    this.host.dom.addEventListener('mouseover', this.onEditorMouseOver);
    this.host.dom.addEventListener('mouseout', this.onEditorMouseOut);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    this.doc.addEventListener('keyup', this.onKeyUp, true);
    this.doc.defaultView?.addEventListener('blur', this.onWindowBlur);
    this.host.dom.addEventListener('blur', this.onEditorBlur, true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimers();
    this.removeTooltip();
    this.applyModifier(false);
    this.host.dom.removeEventListener('mouseover', this.onEditorMouseOver);
    this.host.dom.removeEventListener('mouseout', this.onEditorMouseOut);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.doc.removeEventListener('keyup', this.onKeyUp, true);
    this.doc.defaultView?.removeEventListener('blur', this.onWindowBlur);
    this.host.dom.removeEventListener('blur', this.onEditorBlur, true);
  }

  isTooltipVisible(): boolean {
    return this.tooltip !== null && this.tooltip.style.display !== 'none';
  }

  tooltipElement(): HTMLElement | null {
    return this.tooltip;
  }

  private onEditorMouseOver = (event: MouseEvent): void => {
    const link = findEditorLink(event.target, this.host.dom);
    if (link === null) {
      return;
    }
    this.enterLink(link);
  };

  private onEditorMouseOut = (event: MouseEvent): void => {
    const link = this.hoveredLink;
    if (link === null) {
      return;
    }
    const related = event.relatedTarget;
    if (related instanceof Node && (link.contains(related) || this.tooltip?.contains(related))) {
      return;
    }
    if (findEditorLink(event.target, this.host.dom) !== link) {
      return;
    }
    this.leaveLink();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isTooltipVisible()) {
      this.hideTooltip();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Control' || event.key === 'Meta' || event.ctrlKey || event.metaKey) {
      this.applyModifier(true);
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Control' || event.key === 'Meta' || (!event.ctrlKey && !event.metaKey)) {
      this.applyModifier(false);
    }
  };

  private onWindowBlur = (): void => {
    this.applyModifier(false);
  };

  private onEditorBlur = (): void => {
    this.applyModifier(false);
  };

  private applyModifier(down: boolean): void {
    if (this.modifierDown === down) {
      return;
    }
    this.modifierDown = down;
    this.host.dom.classList.toggle(LINK_MOD_HELD_CLASS, down);
  }

  private enterLink(link: HTMLAnchorElement): void {
    if (this.hoveredLink === link) {
      this.clearHideTimer();
      return;
    }
    this.hoveredLink = link;
    this.clearTimers();
    this.hideTooltip();
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      if (this.disposed || this.hoveredLink !== link) {
        return;
      }
      this.showTooltip(link);
    }, LINK_HOVER_TOOLTIP_DELAY_MS);
  }

  private leaveLink(): void {
    this.hoveredLink = null;
    this.clearShowTimer();
    if (this.pointerOverTooltip) {
      return;
    }
    this.scheduleHide();
  }

  private showTooltip(link: HTMLAnchorElement): void {
    const href = (link.getAttribute('href') ?? '').trim();
    const text = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (href === '' || shouldSkipLinkHrefTooltip(href, text)) {
      return;
    }
    const tooltip = this.ensureTooltip();
    tooltip.textContent = href;
    tooltip.style.display = '';
    placeHrefTooltip(tooltip, link.getBoundingClientRect());
  }

  private hideTooltip(): void {
    this.clearHideTimer();
    if (this.tooltip === null) {
      return;
    }
    this.tooltip.style.display = 'none';
    this.tooltip.textContent = '';
  }

  private scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.pointerOverTooltip || this.hoveredLink !== null) {
        return;
      }
      this.hideTooltip();
    }, LINK_HOVER_TOOLTIP_HIDE_GRACE_MS);
  }

  private ensureTooltip(): HTMLElement {
    if (this.tooltip !== null) {
      return this.tooltip;
    }
    const tooltip = this.doc.createElement('div');
    tooltip.className = LINK_HREF_TOOLTIP_CLASS;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.style.position = 'fixed';
    tooltip.style.display = 'none';
    tooltip.addEventListener('mouseenter', this.onTooltipEnter);
    tooltip.addEventListener('mouseleave', this.onTooltipLeave);
    tooltip.addEventListener('mousedown', this.onTooltipMouseDown);
    this.doc.body.appendChild(tooltip);
    this.tooltip = tooltip;
    return tooltip;
  }

  private onTooltipEnter = (): void => {
    this.pointerOverTooltip = true;
    this.clearHideTimer();
  };

  private onTooltipLeave = (event: MouseEvent): void => {
    this.pointerOverTooltip = false;
    const related = event.relatedTarget;
    if (related instanceof Node && this.hoveredLink?.contains(related)) {
      return;
    }
    this.hoveredLink = null;
    this.scheduleHide();
  };

  private onTooltipMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private removeTooltip(): void {
    if (this.tooltip === null) {
      return;
    }
    this.tooltip.removeEventListener('mouseenter', this.onTooltipEnter);
    this.tooltip.removeEventListener('mouseleave', this.onTooltipLeave);
    this.tooltip.removeEventListener('mousedown', this.onTooltipMouseDown);
    this.tooltip.remove();
    this.tooltip = null;
    this.pointerOverTooltip = false;
  }

  private clearTimers(): void {
    this.clearShowTimer();
    this.clearHideTimer();
  }

  private clearShowTimer(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}

export function createLinkAffordanceProsePlugin(): Plugin {
  return new Plugin({
    view(view: EditorView) {
      const controller = new LinkAffordanceController(view);
      return {
        destroy() {
          controller.dispose();
        },
      };
    },
  });
}

export function linkAffordancePlugin() {
  return $prose(() => createLinkAffordanceProsePlugin());
}
