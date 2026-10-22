import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression } from '../src/tools/calculator.js';

test('evaluates basic arithmetic', () => {
  assert.equal(evaluateExpression('12 * 34 + 5'), '413');
  assert.equal(evaluateExpression('(2 + 3) * 4'), '20');
  assert.equal(evaluateExpression('10 / 4'), '2.5');
  assert.equal(evaluateExpression('.5 + .5'), '1');
});

test('supports Python-style operators', () => {
  assert.equal(evaluateExpression('2 ** 3 ** 2'), '512');
  assert.equal(evaluateExpression('-2 ** 2'), '-4');
  assert.equal(evaluateExpression('10 // 3'), '3');
  assert.equal(evaluateExpression('-10 % 3'), '2');
});

test('rejects code and non-arithmetic input', () => {
  assert.equal(
    evaluateExpression('alert(1)'),
    'Error: expression contains disallowed characters.',
  );
  assert.equal(
    evaluateExpression('12 * 34 plus 5'),
    'Error: expression contains disallowed characters.',
  );
});

test('reports parse and math errors', () => {
  assert.equal(evaluateExpression('1 / 0'), 'Error: division by zero');
  assert.equal(evaluateExpression('5 % 0'), 'Error: modulo by zero');
  assert.equal(evaluateExpression('2 +'), 'Error: invalid syntax');
  assert.equal(evaluateExpression('(1 + 2'), 'Error: missing closing parenthesis');
});
