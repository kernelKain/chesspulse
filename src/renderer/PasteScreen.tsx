// What: Screen 4 (Paste) for entering ordered chess.com PGNs and inspecting per-game validation.
// Why: AC-06 requires chronological order checks per game with no partial report when order fails.
// Removed: a player could not enter PGNs or see order, clockless, and exclusion states before reporting.
import { useEffect, useId, useRef, useState } from 'react';
import {
  pasteValidationSchema,
  type PasteGameSummary,
  type PasteSlot,
  type PasteState,
  type PasteValidation,
} from '../shared/contracts';
import { readIpcError } from './ipc-error';

const INITIAL_SLOTS = 3;
const MAX_SLOTS = 20;

const STATE_LABEL: Record<PasteState, string> = {
  empty: 'Empty',
  partial: 'Partial',
  out_of_order: 'Out of order',
  clockless: 'Clockless',
  valid: 'All valid',
  invalid: 'Needs fix',
};

const ENDING_LABEL: Record<PasteGameSummary['ending'], string> = {
  checkmate: 'Checkmate',
  resignation: 'Resignation',
  timeout: 'Timeout',
  abandoned: 'Abandoned',
  aborted: 'Aborted',
  unknown: 'Finished',
};

function emptyValidation(count: number): PasteValidation {
  return {
    state: 'empty',
    order: 'none',
    clockless: false,
    canBuild: false,
    message: 'Paste chess.com PGNs oldest first.',
    summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
    slots: Array.from({ length: count }, (_item, slotIndex) => ({
      slotIndex,
      status: 'empty' as const,
    })),
  };
}

export function PasteScreen({
  sessionId,
  initialSlots,
  onBack,
  onContinue,
}: {
  sessionId: string | null;
  initialSlots?: string[];
  onBack: (slots: string[]) => void;
  onContinue: (pgns: string[], validation: PasteValidation) => void;
}) {
  const [slots, setSlots] = useState<string[]>(() =>
    initialSlots && initialSlots.length > 0
      ? initialSlots
      : Array.from({ length: INITIAL_SLOTS }, () => ''),
  );
  const [validation, setValidation] = useState<PasteValidation>(() => emptyValidation(slots.length));
  const [validating, setValidating] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const baseId = useId();
  const bridge = window.chesspulse;

  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!bridge) {
      setValidating(false);
      setBridgeError('This page is open outside the ChessPulse window. Paste validation is unavailable.');
      return;
    }
    if (slots.every((text) => text.trim().length === 0)) {
      setValidating(false);
      setBridgeError(null);
      setValidation(emptyValidation(slots.length));
      return;
    }
    setValidating(true);
    setBridgeError(null);
    void bridge
      .validatePgns(slots)
      .then((raw) => {
        if (seq !== requestSeq.current) return;
        const parsed = pasteValidationSchema.safeParse(raw);
        if (!parsed.success) {
          setBridgeError('Validation returned an unexpected result.');
          return;
        }
        setValidation(parsed.data);
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        setBridgeError(readIpcError(error, 'pgn_invalid'));
      })
      .finally(() => {
        if (seq === requestSeq.current) setValidating(false);
      });
  }, [bridge, slots]);

  function updateSlot(index: number, value: string): void {
    setSlots((current) => current.map((item, i) => (i === index ? value : item)));
  }

  function addSlot(): void {
    setSlots((current) => (current.length >= MAX_SLOTS ? current : [...current, '']));
  }

  function removeSlot(index: number): void {
    setSlots((current) => (current.length <= 1 ? current : current.filter((_item, i) => i !== index)));
  }

  function moveSlot(index: number, delta: -1 | 1): void {
    setSlots((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const item = next[index] ?? '';
      next[index] = next[target] ?? '';
      next[target] = item;
      return next;
    });
  }

  function handleContinue(): void {
    if (!validation.canBuild || validating || bridgeError) return;
    const filled = slots.filter((text) => text.trim().length > 0);
    onContinue(filled, validation);
  }

  const bannerTone = toneFor(bridgeError ? 'invalid' : validation.state);
  const canContinue = Boolean(bridge) && !validating && !bridgeError && validation.canBuild;

  return (
    <section className="paste-screen" aria-labelledby={`${baseId}-heading`}>
      <p className="label">ChessPulse · Paste PGNs</p>
      <h1 id={`${baseId}-heading`}>Paste your games in order.</h1>
      <p>
        Copy each game&apos;s PGN from chess.com oldest first, one game per box.
        {sessionId ? ` Session ${sessionId}.` : ''}
      </p>

      <div className={`paste-banner tone-${bannerTone}`} role="status" aria-live="polite">
        <div className="banner-head">
          <span className={`state-tag tone-${bannerTone}`}>
            {validating ? 'Checking' : bridgeError ? 'Unavailable' : STATE_LABEL[validation.state]}
          </span>
          {validation.summary.total > 0 && !bridgeError ? (
            <span className="banner-counts">{formatCounts(validation.summary)}</span>
          ) : null}
        </div>
        <p className="banner-message">{bridgeError ?? validation.message}</p>
        {!bridgeError && validation.order === 'unverified' && validation.summary.total > 0 ? (
          <p className="banner-sub">
            No timestamps in these PGNs. Order follows the boxes below (oldest first).
          </p>
        ) : null}
      </div>

      <ol className="slot-list">
        {slots.map((text, index) => {
          const slotInfo: PasteSlot = validation.slots[index] ?? { slotIndex: index, status: 'empty' };
          const fieldId = `${baseId}-slot-${index}`;
          const errorId = `${baseId}-slot-error-${index}`;
          const hasError = slotInfo.status === 'invalid' || slotInfo.status === 'order_error';

          return (
            <li key={index} className={`paste-slot status-${slotInfo.status}`}>
              <div className="slot-header">
                <div className="slot-title">
                  <label htmlFor={fieldId}>Game {index + 1}</label>
                  <SlotBadge slot={slotInfo} />
                </div>
                <div className="slot-controls">
                  <button
                    type="button"
                    className="small-btn"
                    disabled={index === 0}
                    aria-label={`Move game ${index + 1} up`}
                    onClick={() => moveSlot(index, -1)}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={index === slots.length - 1}
                    aria-label={`Move game ${index + 1} down`}
                    onClick={() => moveSlot(index, 1)}
                  >
                    Move down
                  </button>
                  {text.length > 0 ? (
                    <button
                      type="button"
                      className="small-btn"
                      aria-label={`Clear game ${index + 1}`}
                      onClick={() => updateSlot(index, '')}
                    >
                      Clear
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="small-btn"
                    disabled={slots.length <= 1}
                    aria-label={`Remove game ${index + 1}`}
                    onClick={() => removeSlot(index)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {slotInfo.status === 'valid' || slotInfo.status === 'order_error' ? (
                <GameSummaryRow game={slotInfo.game} />
              ) : null}

              <textarea
                id={fieldId}
                rows={4}
                spellCheck={false}
                placeholder={`Paste Game ${index + 1} PGN here`}
                value={text}
                aria-invalid={hasError}
                aria-describedby={hasError ? errorId : undefined}
                onChange={(event) => updateSlot(index, event.target.value)}
              />

              {hasError ? (
                <p id={errorId} className="slot-error" role="alert">
                  {slotInfo.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="actions">
        <button type="button" className="primary-btn" disabled={!canContinue} onClick={handleContinue}>
          Continue to report
        </button>
        <button type="button" disabled={slots.length >= MAX_SLOTS} onClick={addSlot}>
          Add game ({slots.length}/{MAX_SLOTS})
        </button>
        <button type="button" onClick={() => onBack(slots)}>
          Back to session
        </button>
      </div>
    </section>
  );
}

function SlotBadge({ slot }: { slot: PasteSlot }) {
  if (slot.status === 'empty') {
    return <span className="slot-badge tone-neutral">Empty</span>;
  }
  if (slot.status === 'valid') {
    return (
      <span className="slot-badge tone-ok">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2.5 7.5L5.5 10.5L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
        Valid
      </span>
    );
  }
  if (slot.status === 'order_error') {
    return <span className="slot-badge tone-warn">Out of order</span>;
  }
  return <span className="slot-badge tone-warn">Invalid</span>;
}

function GameSummaryRow({ game }: { game: PasteGameSummary }) {
  const players =
    game.white || game.black
      ? `${game.white || 'Unknown'} vs ${game.black || 'Unknown'}`
      : 'Players unnamed';
  const moves = `${game.moveCount} ${game.moveCount === 1 ? 'ply' : 'plies'}`;
  const clocks =
    game.moveCount === 0
      ? 'No moves'
      : !game.hasClocks
        ? 'No clocks'
        : game.partialClocks
          ? 'Partial clocks'
          : 'Clocks OK';

  return (
    <div className="slot-meta">
      <span className="meta-players">{players}</span>
      <span className="meta-detail">
        {game.result} · {ENDING_LABEL[game.ending]} · {moves} · {clocks}
        {game.timeControl ? ` · ${game.timeControl}` : ''}
      </span>
      {!game.includeInStats ? (
        <span className="meta-excluded">Excluded from accuracy</span>
      ) : null}
    </div>
  );
}

function formatCounts(summary: PasteValidation['summary']): string {
  const parts = [
    `${summary.total} ${summary.total === 1 ? 'game' : 'games'}`,
    `${summary.includedInStats} in accuracy`,
  ];
  if (summary.aborted > 0) parts.push(`${summary.aborted} aborted`);
  if (summary.abandoned > 0) parts.push(`${summary.abandoned} abandoned`);
  return parts.join(' · ');
}

function toneFor(state: PasteState): 'neutral' | 'ok' | 'warn' {
  if (state === 'valid') return 'ok';
  if (state === 'out_of_order' || state === 'clockless' || state === 'invalid') return 'warn';
  return 'neutral';
}
