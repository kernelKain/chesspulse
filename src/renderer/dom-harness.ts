// What: a small DOM harness for renderer interaction tests.
// Why: the markup tests use `react-dom/server`, which cannot click, focus, or observe effects.
//      S57 adds jsdom so focus-return and keyboard behaviour can be asserted instead of reviewed.
// Removed: the focus claims in S49/S50 and H-27 would stay code-reviewed only.
import { JSDOM } from 'jsdom';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

export interface DomHarness {
  readonly document: JSDOM['window']['document'];
  readonly window: JSDOM['window'];
  readonly container: HTMLElement;
  render(element: ReactElement): void;
  click(element: Element): void;
  keyDown(element: Element, key: string): void;
  unmount(): void;
}

export function mountDom(element: ReactElement): DomHarness {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  scope.window = dom.window;
  scope.document = dom.window.document;
  scope.HTMLElement = dom.window.HTMLElement;
  scope.Node = dom.window.Node;
  scope.Event = dom.window.Event;
  scope.KeyboardEvent = dom.window.KeyboardEvent;
  scope.MouseEvent = dom.window.MouseEvent;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);

  function render(next: ReactElement): void {
    act(() => {
      root.render(next);
    });
  }

  render(element);

  return {
    document: dom.window.document,
    window: dom.window,
    container,
    render,
    click(target: Element): void {
      act(() => {
        (target as HTMLElement).click();
      });
    },
    keyDown(target: Element, key: string): void {
      act(() => {
        target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
      });
    },
    unmount(): void {
      act(() => {
        root.unmount();
      });
      dom.window.close();
    },
  };
}

export function findButton(document: Document, label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!(match instanceof document.defaultView!.HTMLButtonElement)) {
    throw new Error(`No button labelled "${label}".`);
  }
  return match;
}
