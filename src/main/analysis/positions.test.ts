import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { positionsFromMoves } from './positions.js';

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
});
