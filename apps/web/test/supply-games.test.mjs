import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELTA_GAME_CODE, selectDeltaGame } from '../src/lib/supply-games.ts';

const game = (id, code) => ({ id, code, name: code, description: null });

test('the delta shelf matches only the confirmed delta identifier', () => {
  assert.equal(DELTA_GAME_CODE, 'delta');
  const delta = game('game-delta', 'delta');
  assert.deepEqual(selectDeltaGame([game('game-v', 'valorant'), delta]), delta);
});

test('the delta shelf never falls back to another game or an empty list', () => {
  assert.equal(selectDeltaGame([]), null);
  assert.equal(selectDeltaGame([game('game-v', 'valorant')]), null);
  assert.equal(selectDeltaGame([game('game-l', 'league'), game('game-v', 'valorant')]), null);
});
