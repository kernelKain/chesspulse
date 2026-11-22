// What: the keyboard map opened with `?` or from Help.
// Why: every control is keyboard reachable, but a player cannot discover the timeline keys without
//      a written map. The dialog is the plan's `?` affordance and keeps focus inside itself.
// Removed: keyboard operation would work but stay hidden, and H-27 could not pass.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { COPY } from './copy';

const OPEN_EVENT = 'chesspulse:keyboard-help';

/** Lets a visible button open the same map as `?`, without threading state through every screen. */
export function openKeyboardHelp(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const SHORTCUTS = COPY.keyboard.shortcuts;

export function KeyboardHelpHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    }
    function onOpen(): void {
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  return open ? <KeyboardHelp onClose={() => setOpen(false)} /> : null;
}

export function KeyboardHelp({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href]');
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="keyboard-help-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="keyboard-help card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{COPY.keyboard.title}</h2>
        <dl className="keyboard-keys">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="keyboard-row">
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
            {COPY.common.actions.close}
          </button>
        </div>
      </div>
    </div>
  );
}
