// 역사 운영 시뮬레이터 — 앱 화면
// 서버 없이 이 기기 안에서 돌아간다. 게임 처리는 local-api.js, 저장은 store.js(IndexedDB).
import { loadSettings, saveSettings, hasKeys } from "./settings.js";
import { api, stream, AuthError } from "./local-api.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    settings: $("settings"), setForm: $("set-form"), setNotice: $("set-notice"), setError: $("set-error"),
    sGkey: $("s-gkey"), sCkey: $("s-ckey"), sShow: $("s-show"), sGmodel: $("s-gmodel"), sCmodel: $("s-cmodel"),
    sMode: $("s-mode"), sHist: $("s-hist"), sRec: $("s-rec"), sCool: $("s-cool"), sMaxout: $("s-maxout"), sMock: $("s-mock"),
    btnSettings: $("btn-settings"), btnSetCancel: $("btn-set-cancel"),
    home: $("home"), game: $("game"), notice: $("notice"), prov: $("prov"), mode: $("f-mode"),
    saves: $("saves"), savesEmpty: $("saves-empty"), form: $("new-form"), examples: $("examples"),
    era: $("f-era"), org: $("f-org"), goal: $("f-goal"), diff: $("f-diff"),
    formError: $("form-error"), btnStart: $("btn-start"), btnRec: $("btn-recommend"), recs: $("recs"),
    impForm: $("imp-form"), iEra: $("i-era"), iOrg: $("i-org"), iDiff: $("i-diff"), iText: $("i-text"),
    impError: $("imp-error"), impProgress: $("imp-progress"), btnImport: $("btn-import"),
    upload: $("f-upload"), upError: $("up-error"),
    btnHome: $("btn-home"), gOrg: $("g-org"), gDate: $("g-date"), gMode: $("g-mode"), btnExport: $("btn-export"),
    btnPanel: $("btn-panel"), btnPanelClose: $("btn-panel-close"), panel: $("panel"), panelScroll: $("panel-scroll"),
    feed: $("feed"), log: $("log"), chips: $("chips"), compNote: $("comp-note"),
    sendForm: $("send-form"), msg: $("f-msg"), btnSend: $("btn-send"), btnStop: $("btn-stop"),
  };

  const state = { screen: "home", game: null, busy: false, ctl: null, pending: [], autoScroll: true, status: null };

  /* ---------- 저장해 둘 작은 설정 (이 브라우저에만) ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  };
  let mode = ls.get("hsim.mode", "");

  const EXAMPLES = [
    { label: "1592 조선", era: "1592년 4월 초, 조선 한양", org: "국가 · 조선 (국왕 선조)" },
    { label: "1453 비잔티움", era: "1453년 1월, 콘스탄티노폴리스", org: "국가 · 비잔티움 제국 (황제 콘스탄티노스 11세)" },
    { label: "1602 동인도회사", era: "1602년 3월, 암스테르담", org: "기업 · 네덜란드 동인도회사(VOC) 17인 이사회" },
    { label: "1868 메이지", era: "1868년 4월, 교토", org: "국가 · 일본 메이지 신정부" },
  ];
  const CHIPS = [["턴 넘기기", "pass"], ["현황", "/현황"], ["외교", "/외교"], ["인물", "/인물"], ["역사", "/역사"], ["기록", "/기록"], ["회담 종료", "/회담종료"]];
  const PROV_LABEL = { gemini: "제미나이", claude: "Claude" };

  /* ---------- report rendering ---------- */
  const SEC_KEYS = { "📜": "brief", "🌐": "press", "📊": "stats", "🏗": "works", "🗂": "delegated", "🎯": "orders", "📝": "record", "🚨": "alert", "⚠": "alert", "📉": "impact", "🗣": "advice", "❓": "ask", "⏸": "halt", "🤝": "talk" };
  const META_KEYS = { "📅": "date", "⏳": "elapsed", "🏛": "org", "🎲": "dice" };
  const TAGS = { "역사 노트": "t-note", "역사 분기": "t-branch", "미래 모드 진입": "t-future", "근거": "t-note" };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function clean(raw) {
    let t = String(raw).replace(/️/g, "").trim();
    t = t.replace(/^#{1,6}\s*/, "").replace(/^>\s*/, "");
    const m = t.match(/^\*\*([^*]+)\*\*$/);
    if (m) t = m[1].trim();
    return t;
  }
  function keyOf(t, map) {
    for (const k of Object.keys(map)) if (t.startsWith(k)) return k;
    return null;
  }
  function inline(s) {
    let h = esc(s);
    h = h.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\[(역사 노트|역사 분기|미래 모드 진입|근거)\]/g, (m, k) => `<span class="tag ${TAGS[k]}">${k}</span>`);
    return h;
  }
  function renderReport(text) {
    const lines = String(text).split(/\r?\n/);
    let html = "", meta = [], list = null, listTag = "ul", sec = "body";
    const flushList = () => {
      if (list) { html += `<${listTag} class="in-${sec}">${list.join("")}</${listTag}>`; list = null; }
    };
    const flushMeta = () => {
      if (meta.length) { html += `<div class="meta">${meta.join("")}</div>`; meta = []; }
    };
    for (const raw of lines) {
      const t = clean(raw);
      if (!t) { flushList(); continue; }
      if (/^[━─=_-]{3,}$/.test(t)) { flushList(); continue; }
      const mk = keyOf(t, META_KEYS);
      if (mk) {
        flushList();
        meta.push(`<div class="m m-${META_KEYS[mk]}">${inline(t.slice(mk.length).trim())}</div>`);
        continue;
      }
      flushMeta();
      const sk = keyOf(t, SEC_KEYS);
      if (sk) {
        flushList();
        sec = SEC_KEYS[sk];
        html += `<h3 class="sec sec-${sec}">${inline(t.slice(sk.length).trim())}</h3>`;
        continue;
      }
      let m;
      if ((m = t.match(/^[-•·*]\s+(.*)$/))) {
        if (!list || listTag !== "ul") { flushList(); list = []; listTag = "ul"; }
        list.push(`<li>${inline(m[1])}</li>`);
        continue;
      }
      if ((m = t.match(/^(\d+)[.)]\s+(.*)$/))) {
        if (!list || listTag !== "ol") { flushList(); list = []; listTag = "ol"; }
        list.push(`<li value="${m[1]}">${inline(m[2])}</li>`);
        continue;
      }
      flushList();
      const speech = /^["“「『]/.test(t);
      html += `<p${speech ? ' class="speech"' : ""}>${inline(t)}</p>`;
    }
    flushList(); flushMeta();
    return html;
  }
  function reportClass(text) {
    const lines = String(text).split(/\r?\n/).map(clean);
    if (lines.some((t) => t.startsWith("⏸"))) return " is-halt";
    if (lines.some((t) => t.startsWith("🤝"))) return " is-talk";
    return "";
  }
  function section(text, key) {
    let out = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const t = clean(raw);
      if (out === null) { if (t.startsWith(key)) out = []; continue; }
      if (t && (keyOf(t, SEC_KEYS) || keyOf(t, META_KEYS) || /^[━─]{3,}$/.test(t))) break;
      out.push(raw);
    }
    return out ? out.join("\n").trim() : "";
  }
  function metaVal(text, key) {
    for (const raw of String(text).split(/\r?\n/)) {
      const t = clean(raw);
      if (t.startsWith(key)) return t.slice(key.length).trim().replace(/\*\*/g, "");
    }
    return "";
  }

  /* ---------- 화면 전환 ---------- */
  function only(el) {
    for (const s of [els.settings, els.home, els.game]) s.hidden = s !== el;
    window.scrollTo(0, 0);
  }

  /* ---------- 설정 ---------- */
  function showSettings(first) {
    state.screen = "settings"; only(els.settings);
    const s = loadSettings();
    els.sGkey.value = s.GEMINI_API_KEY; els.sCkey.value = s.ANTHROPIC_API_KEY;
    els.sGmodel.value = s.GEMINI_MODEL; els.sCmodel.value = s.CLAUDE_MODEL;
    els.sMode.value = s.DEFAULT_MODE; els.sHist.value = s.HISTORY_TURNS; els.sRec.value = s.RECORD_EVERY;
    els.sCool.value = s.COOLDOWN_MINUTES; els.sMaxout.value = s.MAX_OUTPUT_TOKENS; els.sMock.checked = s.MOCK === "1";
    els.sShow.checked = false; els.sGkey.type = els.sCkey.type = "password";
    els.setError.hidden = true;
    els.setNotice.hidden = !first;
    els.setNotice.textContent = first ? "처음 오셨네요. 제미나이나 Claude API 키를 넣으면 바로 시작할 수 있어요. 키 없이 둘러보려면 고급 설정에서 테스트 모드를 켜세요." : "";
    els.btnSetCancel.hidden = !!first && !hasKeys();
  }
  els.sShow.addEventListener("change", () => { els.sGkey.type = els.sCkey.type = els.sShow.checked ? "text" : "password"; });
  els.btnSetCancel.addEventListener("click", () => showHome());
  els.btnSettings.addEventListener("click", () => showSettings(false));
  els.setForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const num = (el, lo, hi, d) => { const n = Math.round(Number(el.value)); return String(Number.isFinite(n) && el.value !== "" ? Math.min(hi, Math.max(lo, n)) : d); };
    const s = {
      ...loadSettings(),
      GEMINI_API_KEY: els.sGkey.value.trim(), ANTHROPIC_API_KEY: els.sCkey.value.trim(),
      GEMINI_MODEL: els.sGmodel.value.trim() || "gemini-3.8-flash", CLAUDE_MODEL: els.sCmodel.value.trim() || "claude-sonnet-5-5",
      DEFAULT_MODE: els.sMode.value,
      HISTORY_TURNS: num(els.sHist, 2, 40, 10), RECORD_EVERY: num(els.sRec, 2, 20, 5),
      COOLDOWN_MINUTES: num(els.sCool, 0, 1440, 10), MAX_OUTPUT_TOKENS: num(els.sMaxout, 1000, 64000, 8000),
      MOCK: els.sMock.checked ? "1" : "",
    };
    if (!hasKeys(s)) { els.setError.textContent = "API 키를 하나 이상 넣거나 테스트 모드를 켜주세요."; els.setError.hidden = false; return; }
    if (!saveSettings(s)) { els.setError.textContent = "이 브라우저에서는 설정을 저장할 수 없어요 (사생활 보호 모드인지 확인)."; els.setError.hidden = false; return; }
    ls.set("hsim.mode", s.DEFAULT_MODE);
    // 새 설정으로 다시 시작
    location.hash = ""; location.reload();
  });

  async function showHome() {
    state.screen = "home"; only(els.home);
    els.panel.classList.remove("open");
    if (history.state && history.state.g) history.replaceState({}, "", location.pathname);
    await Promise.all([loadStatus(), renderSaves()]);
  }

  /* ---------- 모델 상태 ---------- */
  function setMode(m) {
    mode = m; ls.set("hsim.mode", m);
    els.mode.value = m; els.gMode.value = m;
  }
  els.mode.addEventListener("change", () => setMode(els.mode.value));
  els.gMode.addEventListener("change", () => setMode(els.gMode.value));

  async function loadStatus() {
    try { state.status = await api("/api/status"); } catch (e) { if (e instanceof AuthError) return; state.status = null; }
    const st = state.status;
    if (!st) { els.prov.textContent = ""; return; }
    if (!mode || !st.modes.includes(mode)) setMode(st.defaultMode); else setMode(mode);
    els.prov.textContent = "";
    for (const id of ["gemini", "claude"]) {
      const p = st.providers[id];
      const row = document.createElement("div"); row.className = "prov-row";
      const dot = document.createElement("span");
      const name = document.createElement("span"); name.className = "prov-name"; name.textContent = p.label;
      const model = document.createElement("span"); model.className = "prov-model"; model.textContent = p.model;
      const stt = document.createElement("span"); stt.className = "prov-state";
      if (!p.configured) { dot.className = "dot off"; stt.textContent = "API 키 없음 (설정에서 입력)"; }
      else if (p.coolingUntil) {
        dot.className = "dot rest";
        stt.textContent = `한도 초과로 ${new Date(p.coolingUntil).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}까지 뒤로 미룸`;
      } else { dot.className = "dot ok"; stt.textContent = "사용 가능"; }
      row.append(dot, name, model, stt);
      if (p.coolingUntil) {
        const b = document.createElement("button"); b.type = "button"; b.className = "link-btn"; b.textContent = "지금 다시 시도";
        b.onclick = async () => { await api("/api/cooldown/reset", { method: "POST", body: { provider: id } }); loadStatus(); };
        row.append(b);
      }
      els.prov.append(row);
    }
    if (st.mock) { els.notice.textContent = "모의 모드로 실행 중이에요. 실제 AI 대신 테스트용 응답이 나와요."; els.notice.hidden = false; }
  }

  /* ---------- 저장 목록 ---------- */
  async function renderSaves() {
    let list = [];
    try { list = await api("/api/games"); } catch (e) { if (e instanceof AuthError) return; }
    els.saves.textContent = "";
    els.savesEmpty.hidden = list.length > 0;
    for (const s of list) {
      const li = document.createElement("li");
      const info = document.createElement("div"); info.className = "s-info";
      const o = document.createElement("div"); o.className = "s-org"; o.textContent = s.orgLine || s.org || "이름 없는 게임";
      const sub = document.createElement("div"); sub.className = "s-sub";
      sub.textContent = [s.gameDate || s.era, s.turns ? `${s.turns}턴` : "",
        s.updatedAt ? new Date(s.updatedAt).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " 저장" : "",
        s.lastProvider ? `마지막 ${PROV_LABEL[s.lastProvider] || s.lastProvider}` : ""].filter(Boolean).join(" · ");
      info.append(o, sub);
      const act = document.createElement("div"); act.className = "s-act";
      const open = document.createElement("button"); open.type = "button"; open.className = "btn small primary"; open.textContent = "이어하기";
      open.onclick = () => openGame(s.id);
      const del = document.createElement("button"); del.type = "button"; del.className = "btn small"; del.textContent = "삭제";
      let armed = null;
      del.onclick = async () => {
        if (armed) { clearTimeout(armed); armed = null; await api(`/api/games/${s.id}`, { method: "DELETE" }); renderSaves(); return; }
        del.textContent = "정말 삭제"; del.classList.add("danger");
        armed = setTimeout(() => { armed = null; del.textContent = "삭제"; del.classList.remove("danger"); }, 3500);
      };
      act.append(open, del);
      li.append(info, act);
      els.saves.append(li);
    }
  }

  async function openGame(id, firstKind) {
    try {
      state.game = await api(`/api/games/${id}`);
    } catch (e) {
      if (!(e instanceof AuthError)) { els.notice.textContent = "게임을 불러오지 못했어요: " + e.message; els.notice.hidden = false; }
      return;
    }
    history.replaceState({ g: id }, "", "#" + id);
    showGame();
    if (firstKind) send({ kind: firstKind });
  }

  /* ---------- 새 게임 ---------- */
  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = ex.label;
    b.onclick = () => { els.era.value = ex.era; els.org.value = ex.org; els.formError.hidden = true; };
    els.examples.append(b);
  }
  function formError(msg) { els.formError.textContent = msg; els.formError.hidden = !msg; }

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const era = els.era.value.trim(), org = els.org.value.trim();
    if (!era || !org) { formError("시대와 장소, 조직을 모두 적어주세요."); (era ? els.org : els.era).focus(); return; }
    formError("");
    els.btnStart.disabled = true;
    try {
      const g = await api("/api/games", { method: "POST", body: { era, org, goal: els.goal.value.trim(), difficulty: els.diff.value } });
      await openGame(g.id, "start");
    } catch (e) { if (!(e instanceof AuthError)) formError(e.message); }
    finally { els.btnStart.disabled = false; }
  });

  els.btnRec.addEventListener("click", async () => {
    els.btnRec.disabled = true;
    els.recs.hidden = false;
    els.recs.innerHTML = '<p class="status">추천을 고르는 중…</p>';
    try {
      const { items } = await api("/api/recommend", { method: "POST", body: { mode } });
      els.recs.textContent = "";
      if (!items.length) { els.recs.innerHTML = '<p class="status">추천을 읽지 못했어요. 다시 눌러보세요.</p>'; return; }
      for (const it of items) {
        const b = document.createElement("button"); b.type = "button"; b.className = "rec";
        const t = document.createElement("b"); t.textContent = `${it.era} · ${it.org}`;
        const h = document.createElement("span"); h.textContent = String(it.hook || "");
        b.append(t, h);
        b.onclick = () => { els.era.value = it.era; els.org.value = it.org; formError(""); els.btnStart.focus(); };
        els.recs.append(b);
      }
    } catch (e) {
      els.recs.innerHTML = "";
      const p = document.createElement("p"); p.className = "status";
      p.textContent = "추천을 받지 못했어요. " + (e.reason ? `(${e.reason})` : "다시 눌러보세요.");
      els.recs.append(p);
    } finally { els.btnRec.disabled = false; }
  });

  /* ---------- 옮겨 오기 ---------- */
  els.impForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const transcript = els.iText.value.trim();
    els.impError.hidden = true;
    if (transcript.length < 50) { els.impError.textContent = "대화를 붙여 넣어 주세요."; els.impError.hidden = false; return; }
    els.btnImport.disabled = true;
    els.impProgress.hidden = false; els.impProgress.textContent = "대화를 읽는 중…";
    let created = null, failed = null;
    try {
      await stream("/api/import", { transcript, era: els.iEra.value, org: els.iOrg.value, difficulty: els.iDiff.value, mode }, {
        progress: (d) => { els.impProgress.textContent = d.total > 1 ? `기록으로 정리하는 중… (${d.part}/${d.total})` : "기록으로 정리하는 중…"; },
        switch: (d) => { els.impProgress.textContent += ` · ${d.fromLabel} ${d.reason} → ${d.toLabel}로 전환`; },
        done: (d) => { created = d.game; },
        fail: (d) => { failed = d; },
      });
    } catch (e) { failed = failed || { message: e.message }; }
    els.btnImport.disabled = false;
    if (failed || !created) {
      els.impProgress.hidden = true;
      els.impError.textContent = "옮겨 오지 못했어요: " + ((failed && (failed.reason || failed.message)) || "알 수 없는 오류");
      els.impError.hidden = false; return;
    }
    els.impProgress.hidden = true; els.iText.value = "";
    openGame(created.id, "resume");
  });

  els.upload.addEventListener("change", async () => {
    const f = els.upload.files[0]; if (!f) return;
    els.upError.hidden = true;
    try {
      const data = JSON.parse(await f.text());
      const g = await api("/api/games/upload", { method: "POST", body: { game: data } });
      openGame(g.id);
    } catch (e) {
      if (!(e instanceof AuthError)) { els.upError.textContent = "불러오지 못했어요: " + e.message; els.upError.hidden = false; }
    } finally { els.upload.value = ""; }
  });

  /* ---------- 게임 화면 ---------- */
  function showGame() {
    state.screen = "game"; only(els.game);
    compNote("");
    els.log.textContent = "";
    state.pending = [];
    const g = state.game;
    g.messages.forEach((m, i) => {
      if (m.role === "user") addSlip(m.display || m.content.replace(/\n\n\[판정 숫자[\s\S]*$/, ""), i);
      else fillReport(addReport(), m.content, m);
    });
    markLast();
    if (!g.messages.length) addStarter();
    updateHeader(); renderPanel(); setBusy(false);
    state.autoScroll = true;
    requestAnimationFrame(() => { els.feed.scrollTop = els.feed.scrollHeight; });
  }
  function addStarter() {
    const g = state.game;
    const resume = !!g.chronicle;
    const d = document.createElement("div"); d.className = "starter";
    const p = document.createElement("p"); p.style.margin = "0";
    p.textContent = resume ? "옮겨 온 기록이 준비됐어요." : "아직 첫 보고가 없어요.";
    const b = document.createElement("button"); b.type = "button"; b.className = "btn primary";
    b.textContent = resume ? "이어서 보고 받기" : "첫 보고 받기";
    b.onclick = () => send({ kind: resume ? "resume" : "start" });
    d.append(p, b); els.log.append(d);
  }
  function updateHeader() {
    const g = state.game;
    els.gOrg.textContent = g.orgLine || g.org;
    els.gDate.textContent = [g.gameDate || g.era, g.turns ? `${g.turns}턴` : ""].filter(Boolean).join(" · ");
  }
  function renderPanel() {
    const g = state.game;
    els.panelScroll.textContent = "";
    if (g.status && g.status.text) {
      const a = document.createElement("p"); a.className = "asof"; a.textContent = g.status.asOf ? `${g.status.asOf} 기준` : "최근 턴 기준";
      const r = document.createElement("div"); r.className = "report flat"; r.innerHTML = renderReport(g.status.text);
      els.panelScroll.append(a, r);
    } else {
      const p = document.createElement("p"); p.className = "panel-empty";
      p.textContent = "첫 턴 보고가 오면 국고, 민심, 진행 중인 사업 같은 운영 지표가 여기에 정리돼요.";
      els.panelScroll.append(p);
    }
    if (g.chronicle) {
      const c = document.createElement("div"); c.className = "chron";
      const h = document.createElement("h3"); h.textContent = "누적 기록 (두 AI가 함께 쓰는 메모리)";
      const r = document.createElement("div"); r.className = "report flat"; r.innerHTML = renderReport(g.chronicle);
      c.append(h, r); els.panelScroll.append(c);
    }
  }

  function addSlip(text, idx) {
    const d = document.createElement("div"); d.className = "slip";
    const l = document.createElement("div"); l.className = "slip-label";
    const isSetup = text.startsWith("게임 시작") || text.startsWith("이어하기");
    l.textContent = text.startsWith("/") ? "명령" : isSetup ? "설정" : "지시";
    const t = document.createElement("div"); t.className = "slip-text"; t.textContent = text;
    d.append(l, t);
    if (!isSetup) {
      const acts = document.createElement("div"); acts.className = "slip-acts";
      const eb = document.createElement("button"); eb.type = "button"; eb.textContent = "수정";
      eb.onclick = () => editSlip(d, text, idx);
      const rb = document.createElement("button"); rb.type = "button"; rb.className = "re"; rb.textContent = "다시 받기";
      rb.onclick = () => rerun(idx, text);
      acts.append(eb, rb); d.append(acts);
    }
    els.log.append(d);
    return d;
  }
  function markLast() {
    const slips = els.log.querySelectorAll(".slip");
    slips.forEach((s, i) => s.classList.toggle("last", i === slips.length - 1));
  }
  function editSlip(d, text, idx) {
    if (state.busy || d.classList.contains("editing")) return;
    const g = state.game;
    const later = Math.max(0, Math.floor((g.messages.length - idx) / 2) - 1);
    d.classList.add("editing");
    for (const c of d.querySelectorAll(".slip-text,.slip-acts")) c.hidden = true;
    const box = document.createElement("form"); box.className = "slip-edit";
    const ta = document.createElement("textarea"); ta.rows = 3;
    ta.value = text === "턴 넘기기" ? "이번 턴은 새 지시 없이 진행해. 진행 중인 사업과 정세 변화를 이어서 보고해." : text;
    ta.setAttribute("aria-label", "지시 수정");
    const warn = document.createElement("p"); warn.className = "warn";
    warn.textContent = idx < g.messages.length
      ? `보내면 이 지시의 보고${later ? `와 그 뒤 ${later}개 보고` : ""}가 지워지고, 이 시점부터 다시 진행돼요.`
      : "수정한 지시로 다시 보내요.";
    const row = document.createElement("div"); row.className = "row";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn small"; cancel.textContent = "취소";
    const ok = document.createElement("button"); ok.type = "submit"; ok.className = "btn small primary"; ok.textContent = "다시 보내기";
    row.append(cancel, ok); box.append(ta, warn, row); d.append(box);
    cancel.onclick = () => { box.remove(); d.classList.remove("editing"); for (const c of d.querySelectorAll(".slip-text,.slip-acts")) c.hidden = false; };
    box.onsubmit = (ev) => { ev.preventDefault(); const v = ta.value.trim(); if (v) rerun(idx, v); };
    ta.focus();
  }
  function rerun(idx, text) {
    if (state.busy) return;
    const g = state.game;
    const cut = idx < g.messages.length ? idx : undefined;
    if (cut !== undefined) {
      // 화면에서 먼저 지워 보여주고, 서버도 같은 지점부터 되돌린다
      g.messages = g.messages.slice(0, cut);
      showGame();
      const st = els.log.querySelector(".starter"); if (st) st.remove();
    }
    if (text === "턴 넘기기") send({ kind: "pass", truncateAt: cut });
    else send({ kind: "order", text, truncateAt: cut });
  }

  function addReport() {
    const a = document.createElement("article"); a.className = "report";
    a.innerHTML = '<div class="thinking"><span>보고서를 작성하는 중</span><i></i><i></i><i></i></div>';
    els.log.append(a);
    return a;
  }
  function badgeHtml(m) {
    if (!m || !m.provider) return "";
    const sw = (m.switched || []).map((x) => `${PROV_LABEL[x.from] || x.from} 실패`).join(", ");
    return `<p class="badge ${esc(m.provider)}"><span class="dot"></span>${esc(PROV_LABEL[m.provider] || m.provider)} · ${esc(m.model || "")}${sw ? ` · ${esc(sw)} 후 전환` : ""}</p>`;
  }
  function fillReport(el, text, m) {
    el.className = "report" + reportClass(text);
    el.innerHTML = badgeHtml(m) + renderReport(text);
    if (m && m.truncated) addNote(el, "보고가 길어 중간에 끊겼어요. 이어서 지시하면 계속 진행됩니다.");
  }
  function addNote(el, text, isErr, retry) {
    const n = document.createElement("div"); n.className = "r-note" + (isErr ? " err" : "");
    const p = document.createElement("div"); p.textContent = text; n.append(p);
    if (retry) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "다시 보내기";
      b.onclick = retry; n.append(b);
    }
    el.append(n);
  }
  function scrollDown(force) {
    if (force || state.autoScroll) els.feed.scrollTop = els.feed.scrollHeight;
  }
  els.feed.addEventListener("scroll", () => {
    const f = els.feed;
    state.autoScroll = f.scrollHeight - f.scrollTop - f.clientHeight < 90;
  });

  function setBusy(b) {
    state.busy = b;
    els.btnSend.hidden = b; els.btnStop.hidden = !b;
    for (const c of els.chips.querySelectorAll("button")) c.disabled = b;
    for (const c of els.log.querySelectorAll(".slip-acts button")) c.disabled = b;
    els.gMode.disabled = b;
  }
  function compNote(msg) { els.compNote.textContent = msg || ""; els.compNote.hidden = !msg; }

  /* ---------- 한 턴 보내기 ----------
   * req: { kind: "order"|"pass"|"start"|"resume", text?, truncateAt? }
   */
  async function send(req) {
    if (state.busy) return;
    const g = state.game;
    compNote("");
    for (const el of state.pending) el.remove();
    const starter = els.log.querySelector(".starter"); if (starter) starter.remove();

    const shown = req.kind === "pass" ? "턴 넘기기"
      : req.kind === "start" ? `게임 시작 · ${g.era} · ${g.org}`
      : req.kind === "resume" ? "이어하기 · 옮겨 온 기록에서 시작"
      : req.text;
    const slip = addSlip(shown, g.messages.length);
    const rep = addReport();
    state.pending = [slip, rep];
    markLast(); scrollDown(true); setBusy(true);

    const ctl = new AbortController(); state.ctl = ctl;
    const lock = await keepAwake();
    let text = "", notes = [], failed = null, done = null;
    const paint = () => {
      rep.className = "report" + reportClass(text);
      rep.innerHTML = notes.map((n) => `<p class="switch-note">${esc(n)}</p>`).join("") + (text ? renderReport(text) : '<div class="thinking"><span>보고서를 작성하는 중</span><i></i><i></i><i></i></div>');
      scrollDown();
    };
    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
    try {
      await stream(`/api/games/${g.id}/turn`, { ...req, mode }, {
        delta: (d) => { text += d.t; schedule(); },
        reset: () => { text = ""; schedule(); },
        switch: (d) => { notes.push(`${d.fromLabel}: ${d.reason} → ${d.toLabel}로 넘겨서 이어갑니다`); schedule(); },
        done: (d) => { done = d; },
        fail: (d) => { failed = d; },
      }, ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) failed = { kind: "aborted" };
      else if (e instanceof AuthError) failed = { kind: "auth" };
      else failed = failed || { kind: e.kind || "network", message: e.message };
    } finally {
      cancelAnimationFrame(raf);
      state.ctl = null;
      if (lock) lock.release().catch(() => {});
    }

    if (done) {
      state.game = done.game;
      state.pending = [];
      const last = state.game.messages[state.game.messages.length - 1];
      fillReport(rep, last.content, last);
      // 수정·되돌리기 기준 위치를 서버 기록과 맞추기 위해 다시 그린다
      const keepScroll = els.feed.scrollTop;
      showGame();
      els.feed.scrollTop = state.autoScroll ? els.feed.scrollHeight : keepScroll;
      if (last.switched) compNote(`이번 턴은 ${PROV_LABEL[last.provider]}가 이어받았어요. 기록은 그대로 공유돼요.`);
      return;
    }
    setBusy(false);
    handleFail(failed || { kind: "network" }, rep, req);
  }

  // 보고를 받는 동안 화면이 꺼져 요청이 끊기지 않게 한다 (지원하는 폰에서만)
  async function keepAwake() {
    try { return navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch { return null; }
  }

  function handleFail(f, rep, req) {
    const retry = () => send(req);
    rep.innerHTML = "";
    const restore = () => { if (req.kind === "order" && !els.msg.value.trim()) { els.msg.value = req.text; autoGrow(); } };
    switch (f.kind) {
      case "aborted":
        addNote(rep, "보고를 중단했어요. 이 턴은 반영되지 않았어요.", false, req.kind !== "order" ? retry : null);
        restore(); break;
      case "refused":
        addNote(rep, "이 지시는 진행할 수 없다는 응답을 받았어요. 다른 방식으로 지시해 보세요. " + (f.message || ""), true);
        restore(); break;
      case "quota":
        addNote(rep, "모든 모델이 크레딧·사용량 한도에 걸렸어요. 잠시 뒤 다시 보내거나 API 결제 상태를 확인하세요. " + (f.message || ""), true, retry); break;
      case "no_key": case "auth":
        addNote(rep, "API 키가 없거나 잘못됐어요. 홈의 '설정'에서 확인하세요. " + (f.message || ""), true, retry); break;
      case "too_large":
        addNote(rep, "보낼 내용이 너무 길어요. 설정 > 고급 설정에서 '최근 턴 수'를 줄이거나 지시를 나눠 보내세요.", true, retry);
        restore(); break;
      default:
        addNote(rep, "보고를 받지 못했어요. 이 턴은 반영되지 않았어요. " + (f.message || f.reason || ""), true, retry);
    }
    // 수정해서 보낸 경우 서버 상태와 화면이 어긋나지 않도록 다시 불러온다
    if (req.truncateAt !== undefined) api(`/api/games/${state.game.id}`).then((g) => { state.game = g; }).catch(() => {});
  }

  function autoGrow() {
    els.msg.style.height = "auto";
    els.msg.style.height = Math.min(els.msg.scrollHeight + 2, 200) + "px";
  }
  els.msg.addEventListener("input", autoGrow);
  els.msg.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); els.sendForm.requestSubmit(); }
  });
  els.sendForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = els.msg.value.trim();
    if (!v || state.busy) return;
    els.msg.value = ""; autoGrow();
    send({ kind: "order", text: v });
  });
  els.btnStop.addEventListener("click", () => { if (state.ctl) state.ctl.abort(); });
  for (const [label, cmd] of CHIPS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (cmd === "pass" ? " pass" : ""); b.textContent = label;
    b.onclick = () => (cmd === "pass" ? send({ kind: "pass" }) : send({ kind: "order", text: cmd }));
    els.chips.append(b);
  }
  els.btnHome.addEventListener("click", () => { if (state.ctl) state.ctl.abort(); showHome(); });
  els.btnPanel.addEventListener("click", () => els.panel.classList.add("open"));
  els.btnPanelClose.addEventListener("click", () => els.panel.classList.remove("open"));
  els.btnExport.addEventListener("click", async () => {
    try {
      const g = await api(`/api/games/${state.game.id}/export`);
      const name = `history-sim-${(g.orgLine || g.org || g.id).replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40)}-${g.turns || 0}턴.json`;
      const blob = new Blob([JSON.stringify(g)], { type: "application/json" });
      // 폰에서는 공유 시트(드라이브·카톡 나에게 보내기 등)로, 안 되면 파일 다운로드로
      const file = typeof File === "function" ? new File([blob], name, { type: "application/json" }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { compNote("백업을 받지 못했어요: " + e.message); }
  });

  /* ---------- 시작 ---------- */
  async function boot() {
    if (!hasKeys()) { showSettings(true); return; }
    await loadStatus();
    const id = location.hash.slice(1);
    if (/^g[a-z0-9]+$/.test(id)) { await openGame(id); if (state.screen === "game") return; }
    showHome();
  }
  // 설치형 앱: 오프라인에서도 열리도록 화면 파일을 저장해 둔다
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  boot();
})();
