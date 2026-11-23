// What: Screen 4 (Paste) for entering ordered chess.com PGNs and inspecting per-game validation.
// Why: AC-06 requires chronological order checks per game with no partial report when order fails.
// Removed: a player could not enter PGNs or see order, clockless, and exclusion states before reporting.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  pasteValidationSchema,
  type PasteGameSummary,
  type PasteSlot,
  type PasteState,
  type PasteValidation,
} from '../shared/contracts';
import { playerCandidates, sameName } from '../shared/player';
import { COPY } from './copy';
import { readIpcError } from './ipc-error';
import { SlotBadge, SlotError } from './PasteValidation';

const INITIAL_SLOTS = 3;
const MAX_SLOTS = 20;

const STATE_LABEL: Record<PasteState, string> = {
  empty: COPY.games.states.empty,
  partial: COPY.games.states.partial,
  out_of_order: COPY.games.states.out_of_order,
  clockless: COPY.games.states.clockless,
  valid: COPY.games.states.valid,
  invalid: COPY.games.states.invalid,
};

const ENDING_LABEL: Record<PasteGameSummary['ending'], string> = {
  checkmate: COPY.games.endings.checkmate,
  resignation: COPY.games.endings.resignation,
  timeout: COPY.games.endings.timeout,
  abandoned: COPY.games.endings.abandoned,
  aborted: COPY.games.endings.aborted,
  unknown: COPY.games.endings.unknown,
};

function emptyValidation(count: number): PasteValidation {
  return {
    state: 'empty',
    order: 'none',
    clockless: false,
    canBuild: false,
    message: COPY.games.emptyMessage,
    summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
    slots: Array.from({ length: count }, (_item, slotIndex) => ({
      slotIndex,
      status: 'empty' as const,
    })),
  };
}

/** The player's answer to "Which player are you?". `all` keeps both sides on purpose. */
type PlayerChoice = { kind: 'player'; name: string } | { kind: 'all' };

export function PasteScreen({
  initialSlots,
  rememberedPlayer = null,
  onBack,
  onContinue,
  onHelp,
  onSlotsChange,
}: {
  initialSlots?: string[];
  /** The username chosen on an earlier paste, preselected when it is in every game. */
  rememberedPlayer?: string | null;
  onBack: (slots: string[]) => void;
  /** `playerName` is absent when both sides are counted. */
  onContinue: (pgns: string[], validation: PasteValidation, playerName?: string) => void;
  onHelp?: () => void;
  onSlotsChange?: (slots: string[]) => void;
}) {
  const [slots, setSlots] = useState<string[]>(() =>
    initialSlots && initialSlots.length > 0
      ? initialSlots
      : Array.from({ length: INITIAL_SLOTS }, () => ''),
  );
  const [validation, setValidation] = useState<PasteValidation>(() => emptyValidation(slots.length));
  const [validating, setValidating] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [choice, setChoice] = useState<PlayerChoice | null>(null);
  const requestSeq = useRef(0);
  const baseId = useId();
  const bridge = window.chesspulse;

  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!bridge) {
      setValidating(false);
      setBridgeError(COPY.games.unavailablePage);
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
          setBridgeError(COPY.games.unexpectedResult);
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
    const next = slots.map((item, i) => (i === index ? value : item));
    setSlots(next);
    onSlotsChange?.(next);
  }

  function addSlot(): void {
    if (slots.length >= MAX_SLOTS) return;
    const next = [...slots, ''];
    setSlots(next);
    onSlotsChange?.(next);
  }

  function removeSlot(index: number): void {
    if (slots.length <= 1) return;
    const next = slots.filter((_item, i) => i !== index);
    setSlots(next);
    onSlotsChange?.(next);
  }

  function moveSlot(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= slots.length) return;
    const next = [...slots];
    const item = next[index] ?? '';
    next[index] = next[target] ?? '';
    next[target] = item;
    setSlots(next);
    onSlotsChange?.(next);
  }

  const candidates = useMemo(() => playerCandidates(pastedGames(validation)), [validation]);
  const needsChoice = candidates.length > 1;
  // A stale answer (the games changed under it) falls back to the remembered name, never to a guess.
  const selected: PlayerChoice | null = !needsChoice
    ? null
    : choice?.kind === 'all'
      ? choice
      : choice && candidates.some((name) => sameName(name, choice.name))
        ? choice
        : rememberedChoice(candidates, rememberedPlayer);
  const playerName =
    candidates.length === 1
      ? candidates[0]
      : selected?.kind === 'player'
        ? candidates.find((name) => sameName(name, selected.name))
        : undefined;

  function handleContinue(): void {
    if (!validation.canBuild || validating || bridgeError) return;
    if (needsChoice && !selected) return;
    const filled = slots.filter((text) => text.trim().length > 0);
    onContinue(filled, validation, playerName);
  }

  const bannerTone = toneFor(bridgeError ? 'invalid' : validation.state);
  const canContinue =
    Boolean(bridge) && !validating && !bridgeError && validation.canBuild && (!needsChoice || selected !== null);

  return (
    <section className="paste-screen" aria-labelledby={`${baseId}-heading`}>
      <p className="label">{COPY.common.screenLabels.paste}</p>
      <h1 id={`${baseId}-heading`}>{COPY.games.heading}</h1>
      <p>
        {COPY.games.intro}
      </p>
      <p className="paste-hint">{COPY.games.clockOptionNote}</p>

      <div className={`paste-banner tone-${bannerTone}`} role="status" aria-live="polite">
        <div className="banner-head">
          <span className={`status-pill tone-${bannerTone}`}>
            {validating ? COPY.games.states.checking : bridgeError ? COPY.games.states.unavailable : STATE_LABEL[validation.state]}
          </span>
          {validation.summary.total > 0 && !bridgeError ? (
            <span className="banner-counts">{formatCounts(validation.summary)}</span>
          ) : null}
        </div>
        <p className="banner-message">{bridgeError ?? validation.message}</p>
        {!bridgeError && validation.order === 'unverified' && validation.summary.total > 0 ? (
          <p className="banner-sub">{COPY.games.orderNote}</p>
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
                  <label htmlFor={fieldId}>{COPY.games.game(index)}</label>
                  <SlotBadge slot={slotInfo} />
                </div>
                <div className="slot-controls">
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    disabled={index === 0}
                    aria-label={COPY.games.moveUp(index)}
                    onClick={() => moveSlot(index, -1)}
                  >
                    {COPY.games.moveUpShort}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    disabled={index === slots.length - 1}
                    aria-label={COPY.games.moveDown(index)}
                    onClick={() => moveSlot(index, 1)}
                  >
                    {COPY.games.moveDownShort}
                  </button>
                  {text.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      aria-label={COPY.games.clear(index)}
                      onClick={() => updateSlot(index, '')}
                    >
                      {COPY.games.clearShort}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    disabled={slots.length <= 1}
                    aria-label={COPY.games.remove(index)}
                    onClick={() => removeSlot(index)}
                  >
                    {COPY.games.removeShort}
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
                placeholder={COPY.games.placeholder(index)}
                value={text}
                aria-invalid={hasError}
                aria-describedby={hasError ? errorId : undefined}
                onChange={(event) => updateSlot(index, event.target.value)}
              />

              {hasError ? <SlotError id={errorId} slot={slotInfo} /> : null}
            </li>
          );
        })}
      </ol>

      {validation.canBuild && !bridgeError ? (
        <PlayerQuestion
          candidates={candidates}
          selected={selected}
          groupName={`${baseId}-player`}
          onChoose={setChoice}
        />
      ) : null}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={handleContinue}>
          {COPY.games.continue}
        </button>
        <button type="button" disabled={slots.length >= MAX_SLOTS} onClick={addSlot} className="btn btn-secondary">
          {COPY.games.addGame(slots.length, MAX_SLOTS)}
        </button>
        <button type="button" onClick={() => onBack(slots)} className="btn btn-secondary">
          {COPY.common.actions.backToSession}
        </button>
        {onHelp ? (
          <button type="button" onClick={onHelp} className="btn btn-secondary">
            {COPY.common.actions.help}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function GameSummaryRow({ game }: { game: PasteGameSummary }) {
  const players =
    game.white || game.black
      ? `${game.white || COPY.gamesList.unknown} vs ${game.black || COPY.gamesList.unknown}`
      : COPY.games.playersUnnamed;
  const clocks =
    game.moveCount === 0
      ? COPY.games.noMoves
      : !game.hasClocks
        ? COPY.games.noClocks
        : game.partialClocks
          ? COPY.games.partialClocks
          : COPY.games.clocksOk;
  const clocksOk = game.moveCount > 0 && game.hasClocks && !game.partialClocks;

  return (
    <div className="game-card">
      <div className="game-card-head">
        <span className="game-card-players">{players}</span>
        <span className="game-card-result">{game.result}</span>
      </div>
      <dl className="game-facts">
        <div className="game-fact">
          <dt>{COPY.games.card.ending}</dt>
          <dd>{ENDING_LABEL[game.ending]}</dd>
        </div>
        <div className="game-fact">
          <dt>{COPY.games.card.moves}</dt>
          <dd>{COPY.gamesList.ply(game.moveCount)}</dd>
        </div>
        <div className="game-fact">
          <dt>{COPY.games.card.clock}</dt>
          <dd className={clocksOk ? 'fact-ok' : 'fact-warn'}>{clocks}</dd>
        </div>
        {game.timeControl ? (
          <div className="game-fact">
            <dt>{COPY.games.card.timeControl}</dt>
            <dd>{game.timeControl}</dd>
          </div>
        ) : null}
      </dl>
      {!game.includeInStats ? (
        <span className="meta-excluded">{COPY.games.excluded}</span>
      ) : null}
    </div>
  );
}

/**
 * What: asks which pasted player is the one being sensed, or states who will be counted.
 * Why: one game or a rematch series has two names in every game; only the player knows which is theirs.
 * Removed: the report would score the opponent's moves against the player's pulse.
 */
export function PlayerQuestion({
  candidates,
  selected,
  groupName,
  onChoose,
}: {
  candidates: readonly string[];
  selected: PlayerChoice | null;
  groupName: string;
  onChoose: (choice: PlayerChoice) => void;
}) {
  if (candidates.length === 1 && candidates[0]) {
    return <p className="player-note">{COPY.games.player.single(candidates[0])}</p>;
  }
  if (candidates.length === 0) {
    return <p className="player-note tone-warn">{COPY.games.player.none}</p>;
  }
  const helpId = `${groupName}-help`;
  return (
    <fieldset className="player-question" aria-describedby={helpId}>
      <legend>{COPY.games.player.legend}</legend>
      <p id={helpId} className="player-help">{COPY.games.player.help}</p>
      <div className="player-options">
        {candidates.map((name) => (
          <label key={name} className="player-option">
            <input
              type="radio"
              name={groupName}
              value={name}
              checked={selected?.kind === 'player' && sameName(selected.name, name)}
              onChange={() => onChoose({ kind: 'player', name })}
            />
            <span>{name}</span>
          </label>
        ))}
        <label className="player-option player-option-both">
          <input
            type="radio"
            name={groupName}
            value=""
            checked={selected?.kind === 'all'}
            onChange={() => onChoose({ kind: 'all' })}
          />
          <span>{COPY.games.player.both}</span>
        </label>
      </div>
      {selected === null ? <p className="player-required">{COPY.games.player.required}</p> : null}
    </fieldset>
  );
}

function pastedGames(validation: PasteValidation): PasteGameSummary[] {
  return validation.slots.flatMap((slot) =>
    slot.status === 'valid' || slot.status === 'order_error' ? [slot.game] : [],
  );
}

function rememberedChoice(candidates: readonly string[], remembered: string | null): PlayerChoice | null {
  if (!remembered) return null;
  const name = candidates.find((candidate) => sameName(candidate, remembered));
  return name ? { kind: 'player', name } : null;
}

function formatCounts(summary: PasteValidation['summary']): string {
  const parts = [
    COPY.games.counts.game(summary.total),
    COPY.games.counts.inAccuracy(summary.includedInStats),
  ];
  if (summary.aborted > 0) parts.push(COPY.games.counts.aborted(summary.aborted));
  if (summary.abandoned > 0) parts.push(COPY.games.counts.abandoned(summary.abandoned));
  return COPY.gamesList.summary(parts);
}

function toneFor(state: PasteState): 'neutral' | 'ok' | 'warn' {
  if (state === 'valid') return 'ok';
  if (state === 'out_of_order' || state === 'clockless' || state === 'invalid') return 'warn';
  return 'neutral';
}
