import test from "node:test";
import assert from "node:assert/strict";
import { formatNumber, parseNumber } from "../dist/index.js";

test("numbers format with en-US decimals and configurable precision/grouping", () => {
  assert.equal(formatNumber(1234.567), "1234.57");
  assert.equal(formatNumber(1234.5, { useGrouping: true, minimumFractionDigits: 2 }), "1,234.50");
  assert.equal(formatNumber(1.2345, { maximumFractionDigits: 3 }), "1.235");
  assert.throws(() => formatNumber(Infinity), /finite/);
});

test("parsing accepts comma or dot decimals, signs, surrounding whitespace and zero", () => {
  for (const [text, expected] of [[" 12,5 ", 12.5], ["12.5", 12.5], ["-.5", -0.5], ["+,25", 0.25], ["0", 0], ["1,", 1]]) {
    assert.equal(parseNumber(text), expected);
  }
  assert.equal(parseNumber(formatNumber(1234.5)), 1234.5);
});

test("parsing rejects empty, ambiguous, grouped, non-finite and partial input", () => {
  for (const text of ["", " ", "1,234.5", "1.234,5", "1 234", "1,2,3", "NaN", "Infinity", "2m", "0x10", "1e3", "--1", ".", "9".repeat(400)]) {
    assert.equal(parseNumber(text), null, text);
  }
  assert.equal(parseNumber("1,234"), 1.234);
});
