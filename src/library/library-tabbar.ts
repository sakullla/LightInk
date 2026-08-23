/**
 * Mobile library chrome bottom tab bar (书架/书源/管理).
 * Catalog browsing is a drill-in inside the sources tab, not a fourth tab.
 * Mounted only under the mobile chrome flags (data-android / data-touch-primary);
 * visibility is additionally gated to the ≤760px breakpoint in library.css.
 */

export type LibraryTabId = 'shelf' | 'sources' | 'manage';

export interface LibraryTabbarLabels {
  readonly navigation: string;
  readonly shelf: string;
  readonly sources: string;
  readonly manage: string;
}

export interface LibraryTabbarOptions {
  readonly labels: LibraryTabbarLabels;
  readonly onSelect: (tab: LibraryTabId) => void;
}

export interface LibraryTabbar {
  readonly element: HTMLElement;
  setActive(tab: LibraryTabId): void;
  setLabels(labels: LibraryTabbarLabels): void;
}

const TAB_ORDER: readonly LibraryTabId[] = ['shelf', 'sources', 'manage'];

/* Feather-style stroke icons, same visual set as the desktop nav icons. */
const TAB_ICON_PATHS: Record<LibraryTabId, readonly string[]> = {
  shelf: [
    'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
    'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  ],
  sources: ['M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'],
  manage: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82.33l.06.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
};

function createTabIcon(doc: Document, paths: readonly string[]): SVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'lightink-library-tabbar-icon');
  for (const d of paths) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function createLibraryTabbar(
  doc: Document,
  options: LibraryTabbarOptions,
): LibraryTabbar {
  const element = doc.createElement('nav');
  element.className = 'lightink-library-tabbar';
  element.setAttribute('aria-label', options.labels.navigation);
  const buttons = new Map<LibraryTabId, HTMLButtonElement>();
  const labelSpans = new Map<LibraryTabId, HTMLSpanElement>();
  for (const tab of TAB_ORDER) {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'lightink-library-tabbar-tab';
    item.dataset.libraryTabItem = tab;
    item.title = options.labels[tab];
    item.setAttribute('aria-label', options.labels[tab]);
    item.appendChild(createTabIcon(doc, TAB_ICON_PATHS[tab]));
    const text = doc.createElement('span');
    text.className = 'lightink-library-tabbar-label';
    text.textContent = options.labels[tab];
    item.appendChild(text);
    item.addEventListener('click', () => options.onSelect(tab));
    buttons.set(tab, item);
    labelSpans.set(tab, text);
    element.appendChild(item);
  }
  let active: LibraryTabId = 'shelf';
  const apply = (): void => {
    for (const [tab, item] of buttons) {
      const isActive = tab === active;
      item.classList.toggle('is-active', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  };
  apply();
  return {
    element,
    setActive(tab: LibraryTabId): void {
      if (tab === active) return;
      active = tab;
      apply();
    },
    setLabels(labels: LibraryTabbarLabels): void {
      element.setAttribute('aria-label', labels.navigation);
      for (const tab of TAB_ORDER) {
        const item = buttons.get(tab);
        const span = labelSpans.get(tab);
        if (item === undefined || span === undefined) continue;
        span.textContent = labels[tab];
        item.title = labels[tab];
        item.setAttribute('aria-label', labels[tab]);
      }
    },
  };
}
