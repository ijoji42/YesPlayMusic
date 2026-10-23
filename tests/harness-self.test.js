import { describe, it, assert } from './harness';

// Self-check: if this case ever fails, the runner or the harness is broken
// rather than the code under test.
describe('harness', () => {
  it('reports a passing assertion as a pass', () => {
    assert.equal(1, 1);
    assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
  });
});
