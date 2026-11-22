import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstIllegalMove, illegalMoveMessage, positionsFromMoves, terminalAt } from './positions.js';

describe('positionsFromMoves', () => {
  it('records the board after a legal move', () => {
    const positions = positionsFromMoves(['e4']);
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.illegal, false);
    assert.equal(
      positions[0]?.fenAfter,
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    );
  });

  it('stops at an illegal move and does not invent the next board', () => {
    const positions = positionsFromMoves(['e4', 'e4', 'Nf3']);
    assert.equal(positions.length, 2);
    assert.equal(positions[1]?.san, 'e4');
    assert.equal(positions[1]?.illegal, true);
    assert.equal(positions[1]?.fenAfter, undefined);
  });

  it('rejects a capture written without the capture mark', () => {
    const loose = positionsFromMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Ne5']);
    assert.equal(loose.at(-1)?.san, 'Ne5');
    assert.equal(loose.at(-1)?.illegal, true);
    const captured = positionsFromMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Nxe5']);
    assert.equal(captured.at(-1)?.san, 'Nxe5');
    assert.equal(captured.at(-1)?.illegal, false);
  });

  it('marks a checkmated position as terminal so the engine can be skipped', () => {
    assert.equal(terminalAt('R5k1/5ppp/8/8/8/8/8/6K1 b'), 'checkmate');
    const mate = positionsFromMoves(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']).at(-1);
    assert.equal(mate?.san, 'Qxf7#');
    assert.equal(mate?.terminalAfter, 'checkmate');
  });

  it('marks a stalemated position as terminal', () => {
    assert.equal(terminalAt('7k/5Q2/6K1/8/8/8/8/8 b'), 'stalemate');
    assert.equal(terminalAt('6k1/5ppp/8/8/8/8/8/R5K1 w'), null);
  });

  it('names the first illegal move by full move number', () => {
    const shuffle = Array.from({ length: 11 }, () => ['Nf3', 'Nf6', 'Ng1', 'Ng8']).flat();
    assert.equal(shuffle.length, 44);
    const illegal = firstIllegalMove([...shuffle, 'e5']);
    assert.ok(illegal);
    assert.equal(illegal.moveIndex, 44);
    assert.equal(illegal.moveNumber, 23);
    assert.equal(illegal.san, 'e5');
    assert.equal(
      illegalMoveMessage(2, illegal),
      'Game 2, move 23 (e5) is not legal from this position. Check that the PGN came from chess.com.',
    );
  });

  it('returns no illegal move for a legal game', () => {
    assert.equal(firstIllegalMove(['e4', 'e5', 'Nf3', 'Nc6']), null);
  });
});
