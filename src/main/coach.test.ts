import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample } from '../shared/contracts.js';
import { BetweenGamesCoach, COACH_RECENT_WINDOW_US } from './coach.js';
import { baselineFromSamples } from './session.js';

const START_US = 1_000_000;

function sample(tUs: number, bpm: number, confidence = 80, stable = true): PulseSample {
  return { tUs: START_US + tUs, bpm, confidence, stable };
}

function restingMinute(): PulseSample[] {
  return [sample(0, 70), sample(30_000_000, 70), sample(59_000_000, 70)];
}

describe('BetweenGamesCoach', () => {
  it('stays silent during a game and until the first baseline minute is complete', () => {
    const coach = new BetweenGamesCoach(START_US);
    assert.equal(coach.ingest([...restingMinute(), sample(61_000_000, 90)]), null);

    assert.equal(coach.setBetweenGames(true), null);
    const early = new BetweenGamesCoach(START_US);
    early.setBetweenGames(true);
    assert.equal(early.ingest([sample(0, 70), sample(30_000_000, 90)]), null);
  });

  it('fires at baseline plus 10 using the trailing-minute median and shows the numbers', () => {
    const coach = new BetweenGamesCoach(START_US);
    coach.ingest(restingMinute());
    coach.setBetweenGames(true);

    assert.deepEqual(coach.ingest([sample(61_000_000, 80), sample(62_000_000, 90), sample(63_000_000, 80)]), {
      baselineBpm: 70,
      recentBpm: 80,
      deltaBpm: 10,
      text: 'Pulse still +10 over baseline. Take a real break before the next game.',
    });
  });

  it('does not let weak or unstable samples create a coach line', () => {
    const weak = new BetweenGamesCoach(START_US);
    weak.ingest(restingMinute());
    weak.setBetweenGames(true);
    // The baseline samples are outside this trailing window, so an unfiltered 95 would fire.
    assert.equal(weak.ingest([sample(121_000_000, 95, 10)]), null);

    const unstable = new BetweenGamesCoach(START_US);
    unstable.ingest(restingMinute());
    unstable.setBetweenGames(true);
    assert.equal(unstable.ingest([sample(121_000_000, 95, 80, false)]), null);
  });

  it('isolates the between-games guard from the elevated threshold', () => {
    const coach = new BetweenGamesCoach(START_US);
    coach.ingest(restingMinute());
    assert.equal(coach.ingest([sample(121_000_000, 90)]), null);
    assert.equal(coach.ingest([sample(122_000_000, 90)]), null);
    const message = coach.setBetweenGames(true);
    assert.equal(message?.baselineBpm, 70);
    assert.equal(message?.recentBpm, 90);
    assert.equal(message?.deltaBpm, 20);
  });

  it('fires once per gap and clears the latch for the next gap only', () => {
    const coach = new BetweenGamesCoach(START_US);
    coach.ingest(restingMinute());
    coach.setBetweenGames(true);

    assert.notEqual(
      coach.ingest([sample(60_000_000, 90), sample(61_000_000, 90), sample(62_000_000, 90)]),
      null,
    );
    assert.equal(coach.ingest([sample(63_000_000, 91)]), null);
    assert.equal(coach.setBetweenGames(true), null);

    coach.setBetweenGames(false);
    assert.notEqual(coach.setBetweenGames(true), null);
    assert.equal(coach.ingest([sample(64_000_000, 92)]), null);
  });

  it('computes the baseline once when the first minute completes', () => {
    let calls = 0;
    const coach = new BetweenGamesCoach(START_US, (samples, startUs) => {
      calls += 1;
      return baselineFromSamples(samples, startUs);
    });

    coach.ingest(restingMinute());
    assert.equal(calls, 0);
    coach.ingest([sample(61_000_000, 90)]);
    assert.equal(calls, 1);
    coach.ingest([sample(62_000_000, 95)]);
    coach.setBetweenGames(true);
    coach.ingest([sample(63_000_000, 95)]);
    assert.equal(calls, 1);
  });

  it('keeps the retained window bounded across a long synthetic session', () => {
    const coach = new BetweenGamesCoach(START_US);
    const samplesPerMinute = 60;
    for (let minute = 0; minute < 120; minute += 1) {
      const batch = Array.from({ length: samplesPerMinute }, (_unused, second) =>
        sample((minute * samplesPerMinute + second) * 1_000_000, 70),
      );
      coach.ingest(batch);
      assert.ok(
        coach.retainedSampleCount <= 601,
        `retained ${coach.retainedSampleCount} samples after minute ${minute}`,
      );
    }
    assert.ok(
      coach.retainedSampleCount <= COACH_RECENT_WINDOW_US / 1_000_000 + 1,
      `retained ${coach.retainedSampleCount} samples`,
    );
  });

  it('keeps the computed baseline after the baseline minute leaves the window', () => {
    const coach = new BetweenGamesCoach(START_US);
    coach.ingest(restingMinute());
    for (let minute = 1; minute <= 20; minute += 1) {
      coach.ingest([sample(minute * 60_000_000, 70)]);
    }
    coach.setBetweenGames(true);
    const message = coach.ingest(
      Array.from({ length: 60 }, (_unused, second) =>
        sample(20 * 60_000_000 + (second + 1) * 1_000_000, 90),
      ),
    );
    assert.equal(message?.baselineBpm, 70);
    assert.equal(message?.recentBpm, 90);
  });
});
