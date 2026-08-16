import test from "node:test";
import assert from "node:assert/strict";
import { calculatorReducer, createCalculatorState } from "../src/calculator.js";

function press(...actions) {
  return actions.reduce((state, action) => calculatorReducer(state, action), createCalculatorState());
}

const digit = (value) => ({ type: "digit", value });
const operator = (value) => ({ type: "operator", value });

test("計算基本加法", () => {
  const state = press(digit("1"), digit("2"), operator("+"), digit("3"), { type: "equals" });
  assert.equal(state.display, "15");
});

test("連續運算採一般隨手機的逐步計算", () => {
  const state = press(digit("5"), operator("+"), digit("2"), operator("×"), digit("3"), { type: "equals" });
  assert.equal(state.display, "21");
});

test("修正常見浮點顯示誤差", () => {
  const state = press(digit("0"), { type: "decimal" }, digit("1"), operator("+"), digit("0"), { type: "decimal" }, digit("2"), { type: "equals" });
  assert.equal(state.display, "0.3");
});

test("支援百分比與正負號", () => {
  const state = press(digit("2"), digit("5"), { type: "percent" }, { type: "sign" });
  assert.equal(state.display, "-0.25");
});

test("除以零顯示錯誤，下一個數字可重新開始", () => {
  const failed = press(digit("8"), operator("÷"), digit("0"), { type: "equals" });
  assert.equal(failed.display, "錯誤");
  assert.equal(calculatorReducer(failed, digit("4")).display, "4");
});
