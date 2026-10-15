// 게임 저장소 (이 기기의 IndexedDB). 게임 하나가 레코드 하나다.
// 제미나이와 Claude가 함께 쓰는 "하나의 메모리"가 바로 이 레코드다.

const DB = "history-sim";
const OS = "games";
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(OS, { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error("저장소를 열 수 없어요"));
    });
    // 브라우저가 공간이 부족할 때 마음대로 지우지 않도록 요청
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* 무시 */ }
  }
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(OS, mode);
    const req = fn(t.objectStore(OS));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("저장 실패"));
  }));
}

export function newId() {
  return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 같은 게임에 동시에 두 작업이 쓰지 않도록 게임별 잠금
const locks = new Map();
export async function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(id, chain);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (locks.get(id) === chain) locks.delete(id);
  }
}

export async function load(id) {
  return (await tx("readonly", (os) => os.get(String(id)))) || null;
}

export async function save(g) {
  g.updatedAt = Date.now();
  await tx("readwrite", (os) => os.put(g));
  return g;
}

export async function remove(id) {
  await tx("readwrite", (os) => os.delete(String(id)));
}

export async function list() {
  const all = (await tx("readonly", (os) => os.getAll())) || [];
  return all.map((g) => ({
    id: g.id, era: g.era, org: g.org, orgLine: g.orgLine, gameDate: g.gameDate,
    turns: g.turns, updatedAt: g.updatedAt, lastProvider: g.lastProvider || "",
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
