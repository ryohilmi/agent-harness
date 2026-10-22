/**
 * Safe arithmetic evaluator.
 *
 * The Python original used `eval` with a character whitelist. This parser
 * accepts the same character set (digits, operators, parentheses, decimal
 * points, percent signs and spaces) without ever evaluating code.
 *
 * Supported: + - * / // % ** parentheses, unary +/-.
 */

const ALLOWED = /^[0-9+\-*/(). %]*$/;

class ExpressionError extends Error {}

class Parser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parse(): number {
    const value = this.parseAdditive();
    this.skipSpaces();
    if (this.pos < this.source.length) {
      throw new ExpressionError(
        `unexpected character '${this.source[this.pos]}'`,
      );
    }
    return value;
  }

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? '';
  }

  private eat(text: string): boolean {
    if (this.source.startsWith(text, this.pos)) {
      this.pos += text.length;
      return true;
    }
    return false;
  }

  private skipSpaces(): void {
    while (this.peek() === ' ') this.pos += 1;
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative();

    for (;;) {
      this.skipSpaces();
      if (this.eat('+')) {
        value += this.parseMultiplicative();
      } else if (this.eat('-')) {
        value -= this.parseMultiplicative();
      } else {
        return value;
      }
    }
  }

  private parseMultiplicative(): number {
    let value = this.parseUnary();

    for (;;) {
      this.skipSpaces();
      if (this.eat('//')) {
        value = this.floorDivide(value, this.parseUnary());
      } else if (this.peek() === '/' && this.peek(1) !== '/') {
        this.pos += 1;
        const right = this.parseUnary();
        if (right === 0) throw new ExpressionError('division by zero');
        value /= right;
      } else if (this.eat('%')) {
        value = this.modulo(value, this.parseUnary());
      } else if (this.peek() === '*' && this.peek(1) !== '*') {
        this.pos += 1;
        value *= this.parseUnary();
      } else {
        return value;
      }
    }
  }

  private parseUnary(): number {
    this.skipSpaces();
    if (this.eat('+')) return this.parseUnary();
    if (this.eat('-')) return -this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    this.skipSpaces();
    if (this.eat('**')) {
      // Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2)
      return base ** this.parseUnary();
    }
    return base;
  }

  private parsePrimary(): number {
    this.skipSpaces();

    if (this.eat('(')) {
      const value = this.parseAdditive();
      this.skipSpaces();
      if (!this.eat(')')) throw new ExpressionError('missing closing parenthesis');
      return value;
    }

    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(this.source.slice(this.pos));
    if (!match) throw new ExpressionError('invalid syntax');

    this.pos += match[0].length;
    return Number(match[0]);
  }

  private floorDivide(left: number, right: number): number {
    if (right === 0) throw new ExpressionError('division by zero');
    return Math.floor(left / right);
  }

  private modulo(left: number, right: number): number {
    if (right === 0) throw new ExpressionError('modulo by zero');
    // Python's % keeps the sign of the divisor.
    return ((left % right) + right) % right;
  }
}

export function evaluateExpression(expression: string): string {
  if (!ALLOWED.test(expression)) {
    return 'Error: expression contains disallowed characters.';
  }

  try {
    const value = new Parser(expression).parse();
    return String(value);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
