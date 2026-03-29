const FIELD_LIMITS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 }
];

function range(min, max) {
  const values = [];
  for (let value = min; value <= max; value += 1) {
    values.push(value);
  }
  return values;
}

function normalizeDayOfWeek(value) {
  return value === 7 ? 0 : value;
}

function parseToken(part, min, max, normalize = (value) => value) {
  if (part === "*") {
    return new Set(range(min, max).map(normalize));
  }

  let base = part;
  let step = 1;

  if (part.includes("/")) {
    const split = part.split("/");
    if (split.length !== 2) {
      throw new Error(`Invalid cron token: ${part}`);
    }
    [base] = split;
    step = Number.parseInt(split[1], 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${part}`);
    }
  }

  let values = [];
  if (base === "*" || base === "") {
    values = range(min, max);
  } else if (base.includes("-")) {
    const [start, end] = base.split("-").map((item) => Number.parseInt(item, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }
    values = range(start, end);
  } else {
    const single = Number.parseInt(base, 10);
    if (!Number.isInteger(single)) {
      throw new Error(`Invalid cron value: ${part}`);
    }
    values = [single];
  }

  const stepped = values.filter((_, index) => index % step === 0);
  const normalized = stepped.map((value) => {
    if (value < min || value > max) {
      throw new Error(`Cron value out of range: ${part}`);
    }
    return normalize(value);
  });

  return new Set(normalized);
}

function parseField(field, min, max, normalize = (value) => value) {
  const parts = field.split(",");
  const values = new Set();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error("Cron field contains an empty token");
    }
    for (const value of parseToken(trimmed, min, max, normalize)) {
      values.add(value);
    }
  }

  return values;
}

export function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELD_LIMITS.length) {
    throw new Error("Cron expression must have 5 fields");
  }

  return fields.map((field, index) => {
    const limits = FIELD_LIMITS[index];
    const normalize = limits.name === "dayOfWeek" ? normalizeDayOfWeek : (value) => value;
    return {
      ...limits,
      values: parseField(field, limits.min, limits.max, normalize)
    };
  });
}

export function validateCron(expression) {
  parseCron(expression);
  return true;
}

export function matchesCron(expression, date) {
  const fields = parseCron(expression);
  const checks = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay()
  ];

  return fields.every((field, index) => field.values.has(checks[index]));
}

export function findNextRun(expression, fromDate = new Date()) {
  parseCron(expression);

  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let index = 0; index < 60 * 24 * 366; index += 1) {
    if (matchesCron(expression, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not find next run for cron: ${expression}`);
}
