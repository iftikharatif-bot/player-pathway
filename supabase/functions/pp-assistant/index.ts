// Coach assistant for the Player Pathway portal.
// Only signed-in coaches can call it. It forwards one prompt to Claude and returns the text.
// Needs the ANTHROPIC_API_KEY secret set on the Supabase project.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: isCoach, error } = await sb.rpc("pp_is_coach");
    if (error || !isCoach) return json({ error: "not_coach" }, 403);

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "no_key" }, 503);

    const body = await req.json().catch(() => ({}));
    const prompt = body && body.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 80000) return json({ error: "bad_request" }, 400);
    const model = body.tier === "quick" ? "claude-haiku-5-5" : "claude-sonnet-5-5";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 429) return json({ error: "rate_limited" }, 429);
    if (!r.ok) return json({ error: "upstream", detail: out?.error?.message || String(r.status) }, 502);
    const text = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    return json({ text });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
