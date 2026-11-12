/* Safe wrappers around localStorage / sessionStorage (private mode, blocked storage and quota errors never throw). */

function make(getStore) {
  const mem = new Map();
  const st = () => { try { return getStore(); } catch { return null; } };
  return {
    get(key, fallback = null) {
      try { const s = st(); const v = s ? s.getItem(key) : mem.get(key) ?? null; return v === null || v === undefined ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      const v = JSON.stringify(value);
      try { const s = st(); if (s) s.setItem(key, v); else mem.set(key, v); return true; } catch { mem.set(key, v); return false; }
    },
    remove(key) { try { const s = st(); if (s) s.removeItem(key); } catch { /* ignore */ } mem.delete(key); },
    getRaw(key, fallback = null) { try { const s = st(); const v = s ? s.getItem(key) : mem.get(key); return v ?? fallback; } catch { return fallback; } },
    setRaw(key, v) { try { const s = st(); if (s) s.setItem(key, String(v)); else mem.set(key, String(v)); } catch { mem.set(key, String(v)); } },
  };
}

export const local = make(() => window.localStorage);
export const session = make(() => window.sessionStorage);
