// 게임 상태 다루기: 보고서에서 날짜·현황·기록 뽑기, 모델에 보낼 맥락 만들기

import { buildRules } from "./prompt.js";

const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 10);    // 최근 몇 턴을 그대로 보낼지
const HISTORY_CHARS = Number(process.env.HISTORY_CHARS || 120000); // 그 대화의 최대 글자 수
const RECORD_EVERY = Number(process.env.RECORD_EVERY || 5);        // 몇 턴마다 누적 기록을 갱신할지

const SEC_KEYS = ["📜", "🌐", "📊", "🏗", "🗂", "🎯", "📝", "🚨", "⚠", "📉", "🗣", "❓", "⏸", "🤝"];
const META_KEYS = ["📅", "⏳", "🏛", "🎲"];

export function clean(raw) {
  let t = String(raw).replace(/️/g, "").trim();
  t = t.replace(/^#{1,6}\s*/, "").replace(/^>\s*/, "");
  const m = t.match(/^\*\*([^*]+)\*\*$/);
  if (m) t = m[1].trim();
  return t;
}
const startsAny = (t, keys) => keys.some((k) => t.startsWith(k));

export function metaVal(text, key) {
  for (const raw of String(text).split(/\r?\n/)) {
    const t = clean(raw);
    if (t.startsWith(key)) return t.slice(key.length).trim().replace(/\*\*/g, "");
  }
  return "";
}

export function section(text, key) {
  let out = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const t = clean(raw);
    if (out === null) { if (t.startsWith(key)) out = []; continue; }
    if (t && (startsAny(t, SEC_KEYS) || startsAny(t, META_KEYS) || /^[━─]{3,}$/.test(t))) break;
    out.push(raw);
  }
  return out ? out.join("\n").trim() : "";
}

export function blankGame(fields) {
  return {
    v: 2, id: fields.id, era: fields.era || "", org: fields.org || "", goal: fields.goal || "",
    difficulty: fields.difficulty || "보통", createdAt: Date.now(), updatedAt: Date.now(),
    turns: 0, gameDate: "", orgLine: "", chronicle: "", chronicleTurn: 0, status: null,
    lastProvider: "", messages: [],
  };
}

// 되돌리기용 스냅샷 (지시를 수정하면 이 시점으로 복구)
export function derived(g) {
  return {
    turns: g.turns, gameDate: g.gameDate, orgLine: g.orgLine,
    chronicle: g.chronicle, chronicleTurn: g.chronicleTurn || 0, status: g.status || null,
  };
}

// 모델의 보고서를 읽어 게임 상태를 갱신한다
export function absorb(g, out) {
  const lines = String(out).split(/\r?\n/).map(clean);
  if (lines.some((t) => t.startsWith("⏳"))) g.turns += 1;
  const date = metaVal(out, "📅");
  if (date) g.gameDate = date;
  else {
    const m = metaVal(out, "⏸").match(/[—–-]\s*(.+)$/);
    if (m) g.gameDate = m[1].trim();
  }
  const orgLine = metaVal(out, "🏛");
  if (orgLine) g.orgLine = orgLine;
  const rec = section(out, "📝");
  if (rec) { g.chronicle = rec; g.chronicleTurn = g.turns; }
  const st = section(out, "📊");
  if (st) {
    const works = section(out, "🏗");
    g.status = { text: "📊 운영 현황\n" + st + (works ? "\n\n🏗 진행 중인 사업\n" + works : ""), asOf: g.gameDate };
  }
}

// 이번 턴에 누적 기록을 남기게 할지
export function needsRecord(g) {
  const next = g.turns + 1;
  if (next % RECORD_EVERY === 0) return true;
  // 기록이 너무 오래돼서, 기록 이후의 대화가 맥락 창 밖으로 밀려나기 직전이면 미리 남긴다
  if (next - (g.chronicleTurn || 0) >= HISTORY_TURNS - 1 && g.turns >= RECORD_EVERY) return true;
  return false;
}

// 모델에 보낼 내용: 규칙(+기록) + 최근 대화 + 이번 지시
export function buildContext(g, content) {
  let hist = g.messages.slice(-HISTORY_TURNS * 2).map((m) => ({ role: m.role, content: m.content }));
  const size = (arr) => arr.reduce((n, m) => n + m.content.length, 0);
  while (hist.length > 2 && size(hist) > HISTORY_CHARS) hist = hist.slice(2);
  // 대화는 항상 사용자 메시지로 시작해야 한다 (두 API 모두의 조건)
  while (hist.length && hist[0].role !== "user") hist = hist.slice(1);
  return { system: buildRules(g), messages: [...hist, { role: "user", content }] };
}

// 클라이언트에 보낼 때는 되돌리기 스냅샷을 뺀다
export function publicGame(g) {
  return {
    ...g,
    messages: g.messages.map(({ before, ...m }) => m),
  };
}

/* ---------- 제미나이 문체 이어받기 ----------
 * 제미나이가 주 GM이다. Claude가 대신 쓸 때는 이 게임에서 제미나이가 실제로 쓴 보고를
 * "문체 기준"으로 시스템 지시에 붙여서, 플레이어가 GM이 바뀐 것을 느끼지 못하게 한다.
 * Claude가 여러 턴 연달아 쓰면 최근 대화가 Claude 문체로 채워지므로, 기준은 항상
 * 대화 기록 전체에서 제미나이가 쓴 것만 골라 만든다.
 */
const STYLE_SAMPLE_CHARS = 6000;   // 기준 보고 하나의 최대 길이
const STYLE_TOTAL_CHARS = 16000;   // 기준 보고 전체 최대 길이

function reportKind(text) {
  const lines = String(text).split(/\r?\n/).map(clean);
  if (lines.some((t) => t.startsWith("⏸"))) return "halt";
  if (lines.some((t) => t.startsWith("🤝"))) return "talk";
  if (lines.some((t) => t.startsWith("📅")) && lines.some((t) => t.startsWith("📜"))) return "turn";
  return "other"; // 명령어 응답 등
}

// 제미나이가 쓴 보고 중 기준으로 쓸 것: 일반 턴 최근 2개 + 회담·턴 중단 최근 1개씩
export function geminiSamples(g) {
  const picked = { turn: [], talk: [], halt: [] };
  for (let i = g.messages.length - 1; i >= 0; i--) {
    const m = g.messages[i];
    if (m.role !== "assistant" || m.provider !== "gemini" || m.truncated) continue;
    const k = reportKind(m.content);
    const cap = k === "turn" ? 2 : 1;
    if (picked[k] && picked[k].length < cap) picked[k].push(m.content);
    if (picked.turn.length >= 2 && picked.talk.length && picked.halt.length) break;
  }
  return picked;
}

const avgLen = (arr) => Math.round(arr.reduce((n, t) => n + t.length, 0) / arr.length);
const cut = (t) => (t.length > STYLE_SAMPLE_CHARS ? t.slice(0, STYLE_SAMPLE_CHARS) + "\n(이하 생략)" : t);

export function styleSection(g) {
  const s = geminiSamples(g);
  const blocks = [];
  let used = 0;
  const add = (label, text) => {
    const t = cut(text.trim());
    if (used + t.length > STYLE_TOTAL_CHARS) return;
    blocks.push(`[${label}]\n${t}`); used += t.length;
  };
  s.turn.slice().reverse().forEach((t, i) => add(`기준 보고 ${i + 1} · 일반 턴`, t));
  if (s.halt[0]) add("기준 보고 · 턴 중단", s.halt[0]);
  if (s.talk[0]) add("기준 보고 · 회담", s.talk[0]);

  let source = "이 게임에서 그 GM이 실제로 쓴 보고";
  if (!blocks.length && g.importedTail) {
    // 아직 이 앱에서 제미나이가 쓴 보고가 없으면, 옮겨 온 원래 대화(제미나이와 하던 것)를 기준으로
    add("기준 · 옮겨 오기 전 대화의 마지막 부분", g.importedTail);
    source = "이 게임을 옮겨 오기 전, 그 GM과 나눈 대화의 마지막 부분";
  }
  if (!blocks.length) return "";

  const lengthLine = s.turn.length
    ? `- 분량: 일반 턴 보고는 약 ${avgLen(s.turn).toLocaleString()}자 안팎(±15%)으로 쓴다. 더 길게 늘이거나 더 자세히 풀어 쓰지 않는다.`
    : "- 분량: 기준과 비슷한 길이로 쓴다. 더 길게 늘이지 않는다.";

  return `

# 문체 기준 (Claude 전용, 매우 중요)
이 게임의 주 GM은 제미나이이고, 너는 제미나이가 잠시 쓸 수 없을 때 같은 GM으로서 대신 이어 쓴다. 플레이어가 GM이 바뀐 것을 느끼지 못해야 한다.
아래는 ${source}다. 내용은 이미 지난 일이므로 사실 관계는 위 기록과 최근 대화를 따르고, 아래에서는 "어떻게 쓰는지"만 그대로 따라 한다.
${lengthLine}
- 문장 끝맺음(합쇼체·해라체 등), 어휘 수준, 한자어·관직명을 쓰는 정도, 문장 길이와 호흡을 기준과 같게 한다.
- 섹션별 분량 비율, 문단 수, 목록 항목 수와 한 항목의 길이, 굵게(**) 쓰는 빈도, 숫자·단위·증감(▲▼) 표기 방식을 기준과 같게 한다.
- 외신의 문체와 이름 짓는 방식, 참모·인물 대사의 말투를 기준과 같게 한다.
- 지시가 성공하는 정도, 차질과 위기를 다루는 수위, 서술의 온도(담담함·극적임)도 기준의 경향을 따른다.
- 기준에 없는 꾸밈(비유 남발, 소제목·이모지 추가, 요약 문단, 맺음말, 선택지 목록)을 덧붙이지 않는다.
- 위 규칙(관대한 진행, 턴 길이, 출력 형식 등)은 그대로 지킨다. 규칙과 기준이 다르면 규칙을 따르고, 나머지는 기준을 따른다.
- 최근 대화 중 기준과 문체가 다른 보고가 있으면(대신 쓴 보고) 그 문체를 따르지 말고 기준을 따른다.

${blocks.join("\n\n")}`;
}
