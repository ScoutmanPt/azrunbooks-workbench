/**
 * Unit tests for SubscriptionColorRegistry.
 * No vscode dependency - runs cleanly in Node.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionColorRegistry, SUBSCRIPTION_COLORS } from '../src/subscriptionColorRegistry.js';

describe('SubscriptionColorRegistry', () => {
  it('assigns a non-empty color string to a new subscription', () => {
    const r = new SubscriptionColorRegistry();
    const color = r.getColor('sub-aaa');
    assert.equal(typeof color, 'string');
    assert.ok(color.length > 0);
  });

  it('returns the same color on repeated calls (stable)', () => {
    const r = new SubscriptionColorRegistry();
    assert.equal(r.getColor('sub-bbb'), r.getColor('sub-bbb'));
  });

  it('assigns colors from the known palette', () => {
    const r = new SubscriptionColorRegistry();
    const color = r.getColor('sub-ccc');
    assert.ok(SUBSCRIPTION_COLORS.includes(color));
  });

  it('assigns different colors to different subscriptions', () => {
    const r = new SubscriptionColorRegistry();
    const colors = new Set(
      Array.from({ length: SUBSCRIPTION_COLORS.length }, (_, i) => r.getColor(`sub-${i}`))
    );
    // All palette slots used → all unique
    assert.equal(colors.size, SUBSCRIPTION_COLORS.length);
  });

  it('wraps around after exhausting the palette (no throw)', () => {
    const r = new SubscriptionColorRegistry();
    const results = Array.from({ length: SUBSCRIPTION_COLORS.length + 3 }, (_, i) =>
      r.getColor(`sub-wrap-${i}`)
    );
    assert.equal(results.length, SUBSCRIPTION_COLORS.length + 3);
    assert.ok(results.every(c => typeof c === 'string' && c.length > 0));
  });

  it('each registry instance is independent', () => {
    const r1 = new SubscriptionColorRegistry();
    const r2 = new SubscriptionColorRegistry();
    // Both start fresh - first color should be the same
    assert.equal(r1.getColor('sub-x'), r2.getColor('sub-x'));
  });
});
