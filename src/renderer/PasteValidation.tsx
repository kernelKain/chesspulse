// What: the per-slot validation badge and error line used by the Paste screen.
// Why: H-23 must show the exact game and move error without rendering the whole bridge-bound screen.
// Removed: a slot error could only be inspected by reading the screen component.
import type { PasteSlot } from '../shared/contracts.js';
import { COPY } from './copy';

export function SlotError({ id, slot }: { id?: string; slot: PasteSlot }) {
  if (slot.status !== 'invalid' && slot.status !== 'order_error') return null;
  return (
    <p id={id} className="slot-error" role="alert">
      {slot.message}
    </p>
  );
}

export function SlotBadge({ slot }: { slot: PasteSlot }) {
  if (slot.status === 'empty') {
    return <span className="slot-badge tone-neutral">{COPY.games.badges.empty}</span>;
  }
  if (slot.status === 'valid') {
    return (
      <span className="slot-badge tone-ok">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2.5 7.5L5.5 10.5L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
        {COPY.games.badges.valid}
      </span>
    );
  }
  if (slot.status === 'order_error') {
    return <span className="slot-badge tone-warn">{COPY.games.badges.outOfOrder}</span>;
  }
  return <span className="slot-badge tone-warn">{COPY.games.badges.invalid}</span>;
}
