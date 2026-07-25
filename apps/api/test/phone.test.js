const test = require('node:test');
const assert = require('node:assert');

const { digitsOnly, looksLikePhone, phoneCandidates } = require('../src/utils/phone');

test('digitsOnly strips formatting', () => {
  assert.strictEqual(digitsOnly('+234 (801) 234-5678'), '2348012345678');
  assert.strictEqual(digitsOnly(null), '');
});

test('looksLikePhone accepts the forms users actually type', () => {
  for (const input of ['08012345678', '2348012345678', '+234 801 234 5678', '+2348012345678']) {
    assert.strictEqual(looksLikePhone(input), true, input);
  }
});

test('looksLikePhone rejects names and addresses', () => {
  for (const input of ['mum', 'Ada', '0x1234', '', '   ', '12345']) {
    assert.strictEqual(looksLikePhone(input), false, input);
  }
});

// Local, international and bare forms of one number must all resolve to the
// same set, or a recipient stored one way is invisible when typed another.
test('phoneCandidates bridges local and international spellings', () => {
  const local = phoneCandidates('08012345678');
  const international = phoneCandidates('2348012345678');
  const plus = phoneCandidates('+234 801 234 5678');

  for (const set of [local, international, plus]) {
    assert.ok(set.includes('08012345678'), `missing local form in ${set}`);
    assert.ok(set.includes('2348012345678'), `missing international form in ${set}`);
    assert.ok(set.includes('+2348012345678'), `missing +international form in ${set}`);
  }
});

test('phoneCandidates handles a bare subscriber number', () => {
  const candidates = phoneCandidates('8012345678');
  assert.ok(candidates.includes('2348012345678'));
  assert.ok(candidates.includes('08012345678'));
});

test('phoneCandidates returns nothing for non-numeric input', () => {
  assert.deepStrictEqual(phoneCandidates('mum'), []);
  assert.deepStrictEqual(phoneCandidates(''), []);
});
