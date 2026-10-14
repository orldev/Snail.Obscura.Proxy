type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Minimal DOM builder: the UI is small enough not to need a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      element.className = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value as EventListener);
    } else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'for' || key === 'role') {
      element.setAttribute(key, String(value));
    } else {
      (element as unknown as Props)[key] = value;
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function mount(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren(...children.filter((child): child is Node | string => !!child));
}
