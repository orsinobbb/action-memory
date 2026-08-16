const OPERATIONS = {
  "+": (left, right) => left + right,
  "−": (left, right) => left - right,
  "×": (left, right) => left * right,
  "÷": (left, right) => left / right
};

export function createCalculatorState() {
  return {
    display: "0",
    accumulator: null,
    pendingOperator: null,
    waitingForOperand: false
  };
}

function errorState() {
  return { ...createCalculatorState(), display: "錯誤", waitingForOperand: true };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "錯誤";
  const rounded = Number.parseFloat(value.toPrecision(12));
  const regular = String(rounded);
  return regular.length <= 14 ? regular : rounded.toExponential(8);
}

function perform(left, right, operator) {
  const operation = OPERATIONS[operator];
  if (!operation || (operator === "÷" && right === 0)) return null;
  const value = operation(left, right);
  return Number.isFinite(value) ? value : null;
}

function inputDigit(state, digit) {
  if (state.display === "錯誤" || state.waitingForOperand) {
    return { ...state, display: digit, waitingForOperand: false };
  }
  if (state.display === "0") return { ...state, display: digit };
  if (state.display.replace("-", "").replace(".", "").length >= 12) return state;
  return { ...state, display: `${state.display}${digit}` };
}

function inputDecimal(state) {
  if (state.display === "錯誤" || state.waitingForOperand) {
    return { ...state, display: "0.", waitingForOperand: false };
  }
  if (state.display.includes(".")) return state;
  return { ...state, display: `${state.display}.` };
}

function chooseOperator(state, operator) {
  if (!OPERATIONS[operator]) return state;
  if (state.display === "錯誤") return createCalculatorState();
  if (state.waitingForOperand && state.pendingOperator) {
    return { ...state, pendingOperator: operator };
  }

  const inputValue = Number(state.display);
  let accumulator = state.accumulator;
  let display = state.display;

  if (accumulator === null) {
    accumulator = inputValue;
  } else if (state.pendingOperator) {
    const result = perform(accumulator, inputValue, state.pendingOperator);
    if (result === null) return errorState();
    accumulator = result;
    display = formatNumber(result);
  }

  return { display, accumulator, pendingOperator: operator, waitingForOperand: true };
}

function calculate(state) {
  if (state.accumulator === null || !state.pendingOperator || state.display === "錯誤") return state;
  const result = perform(state.accumulator, Number(state.display), state.pendingOperator);
  if (result === null) return errorState();
  return {
    display: formatNumber(result),
    accumulator: null,
    pendingOperator: null,
    waitingForOperand: true
  };
}

function toggleSign(state) {
  if (state.display === "錯誤" || Number(state.display) === 0) return state;
  return {
    ...state,
    display: state.display.startsWith("-") ? state.display.slice(1) : `-${state.display}`,
    waitingForOperand: false
  };
}

function applyPercent(state) {
  if (state.display === "錯誤") return state;
  return { ...state, display: formatNumber(Number(state.display) / 100), waitingForOperand: false };
}

function backspace(state) {
  if (state.display === "錯誤" || state.waitingForOperand) return state;
  const next = state.display.slice(0, -1);
  return { ...state, display: next && next !== "-" ? next : "0" };
}

export function calculatorReducer(state, action) {
  switch (action.type) {
    case "digit": return inputDigit(state, action.value);
    case "decimal": return inputDecimal(state);
    case "operator": return chooseOperator(state, action.value);
    case "equals": return calculate(state);
    case "sign": return toggleSign(state);
    case "percent": return applyPercent(state);
    case "backspace": return backspace(state);
    case "clear": return createCalculatorState();
    default: return state;
  }
}
