// 제미나이·Claude API 호출과 자동 전환
// 두 회사 API를 같은 모양(system + messages → 스트리밍 텍스트)으로 맞춰 쓴다.

const env = process.env;
const CFG = {
  gemini: {
    label: "제미나이",
    key: env.GEMINI_API_KEY || "",
    model: env.GEMINI_MODEL || "gemini-3.8-flash",
  },
  claude: {
    label: "Claude",
    key: env.ANTHROPIC_API_KEY || "",
    model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
  },
};
const MAX_TOKENS = Number(env.MAX_OUTPUT_TOKENS || 8000);
// 비워 두면 각 모델의 기본값을 쓴다 (일부 모델은 temperature 지정을 받지 않음)
const TEMPERATURE = env.TEMPERATURE ? Number(env.TEMPERATURE) : undefined;
// 제미나이 우선: 한도에 걸려도 짧게만 미뤘다가 다시 제미나이부터 시도한다
const COOLDOWN_MIN = Number(env.COOLDOWN_MINUTES || 10);
const MOCK = env.MOCK === "1";

export class ProviderError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;     // quota | auth | too_large | overloaded | network | refused | bad_request | aborted | no_key
    this.status = status || 0;
  }
}

// 한도에 걸린 쪽은 잠시 건너뛴다 (매 턴 실패 요청을 보내 시간 낭비하지 않도록)
const cooldown = { gemini: 0, claude: 0 };

export function providerStatus() {
  const now = Date.now();
  const out = {};
  for (const [id, c] of Object.entries(CFG)) {
    out[id] = {
      label: c.label,
      model: c.model,
      configured: MOCK || !!c.key,
      coolingUntil: cooldown[id] > now ? cooldown[id] : 0,
    };
  }
  return out;
}
export function setCooldown(id, until) {
  if (id in cooldown) cooldown[id] = Number(until) || 0;
}
export function resetCooldown(id) {
  if (id) cooldown[id] = 0; else { cooldown.gemini = 0; cooldown.claude = 0; }
}

function classify(status, bodyText) {
  const t = String(bodyText || "");
  if (/credit balance|billing|quota|exhaust|insufficient|spending|prepay/i.test(t)) return "quota";
  if (status === 429 || status === 402) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 413 || /too long|too large|exceeds the maximum|token count/i.test(t)) return "too_large";
  if (status >= 500) return "overloaded";
  return "bad_request";
}
function shortMsg(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    return (j.error && (j.error.message || j.error.type)) || bodyText.slice(0, 300);
  } catch { return String(bodyText).slice(0, 300); }
}

// Server-Sent Events 응답을 한 줄씩 읽어 data: JSON을 넘긴다
async function readSSE(res, onData, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal && signal.aborted) throw new ProviderError("aborted", "중단됨");
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        onData(j);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function post(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal && signal.aborted) throw new ProviderError("aborted", "중단됨");
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const raw = e.cause?.code || e.message || "";
    // 브라우저는 네트워크 오류를 "Failed to fetch"(크롬)·"Load failed"(사파리)로만 알려 준다
    const msg = offline ? "인터넷 연결 없음" : /Failed to fetch|Load failed|NetworkError/i.test(raw) ? "서버에 닿지 못함" : raw;
    throw new ProviderError("network", msg);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new ProviderError(classify(res.status, t), shortMsg(t) || `HTTP ${res.status}`, res.status);
  }
  return res;
}

/* ---------- 제미나이 ---------- */
async function callGemini({ system, messages, maxTokens, signal, onText }) {
  const c = CFG.gemini;
  if (!c.key) throw new ProviderError("no_key", "제미나이 API 키가 없어요 (설정에서 입력)");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:streamGenerateContent?alt=sse`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens || MAX_TOKENS, ...(TEMPERATURE !== undefined && { temperature: TEMPERATURE }) },
  };
  const res = await post(url, { "x-goog-api-key": c.key }, body, signal);
  let text = "", finish = "", blocked = "";
  await readSSE(res, (j) => {
    if (j.error) throw new ProviderError(classify(j.error.code, j.error.message), j.error.message, j.error.code);
    if (j.promptFeedback && j.promptFeedback.blockReason) blocked = j.promptFeedback.blockReason;
    const cand = j.candidates && j.candidates[0];
    if (!cand) return;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.thought) continue; // 생각 과정은 빼고 답만
      if (typeof p.text === "string") { text += p.text; onText && onText(text); }
    }
    if (cand.finishReason) finish = cand.finishReason;
  }, signal);
  if (blocked || (!text && /SAFETY|BLOCK|PROHIBITED|RECITATION/.test(finish))) {
    throw new ProviderError("refused", "제미나이가 응답을 거부했어요 (" + (blocked || finish) + ")");
  }
  if (!text) throw new ProviderError("overloaded", "제미나이가 빈 응답을 보냈어요 (" + (finish || "이유 없음") + ")");
  return { text, truncated: finish === "MAX_TOKENS" };
}

/* ---------- Claude ---------- */
async function callClaude({ system, messages, maxTokens, signal, onText }) {
  const c = CFG.claude;
  if (!c.key) throw new ProviderError("no_key", "Claude API 키가 없어요 (설정에서 입력)");
  // 프롬프트 캐싱: 규칙과 직전 대화까지는 매 턴 같으므로 캐시해서 비용을 줄인다
  const msgs = messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
  if (msgs.length >= 2) msgs[msgs.length - 2].content[0].cache_control = { type: "ephemeral" };
  const body = {
    model: c.model,
    max_tokens: maxTokens || MAX_TOKENS,
    ...(TEMPERATURE !== undefined && { temperature: TEMPERATURE }),
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: msgs,
    stream: true,
  };
  const res = await post("https://api.anthropic.com/v1/messages",
    {
      "x-api-key": c.key, "anthropic-version": "2023-06-01",
      // 폰·브라우저에서 바로 부를 때 필요한 헤더 (키는 이 기기에만 저장됨)
      ...(typeof window !== "undefined" && { "anthropic-dangerous-direct-browser-access": "true" }),
    }, body, signal);
  let text = "", stop = "";
  await readSSE(res, (j) => {
    if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") {
      text += j.delta.text; onText && onText(text);
    } else if (j.type === "message_delta" && j.delta) {
      stop = j.delta.stop_reason || stop;
    } else if (j.type === "error") {
      const t = (j.error && j.error.type) || "";
      throw new ProviderError(t === "overloaded_error" ? "overloaded" : classify(0, j.error.message), j.error.message || t);
    }
  }, signal);
  if (stop === "refusal") throw new ProviderError("refused", "Claude가 이 요청을 진행하지 않았어요");
  if (!text) throw new ProviderError("overloaded", "Claude가 빈 응답을 보냈어요");
  return { text, truncated: stop === "max_tokens" };
}

/* ---------- 모의 모드 (API 키 없이 화면·전환 테스트용) ---------- */
let mockTurn = 0;
async function callMock(id, { system, messages, signal, onText }) {
  const fail = (env.MOCK_FAIL || "").split(",").map((s) => s.trim());
  if (fail.includes(id)) throw new ProviderError("quota", `[모의] ${CFG[id].label} 크레딧 소진`, 429);
  const last = messages[messages.length - 1].content;
  let text;
  if (/JSON 배열만/.test(last)) {
    text = '[{"era":"1592년 4월, 조선 한양","org":"국가 · 조선 (국왕 선조)","hook":"전쟁 직전"},{"era":"1602년 3월, 암스테르담","org":"기업 · VOC","hook":"회사 출범"},{"era":"1868년 4월, 교토","org":"국가 · 메이지 정부","hook":"유신"}]';
  } else if (/\[세계 변수:/.test(last)) {
    const ev = last.match(/\[세계 변수: ([^\]]+)\]/)[1];
    text = `━━━━━━━━━━━━━━\n⏸️ 턴 중단 — 2031년 9월 3일\n(이번 턴 남은 기간: 4일)\n━━━━━━━━━━━━━━\n🚨 [${CFG[id].label} 모의] 세계 변수 발생 (${ev})\n모의 사건 설명.\n[근거] 모의 근거 문장.\n\n📉 예상 영향\n- 모의 영향\n\n🗣️ 참모 의견\n- 모의 의견\n\n❓ 어떻게 하시겠습니까?`;
  } else if (/기록관이다/.test(last)) {
    text = "- 현재 날짜: 1593년 1월\n- 조직: 조선 (국왕 선조)\n- 평양 탈환 작전 진행 중 (60%)";
  } else {
    mockTurn++;
    const rec = /\[기록 턴\]/.test(last) ? `\n\n📝 기록\n- 모의 기록 ${mockTurn}턴까지\n- 마지막 지시: ${last.split("\n")[0].slice(0, 40)}` : "";
    const styled = /# 문체 기준/.test(system || "") ? " (문체 기준 받음)" : "";
    text = `━━━━━━━━━━━━━━\n📅 1592년 4월 ${mockTurn}일 (선조 25년)\n⏳ 경과: 1일 — 모의 응답\n🏛️ 조선 (국왕 선조)\n━━━━━━━━━━━━━━\n📜 정세 브리핑\n[${CFG[id].label} 모의 응답${styled}] 지시 "${last.split("\n")[0].slice(0, 60)}"를 집행했습니다.\n\n🌐 외신\n- **명 조정 실록** (명): 조선 동향 — 평온함.\n- **쓰시마 보고** (일본): 부산 정탐 — 이상 없음.\n- **포르투갈 상인 서신** (마카오): 소문 — 은값 상승.\n\n📊 운영 현황 (전 턴 대비 ▲▼)\n- 국고: ${1000 + mockTurn} 석 ▲\n- 민심: 보통\n\n🏗️ 진행 중인 사업\n- 성곽 보수: ${mockTurn * 10}%\n\n🗂️ 산하 처리\n- 호조: 세곡 운송 완료\n\n🎯 이번 턴 지시 (최대 5개, 큰 방향만 정해도 됨)${rec}`;
  }
  let shown = "";
  for (const ch of text.match(/[\s\S]{1,40}/g)) {
    if (signal && signal.aborted) throw new ProviderError("aborted", "중단됨");
    await new Promise((r) => setTimeout(r, 15));
    shown += ch; onText && onText(shown);
  }
  return { text, truncated: false };
}

const CALLERS = { gemini: callGemini, claude: callClaude };

// 사용할 순서. 제미나이가 항상 주 모델이고, Claude는 대신 이어받는 역할이다.
// mode: "gemini-first"(자동, 기본) | "gemini"(제미나이만) | "claude"(Claude만)
// 예전 설정의 "claude-first"는 자동(제미나이 먼저)으로 처리한다.
export function orderFor(mode) {
  switch (mode) {
    case "gemini": return ["gemini"];
    case "claude": return ["claude"];
    default: return ["gemini", "claude"];
  }
}

const KIND_KO = {
  quota: "크레딧·사용량 한도", auth: "API 키 오류", too_large: "보낼 내용이 너무 김",
  overloaded: "서버 과부하·일시 오류", network: "연결 실패", refused: "응답 거부",
  bad_request: "요청 오류", no_key: "API 키 없음",
};
export const kindKo = (k) => KIND_KO[k] || k;

/**
 * 순서대로 시도하고, 실패하면 다음 모델로 넘어간다.
 * hooks.onSwitch(from, to, err)  전환 알림
 * hooks.onReset()                도중에 실패해서 지금까지 보낸 글을 지워야 할 때
 */
export async function generate({ system, systemFor, messages, mode, maxTokens, signal, onText, onSwitch, onReset }) {
  const now = Date.now();
  let order = orderFor(mode);
  // 자동 모드에서는 한도에 걸려 쉬는 중인 쪽을 뒤로 미룬다
  if (order.length > 1) {
    const ready = order.filter((p) => cooldown[p] <= now);
    const resting = order.filter((p) => cooldown[p] > now);
    order = [...ready, ...resting];
  }
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    let started = false;
    try {
      const call = MOCK ? (a) => callMock(id, a) : CALLERS[id];
      // 모델마다 시스템 지시를 다르게 줄 수 있다 (Claude에는 제미나이 문체 기준을 덧붙임)
      const sys = typeof systemFor === "function" ? systemFor(id) : system;
      const out = await call({
        system: sys, messages, maxTokens, signal,
        onText: (t) => { started = true; onText && onText(t); },
      });
      if (cooldown[id]) cooldown[id] = 0;
      return { ...out, provider: id, model: CFG[id].model, errors };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("network", e.message);
      if (err.kind === "aborted" || (signal && signal.aborted)) throw new ProviderError("aborted", "중단됨");
      if (err.kind === "quota") cooldown[id] = Date.now() + COOLDOWN_MIN * 60000;
      errors.push({ provider: id, kind: err.kind, message: err.message });
      console.warn(`[${id}] ${err.kind}: ${err.message}`);
      const next = order[i + 1];
      // 보낼 내용이 너무 긴 건 다른 모델로 넘겨도 대개 같으니, 다음 모델이 있어도 그대로 시도는 해 본다
      if (next) {
        if (started) onReset && onReset();
        onSwitch && onSwitch(id, next, err);
        continue;
      }
      const all = new ProviderError(err.kind, errors.map((x) => `${CFG[x.provider].label}: ${kindKo(x.kind)} (${x.message})`).join(" / "), err.status);
      all.errors = errors;
      throw all;
    }
  }
  throw new ProviderError("no_key", "사용할 수 있는 모델이 없어요");
}

export const LABEL = (id) => (CFG[id] ? CFG[id].label : id);
