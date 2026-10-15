// 서버판 server.js의 역할을 이 기기 안에서 그대로 한다.
// 화면(app.js)은 서버판과 같은 주소(/api/...)로 요청하고, 여기서 처리한다.

import "./settings.js";
import * as store from "./store.js";
import { blankGame, absorb, derived, needsRecord, buildContext, publicGame, styleSection } from "./game.js";
import { startText, resumeText, PASS_TEXT, RECOMMEND_PROMPT, importPrompt, worldEventNote, WORLD_EVENT_PERCENT } from "./prompt.js";
import { generate, providerStatus, resetCooldown, setCooldown, kindKo, LABEL, ProviderError } from "./providers.js";

const env = globalThis.process.env;
// 제미나이가 주 모델이다. 자동(제미나이 먼저) · 제미나이만 · Claude만
const MODES = ["gemini-first", "gemini", "claude"];
const DEFAULT_MODE = MODES.includes(env.DEFAULT_MODE) ? env.DEFAULT_MODE : "gemini-first";
const DIFFS = ["쉬움", "보통", "어려움"];
const CHUNK = 100000;

const pickMode = (m) => (MODES.includes(m) ? m : DEFAULT_MODE);
const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);
const diff = (d) => (DIFFS.includes(d) ? d : "보통");
const dice100 = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 100);

/* ---------- 한도 기억: 앱을 다시 열어도 유지 ---------- */
const CD_KEY = "hsim.app.cooldown";
try {
  const saved = JSON.parse(localStorage.getItem(CD_KEY) || "{}");
  for (const [id, until] of Object.entries(saved)) if (until > Date.now()) setCooldown(id, until);
} catch { /* 무시 */ }
function saveCooldown() {
  const st = providerStatus();
  const out = {};
  for (const [id, p] of Object.entries(st)) if (p.coolingUntil) out[id] = p.coolingUntil;
  try { localStorage.setItem(CD_KEY, JSON.stringify(out)); } catch { /* 무시 */ }
}

export class AuthError extends Error {} // 서버판 호환용 (앱에서는 쓰이지 않음)

function fail(status, message) {
  return Object.assign(new Error(message), { status, error: message });
}
function errPayload(e) {
  const kind = e instanceof ProviderError ? e.kind : "server";
  return { kind, reason: kindKo(kind), message: e.message, errors: e.errors || [] };
}

/* ---------- 일반 요청 ---------- */
export async function api(path, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body || {};
  let m;

  if (path === "/api/status" && method === "GET") {
    return { providers: providerStatus(), defaultMode: DEFAULT_MODE, modes: MODES, mock: env.MOCK === "1", worldEventPercent: WORLD_EVENT_PERCENT };
  }
  if (path === "/api/cooldown/reset" && method === "POST") {
    resetCooldown(body.provider); saveCooldown();
    return { ok: true, providers: providerStatus() };
  }
  if (path === "/api/games" && method === "GET") return store.list();
  if (path === "/api/games" && method === "POST") {
    const era = str(body.era), org = str(body.org);
    if (!era || !org) throw fail(400, "시대와 조직을 적어주세요");
    const g = blankGame({ id: store.newId(), era, org, goal: str(body.goal), difficulty: diff(body.difficulty) });
    await store.save(g);
    return publicGame(g);
  }
  if (path === "/api/games/upload" && method === "POST") {
    const d = body.game || body;
    if (!d || !Array.isArray(d.messages) || !d.org) throw fail(400, "백업 파일 형식이 아니에요");
    const g = {
      ...blankGame({ id: store.newId(), era: str(d.era), org: str(d.org), goal: str(d.goal), difficulty: diff(d.difficulty) }),
      turns: Number(d.turns) || 0, gameDate: str(d.gameDate), orgLine: str(d.orgLine),
      chronicle: String(d.chronicle || "").slice(0, 20000), chronicleTurn: Number(d.chronicleTurn) || 0,
      status: d.status && d.status.text ? d.status : null, importedTail: d.importedTail,
      messages: d.messages.filter((x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string")
        .map((x) => ({ role: x.role, content: x.content, display: x.display, provider: x.provider, model: x.model, switched: x.switched, truncated: x.truncated, at: x.at, before: x.before })),
    };
    await store.save(g);
    return publicGame(g);
  }
  if ((m = path.match(/^\/api\/games\/([^/]+)\/export$/)) && method === "GET") {
    const g = await store.load(m[1]);
    if (!g) throw fail(404, "없는 게임");
    return g;
  }
  if ((m = path.match(/^\/api\/games\/([^/]+)$/))) {
    if (method === "GET") {
      const g = await store.load(m[1]);
      if (!g) throw fail(404, "없는 게임");
      return publicGame(g);
    }
    if (method === "DELETE") {
      await store.withLock(m[1], () => store.remove(m[1]));
      return { ok: true };
    }
  }
  if (path === "/api/recommend" && method === "POST") {
    try {
      const out = await generate({
        system: "너는 세계사에 밝은 게임 기획자다.",
        messages: [{ role: "user", content: RECOMMEND_PROMPT }],
        mode: pickMode(body.mode), maxTokens: 1500,
      });
      saveCooldown();
      const mm = out.text.match(/\[[\s\S]*\]/);
      let items = [];
      try { items = JSON.parse(mm ? mm[0] : "[]"); } catch { items = []; }
      items = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.era === "string" && typeof x.org === "string").slice(0, 3);
      return { items, provider: out.provider };
    } catch (e) {
      saveCooldown();
      throw Object.assign(new Error(e.message), errPayload(e));
    }
  }
  throw fail(404, "없는 주소: " + path);
}

/* ---------- 스트리밍 요청 (한 턴 진행, 대화 옮겨 오기) ---------- */
export async function stream(path, body, handlers, signal) {
  let ended = false;
  const s = {
    signal,
    send(ev, data) {
      if (ev === "done" || ev === "fail") ended = true;
      try { handlers[ev] && handlers[ev](data); } catch (e) { console.error(e); }
    },
  };
  let m;
  if ((m = path.match(/^\/api\/games\/([^/]+)\/turn$/))) await runTurn(m[1], body || {}, s);
  else if (path === "/api/import") await runImport(body || {}, s);
  else throw fail(404, "없는 주소: " + path);
  saveCooldown();
  if (!ended) throw Object.assign(new Error("중단됐어요"), { kind: "network" });
}

function pipeHooks(s) {
  let sent = 0;
  return {
    onText(full) {
      if (full.length > sent) { s.send("delta", { t: full.slice(sent) }); sent = full.length; }
    },
    onReset() { sent = 0; s.send("reset", {}); },
    onSwitch(from, to, err) {
      s.send("switch", { from, to, fromLabel: LABEL(from), toLabel: LABEL(to), kind: err.kind, reason: kindKo(err.kind), message: err.message });
    },
  };
}

/* 한 턴: body = { kind: "order"|"pass"|"start"|"resume", text, display, mode, truncateAt } */
async function runTurn(id, b, s) {
  const mode = pickMode(b.mode);
  try {
    await store.withLock(id, async () => {
      const g = await store.load(id);
      if (!g) throw Object.assign(new Error("없는 게임이에요"), { kind: "server" });

      // 수정·다시 받기: 해당 지시 앞까지 되돌린다 (저장은 새 보고를 받은 뒤에만)
      if (Number.isInteger(b.truncateAt) && b.truncateAt >= 0 && b.truncateAt < g.messages.length) {
        const msg = g.messages[b.truncateAt];
        if (msg && msg.role === "user") {
          g.messages = g.messages.slice(0, b.truncateAt);
          if (msg.before) Object.assign(g, msg.before);
          else {
            Object.assign(g, { turns: 0, gameDate: "", orgLine: "", chronicle: "", chronicleTurn: 0, status: null });
            for (const x of g.messages) if (x.role === "assistant") absorb(g, x.content);
          }
        }
      }

      const kind = b.kind || "order";
      let text, display;
      if (kind === "start") { text = startText(g); display = `게임 시작 · ${g.era} · ${g.org}`; }
      else if (kind === "resume") { text = resumeText(g); display = "이어하기 · 옮겨 온 기록에서 시작"; }
      else if (kind === "pass") { text = PASS_TEXT; display = "턴 넘기기"; }
      else { text = str(b.text, 8000); display = str(b.display, 300) || undefined; }
      if (!text) throw Object.assign(new Error("지시가 비어 있어요"), { kind: "server" });

      const dice = dice100();
      const notes = [`[판정 숫자: ${dice}]`];
      // 미래 모드 세계 변수: 판정 숫자가 확률 이하이면 유형·지역·규모를 실제 난수로 뽑아 함께 보낸다
      const worldEvent = worldEventNote(dice, g.gameDate || g.era);
      if (worldEvent) notes.push(worldEvent);
      if (needsRecord(g) || kind === "resume") notes.push("[기록 턴]");
      const content = text + "\n\n" + notes.join("\n");

      const { system, messages } = buildContext(g, content);
      s.send("start", { mode });
      const hooks = pipeHooks(s);
      const switched = [];
      // Claude가 대신 쓸 때는 이 게임에서 제미나이가 쓴 보고를 문체 기준으로 덧붙인다
      const claudeSystem = system + styleSection(g);
      const out = await generate({
        system, messages, mode, signal: s.signal, ...hooks,
        systemFor: (pid) => (pid === "claude" ? claudeSystem : system),
        onSwitch: (from, to, err) => { switched.push({ from, kind: err.kind }); hooks.onSwitch(from, to, err); },
      });

      const before = derived(g);
      const at = Date.now();
      g.messages.push(
        { role: "user", content, display, before, at },
        { role: "assistant", content: out.text, provider: out.provider, model: out.model, truncated: out.truncated || undefined, switched: switched.length ? switched : undefined, at },
      );
      absorb(g, out.text);
      g.lastProvider = out.provider;
      await store.save(g);
      s.send("done", { provider: out.provider, label: LABEL(out.provider), model: out.model, truncated: out.truncated, game: publicGame(g) });
    });
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === "aborted")) s.send("fail", errPayload(e));
  }
}

/* 다른 AI와 하던 대화를 누적 기록으로 정리해 새 게임을 만든다 */
async function runImport(b, s) {
  const mode = pickMode(b.mode);
  const transcript = String(b.transcript || "").replace(/\r\n/g, "\n").trim().slice(0, 2_000_000);
  try {
    if (transcript.length < 50) throw Object.assign(new Error("가져올 대화가 너무 짧아요"), { kind: "server" });
    const g = blankGame({ id: store.newId(), era: str(b.era), org: str(b.org), goal: str(b.goal), difficulty: diff(b.difficulty) });
    const chunks = [];
    for (let i = 0; i < transcript.length; i += CHUNK) chunks.push(transcript.slice(i, i + CHUNK));
    let summary = "";
    for (let i = 0; i < chunks.length; i++) {
      s.send("progress", { part: i + 1, total: chunks.length });
      const out = await generate({
        system: "너는 꼼꼼한 기록관이다. 요청한 형식만 출력한다.",
        messages: [{ role: "user", content: importPrompt(g, summary, chunks[i], i + 1, chunks.length) }],
        mode, maxTokens: 3000, signal: s.signal,
        onSwitch: (from, to, err) => s.send("switch", { fromLabel: LABEL(from), toLabel: LABEL(to), reason: kindKo(err.kind) }),
      });
      summary = out.text.split("\n").filter((l) => l.trim()).join("\n").slice(0, 8000);
    }
    g.chronicle = summary;
    if (!g.era) g.era = "(누적 기록 참고)";
    if (!g.org) g.org = "(누적 기록 참고)";
    g.importedTail = transcript.slice(-6000);
    await store.save(g);
    s.send("done", { game: publicGame(g) });
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === "aborted")) s.send("fail", errPayload(e));
  }
}
