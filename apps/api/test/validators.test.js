const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidPhoneNumber, isValidAmount, isValidName, isValidPin } = require('../src/utils/validators');

test('isValidPhoneNumber accepts plausible numbers', () => {
  assert.equal(isValidPhoneNumber('+2348000000000'), true);
  assert.equal(isValidPhoneNumber('1234567'), true);
});

test('isValidPhoneNumber rejects empty, short, or non-string input', () => {
  assert.equal(isValidPhoneNumber(''), false);
  assert.equal(isValidPhoneNumber('12345'), false); // length 5 is not > 5
  assert.equal(isValidPhoneNumber('   '), false);
  assert.equal(isValidPhoneNumber(undefined), false);
  assert.equal(isValidPhoneNumber(2348000000000), false); // not a string
});

test('isValidAmount accepts positive finite numbers and numeric strings', () => {
  assert.equal(isValidAmount('5'), true);
  assert.equal(isValidAmount('2.5'), true);
  assert.equal(isValidAmount(10), true);
});

test('isValidAmount rejects zero, negatives, and non-numeric input', () => {
  assert.equal(isValidAmount('0'), false);
  assert.equal(isValidAmount('-3'), false);
  assert.equal(isValidAmount('abc'), false);
  assert.equal(isValidAmount(''), false);
  assert.equal(isValidAmount(undefined), false);
});

test('isValidName accepts plausible names', () => {
  assert.equal(isValidName('Ada'), true);
  assert.equal(isValidName('Evan Ezedike'), true);
});

test('isValidName rejects too short, too long, empty, or non-string input', () => {
  assert.equal(isValidName('A'), false);
  assert.equal(isValidName(''), false);
  assert.equal(isValidName('   '), false);
  assert.equal(isValidName('a'.repeat(61)), false);
  assert.equal(isValidName(undefined), false);
  assert.equal(isValidName(123), false);
});

test('isValidPin accepts 4 to 6 digit numeric PINs', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('123456'), true);
  assert.equal(isValidPin(1234), true); // coerced to string
});

test('isValidPin rejects wrong length, non-numeric, or empty input', () => {
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('1234567'), false);
  assert.equal(isValidPin('12a4'), false);
  assert.equal(isValidPin(''), false);
  assert.equal(isValidPin(undefined), false);
});
