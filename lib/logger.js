const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function formatArgs(args) {
  return args.map(a =>
    a instanceof Error ? `${a.message}\n${a.stack}` :
    typeof a === "object" ? JSON.stringify(a) : String(a)
  ).join(" ");
}

function log(level, label, args) {
  if (LEVELS[level] < currentLevel) return;
  const ts = timestamp();
  const prefix = `${ts} [${label}]`;
  if (level === "error" || level === "warn") {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

const logger = {
  debug: (...args) => log("debug", "DEBUG", args),
  info: (...args) => log("info", "INFO", args),
  warn: (...args) => log("warn", "WARN", args),
  error: (...args) => log("error", "ERROR", args),

  setLevel(level) {
    if (level in LEVELS) currentLevel = LEVELS[level];
  },

  setDebug(enabled) {
    currentLevel = enabled ? LEVELS.debug : LEVELS.info;
  },
};

export default logger;
