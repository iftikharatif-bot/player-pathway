// Reads the coach's Google Calendar through its secret iCal address (saved in pp_coach_settings)
// and returns the events in a date range. Only signed-in coaches can call it.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parseIcs } from "./ics.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const DAY = /^\d{4}-\d\d-\d\d$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: isCoach, error } = await sb.rpc("pp_is_coach");
    if (error || !isCoach) return json({ error: "not_coach" }, 403);

    const body = await req.json().catch(() => ({}));
    const start = String(body.start || ""), end = String(body.end || "");
    if (!DAY.test(start) || !DAY.test(end) || end < start) return json({ error: "bad_request" }, 400);
    if ((Date.parse(end) - Date.parse(start)) / 86400000 > 62) return json({ error: "range_too_long" }, 400);

    const { data: row } = await sb.from("pp_coach_settings").select("value").eq("key", "ics_url").maybeSingle();
    const url = row && row.value ? String(row.value).trim() : "";
    if (!url) return json({ error: "no_url" }, 200);
    let u: URL;
    try { u = new URL(url); } catch { return json({ error: "bad_url" }, 200); }
    if (u.protocol !== "https:" || u.hostname !== "calendar.google.com" || !u.pathname.startsWith("/calendar/ical/")) return json({ error: "bad_url" }, 200);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    let text: string;
    try {
      const r = await fetch(u.toString(), { signal: ctl.signal, headers: { Accept: "text/calendar" } });
      if (r.status === 404 || r.status === 403) return json({ error: "feed_gone" }, 200);
      if (!r.ok) return json({ error: "feed_error", detail: String(r.status) }, 502);
      text = await r.text();
    } finally { clearTimeout(t); }
    if (!/BEGIN:VCALENDAR/.test(text)) return json({ error: "bad_url" }, 200);

    const events = parseIcs(text, start, end, "America/Toronto");
    return json({ events, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
