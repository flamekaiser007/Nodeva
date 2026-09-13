import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reputationEffect } from '../src/providers/reputation.js';
import { SETTLEMENT } from '../src/reservations/machine.js';

test('a successful job counts toward reliability', () => {
  assert.equal(reputationEffect('completed'), 'success');
});

test("the user's own bad code does not count against the provider", () => {
  assert.equal(reputationEffect('failed_user'), 'success',
    'a node that ran the job faithfully is not less reliable because the workload crashed');
});

test('a provider-side failure counts against reliability', () => {
  assert.equal(reputationEffect('failed_provider'), 'failure');
});

test('a booking that never ran a job carries no reputation signal', () => {
  assert.equal(reputationEffect('expired'), null);
  assert.equal(reputationEffect('cancelled'), null);
});

test('every terminal settlement outcome the state machine defines has an explicit policy', () => {
  // Not "falls through to a default" -- every key in SETTLEMENT must be a
  // conscious decision here, so a new terminal state added to the machine
  // without updating this file fails loudly instead of silently drifting.
  for (const outcome of Object.keys(SETTLEMENT)) {
    assert.doesNotThrow(() => reputationEffect(outcome));
    assert.ok(['success', 'failure', null].includes(reputationEffect(outcome)));
  }
});
