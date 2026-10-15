// 앱 설정 (API 키, 모델 등) — 이 기기의 브라우저 저장소에만 둔다.
// lib/ 모듈들은 서버판처럼 process.env에서 설정을 읽으므로, 여기서 그 모양을 만들어 준다.
// 이 파일은 다른 모듈보다 먼저 import되어야 한다.

const KEY = "hsim.app.settings";

export const DEFAULTS = {
  GEMINI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_MODEL: "gemini-3.8-flash",
  CLAUDE_MODEL: "claude-sonnet-5-5",
  DEFAULT_MODE: "gemini-first",
  COOLDOWN_MINUTES: "10",
  HISTORY_TURNS: "10",
  HISTORY_CHARS: "120000",
  RECORD_EVERY: "5",
  MAX_OUTPUT_TOKENS: "8000",
  TEMPERATURE: "",
  MOCK: "",        // "1"이면 API 없이 테스트 응답
  MOCK_FAIL: "",   // 모의 모드에서 일부러 실패시킬 쪽 (예: "gemini")
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = String(s[k] ?? "").trim();
  try { localStorage.setItem(KEY, JSON.stringify(clean)); return true; } catch { return false; }
}

export function hasKeys(s = loadSettings()) {
  return !!(s.GEMINI_API_KEY || s.ANTHROPIC_API_KEY || s.MOCK === "1");
}

// 빈 값은 빼서, 각 모듈의 기본값이 쓰이게 한다
const env = {};
for (const [k, v] of Object.entries(loadSettings())) if (v !== "" && v != null) env[k] = String(v);
globalThis.process = globalThis.process || { env };
