import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAYER_PREFERENCE_KEY,
  playerCandidates,
  plyBelongsTo,
  readRememberedPlayer,
  rememberPlayer,
  resolvePlayer,
  sideInGame,
  type NamedGame,
} from './player.js';

const game = (white: string, black: string, includeInStats = true): NamedGame => ({ white, black, includeInStats });

describe('playerCandidates', () => {
  it('finds the one name present in every counted game', () => {
    assert.deepEqual(playerCandidates([game('Ada', 'Nim'), game('Bo', 'ada'), game('ADA', 'Cy')]), ['Ada']);
  });

  it('keeps both names when one game or a rematch series cannot tell them apart', () => {
    assert.deepEqual(playerCandidates([game('Ada', 'Nim')]), ['Ada', 'Nim']);
    assert.deepEqual(playerCandidates([game('Ada', 'Nim'), game('Nim', 'Ada')]), ['Ada', 'Nim']);
  });

  it('ignores aborted or abandoned games, which do not count toward accuracy', () => {
    assert.deepEqual(playerCandidates([game('Ada', 'Nim'), game('Bo', 'Cy', false), game('Ada', 'Dee')]), ['Ada']);
  });

  it('returns nothing when no name is shared or no game counts', () => {
    assert.deepEqual(playerCandidates([game('Ada', 'Nim'), game('Bo', 'Cy')]), []);
    assert.deepEqual(playerCandidates([game('Ada', 'Nim', false)]), []);
    assert.deepEqual(playerCandidates([game('', ''), game('', '')]), []);
  });

  it('lists a self-paired name once', () => {
    assert.deepEqual(playerCandidates([game(' Ada ', 'ada')]), ['Ada']);
  });
});

describe('resolvePlayer', () => {
  it('chooses the only shared name without asking', () => {
    assert.deepEqual(resolvePlayer([game('Ada', 'Nim'), game('Bo', 'Ada')]), {
      ok: true,
      scope: { kind: 'player', name: 'Ada' },
    });
  });

  it('counts both sides when two names are shared and none was chosen', () => {
    assert.deepEqual(resolvePlayer([game('Ada', 'Nim')]), {
      ok: true,
      scope: { kind: 'all_moves', reason: 'ambiguous' },
    });
  });

  it('counts both sides when no name is shared', () => {
    assert.deepEqual(resolvePlayer([game('Ada', 'Nim'), game('Bo', 'Cy')]), {
      ok: true,
      scope: { kind: 'all_moves', reason: 'no_common_name' },
    });
  });

  it('accepts a chosen name case-insensitively and reports the PGN spelling', () => {
    assert.deepEqual(resolvePlayer([game('Ada', 'Nim')], '  nim '), {
      ok: true,
      scope: { kind: 'player', name: 'Nim' },
    });
  });

  it('refuses a chosen name that is missing from a counted game', () => {
    const result = resolvePlayer([game('Ada', 'Nim'), game('Ada', 'Bo')], 'Nim');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /not in every pasted game/);
  });
});

describe('sideInGame and plyBelongsTo', () => {
  it('maps the scoped player to the side they had', () => {
    const scope = { kind: 'player', name: 'Ada' } as const;
    assert.equal(sideInGame(game('Ada', 'Nim'), scope), 'white');
    assert.equal(sideInGame(game('Nim', 'ADA'), scope), 'black');
    assert.equal(sideInGame(game('Ada', 'Ada'), scope), 'both');
    assert.equal(sideInGame(game('Ada', 'Nim'), { kind: 'all_moves', reason: 'ambiguous' }), 'both');
  });

  it('gives even plies to White and odd plies to Black', () => {
    assert.deepEqual([0, 1, 2, 3].map((ply) => plyBelongsTo('white', ply)), [true, false, true, false]);
    assert.deepEqual([0, 1, 2, 3].map((ply) => plyBelongsTo('black', ply)), [false, true, false, true]);
    assert.deepEqual([0, 1, 2, 3].map((ply) => plyBelongsTo('both', ply)), [true, true, true, true]);
  });
});

describe('remembered player', () => {
  function memoryStore() {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  it('stores a trimmed username and reads it back', () => {
    const store = memoryStore();
    assert.equal(rememberPlayer(store, '  Ada '), true);
    assert.equal(store.values.get(PLAYER_PREFERENCE_KEY), 'Ada');
    assert.equal(readRememberedPlayer(store), 'Ada');
  });

  it('treats a missing, empty, oversized, or throwing store as no remembered player', () => {
    assert.equal(readRememberedPlayer(null), null);
    const store = memoryStore();
    store.values.set(PLAYER_PREFERENCE_KEY, 'x'.repeat(65));
    assert.equal(readRememberedPlayer(store), null);
    assert.equal(rememberPlayer(store, '   '), false);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    assert.equal(readRememberedPlayer(broken), null);
    assert.equal(rememberPlayer(broken, 'Ada'), false);
  });
});
