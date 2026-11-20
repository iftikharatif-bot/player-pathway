// Minimal iCalendar (.ics) reader: single events, common repeat rules, exceptions and moved instances.
export type Ev = { id: string; title: string; date: string; start: string; mins: number; location: string };
type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
type DT = { allDay: true; y: number; mo: number; d: number } | { allDay: false; ms: number; tz: string };

const unesc = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wallOf(tz: string, ms: number): Wall {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function wallToMs(tz: string, w: Wall): number {
  const target = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = wallOf(tz, guess);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - target;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}
function validTz(tz: string) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}
function parseDT(val: string, params: Record<string, string>, defTz: string): DT | null {
  const m = val.trim().match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { allDay: true, y: +y, mo: +mo, d: +d };
  if (z) return { allDay: false, ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), tz: defTz };
  const tz = params.TZID && validTz(params.TZID) ? params.TZID : defTz;
  return { allDay: false, ms: wallToMs(tz, { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +(s || 0) }), tz };
}
function parseDuration(v: string): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, , w, d, h, mi, s] = m;
  return ((+(w || 0) * 7 + +(d || 0)) * 86400 + +(h || 0) * 3600 + +(mi || 0) * 60 + +(s || 0)) * 1000;
}
type Line = { name: string; params: Record<string, string>; value: string };
function parseLine(l: string): Line | null {
  let i = 0, q = false;
  for (; i < l.length; i++) { const c = l[i]; if (c === '"') q = !q; else if (c === ":" && !q) break; }
  if (i >= l.length) return null;
  const head = l.slice(0, i), value = l.slice(i + 1);
  const bits = head.split(";");
  const params: Record<string, string> = {};
  for (const b of bits.slice(1)) { const k = b.indexOf("="); if (k > 0) params[b.slice(0, k).toUpperCase()] = b.slice(k + 1).replace(/^"|"$/g, ""); }
  return { name: bits[0].toUpperCase(), params, value };
}
const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const addDays = (y: number, mo: number, d: number, n: number) => { const t = new Date(Date.UTC(y, mo - 1, d + n)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dow = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
function nthWeekday(y: number, mo: number, wd: number, n: number) {
  if (n > 0) { const first = dow(y, mo, 1); const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return d <= daysIn(y, mo) ? d : 0; }
  const last = daysIn(y, mo); const ld = dow(y, mo, last); const d = last - ((ld - wd + 7) % 7) + (n + 1) * 7; return d >= 1 ? d : 0;
}

export function parseIcs(text: string, rangeStart: string, rangeEnd: string, fallbackTz = "America/Toronto"): Ev[] {
  const raw = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const calTz = (raw.match(/^X-WR-TIMEZONE:(.+)$/m) || [])[1]?.trim();
  const tz = calTz && validTz(calTz) ? calTz : fallbackTz;
  const blocks = raw.split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]);
  type V = { uid: string; title: string; loc: string; start: DT; durMs: number; rrule?: Record<string, string>; ex: Set<string>; recId?: string; cancelled: boolean };
  const evs: V[] = [];
  const keyOf = (dt: DT) => (dt.allDay ? ymd(dt.y, dt.mo, dt.d) : String(dt.ms));
  for (const b of blocks) {
    const v: Partial<V> & { ex: Set<string> } = { ex: new Set(), cancelled: false };
    let end: DT | null = null, dur = 0;
    for (const ln of b.split("\n")) {
      const L = parseLine(ln); if (!L) continue;
      if (L.name === "UID") v.uid = L.value.trim();
      else if (L.name === "SUMMARY") v.title = unesc(L.value).trim();
      else if (L.name === "LOCATION") v.loc = unesc(L.value).trim();
      else if (L.name === "STATUS") v.cancelled = /CANCELLED/i.test(L.value);
      else if (L.name === "DTSTART") v.start = parseDT(L.value, L.params, tz) || undefined;
      else if (L.name === "DTEND") end = parseDT(L.value, L.params, tz);
      else if (L.name === "DURATION") dur = parseDuration(L.value.trim());
      else if (L.name === "RRULE") v.rrule = Object.fromEntries(L.value.split(";").map((p) => { const [k, x] = p.split("="); return [k.toUpperCase(), x]; }));
      else if (L.name === "EXDATE") for (const x of L.value.split(",")) { const dt = parseDT(x, L.params, tz); if (dt) v.ex.add(keyOf(dt)); }
      else if (L.name === "RECURRENCE-ID") { const dt = parseDT(L.value, L.params, tz); if (dt) v.recId = keyOf(dt); }
    }
    if (!v.uid || !v.start) continue;
    if (end) dur = end.allDay || v.start.allDay
      ? (Date.UTC((end as any).y, (end as any).mo - 1, (end as any).d) - Date.UTC((v.start as any).y, (v.start as any).mo - 1, (v.start as any).d))
      : (end as any).ms - (v.start as any).ms;
    v.durMs = dur > 0 ? dur : (v.start.allDay ? 86400000 : 3600000);
    evs.push({ uid: v.uid, title: v.title || "(no title)", loc: v.loc || "", start: v.start, durMs: v.durMs, rrule: v.rrule, ex: v.ex, recId: v.recId, cancelled: !!v.cancelled });
  }
  const moved = new Map<string, Set<string>>();
  for (const e of evs) if (e.recId) { if (!moved.has(e.uid)) moved.set(e.uid, new Set()); moved.get(e.uid)!.add(e.recId); }

  const out: Ev[] = [];
  const baseId = (uid: string) => uid.replace(/@google\.com$/i, "");
  const emit = (e: V, dt: DT, recurring: boolean) => {
    if (e.cancelled) return;
    let date: string, start = "", mins = 0;
    if (dt.allDay) date = ymd(dt.y, dt.mo, dt.d);
    else { const w = wallOf(tz, dt.ms); date = ymd(w.y, w.mo, w.d); start = `${pad(w.h)}:${pad(w.mi)}`; mins = Math.max(15, Math.round(e.durMs / 60000)); }
    if (date < rangeStart || date > rangeEnd) return;
    out.push({ id: recurring ? `${baseId(e.uid)}_${date.replace(/-/g, "")}` : baseId(e.uid), title: e.title, date, start, mins, location: e.loc });
  };

  for (const e of evs) {
    if (e.recId || !e.rrule) { emit(e, e.start, !!e.recId); continue; }
    const r = e.rrule, freq = (r.FREQ || "").toUpperCase(), interval = Math.max(1, +(r.INTERVAL || 1)), count = r.COUNT ? +r.COUNT : Infinity;
    let untilKey = "9999-99-99";
    if (r.UNTIL) { const u = parseDT(r.UNTIL, {}, tz); if (u) { if (u.allDay) untilKey = ymd(u.y, u.mo, u.d); else { const w = wallOf(tz, u.ms); untilKey = ymd(w.y, w.mo, w.d) + "T" + pad(w.h) + pad(w.mi); } } }
    const evTz = e.start.allDay ? tz : e.start.tz;
    const w0 = e.start.allDay ? { y: e.start.y, mo: e.start.mo, d: e.start.d, h: 0, mi: 0, s: 0 } : wallOf(evTz, e.start.ms);
    const byday = (r.BYDAY || "").split(",").filter(Boolean).map((x) => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m ? { n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2].toUpperCase()) } : null; }).filter(Boolean) as { n: number; wd: number }[];
    const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : [];
    const skip = moved.get(e.uid) || new Set<string>();
    let n = 0, guard = 0;
    const startKey = ymd(w0.y, w0.mo, w0.d);
    const take = (y: number, mo: number, d: number): boolean => {
      const date = ymd(y, mo, d);
      if (date < startKey) return true;
      if (date > rangeEnd) return false;
      const stamp = date + "T" + pad(w0.h) + pad(w0.mi);
      if ((e.start.allDay ? date : stamp) > untilKey) return false;
      if (++n > count) return false;
      const dt: DT = e.start.allDay ? { allDay: true, y, mo, d } : { allDay: false, ms: wallToMs(evTz, { y, mo, d, h: w0.h, mi: w0.mi, s: w0.s }), tz: evTz };
      const k = (dt as any).allDay ? date : String((dt as any).ms);
      if (!e.ex.has(k) && !skip.has(k)) emit(e, dt, true);
      return true;
    };
    outer: for (let k = 0; guard < 5000; k++) {
      if (freq === "DAILY") { const t = addDays(w0.y, w0.mo, w0.d, k * interval); guard++; if (!take(t.y, t.mo, t.d)) break; }
      else if (freq === "WEEKLY") {
        const days = byday.length ? byday.map((b) => b.wd) : [dow(w0.y, w0.mo, w0.d)];
        const mon = addDays(w0.y, w0.mo, w0.d, -((dow(w0.y, w0.mo, w0.d) + 6) % 7) + k * 7 * interval);
        for (const wd of [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) { guard++; const t = addDays(mon.y, mon.mo, mon.d, (wd + 6) % 7); if (!take(t.y, t.mo, t.d)) break outer; }
      } else if (freq === "MONTHLY") {
        const mIdx = w0.mo - 1 + k * interval, y = w0.y + Math.floor(mIdx / 12), mo = (mIdx % 12) + 1;
        let ds: number[] = byday.length ? byday.map((b) => nthWeekday(y, mo, b.wd, b.n || 1)) : (bymonthday.length ? bymonthday.map((x) => (x < 0 ? daysIn(y, mo) + x + 1 : x)) : [w0.d]);
        ds = ds.filter((d) => d >= 1 && d <= daysIn(y, mo)).sort((a, b) => a - b);
        for (const d of ds) { guard++; if (!take(y, mo, d)) break outer; }
        guard++;
      } else if (freq === "YEARLY") {
        guard++; const y = w0.y + k * interval; if (w0.d > daysIn(y, w0.mo)) continue; if (!take(y, w0.mo, w0.d)) break;
      } else { emit(e, e.start, false); break; }
    }
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
