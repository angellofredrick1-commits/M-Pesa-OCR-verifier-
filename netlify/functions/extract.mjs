/**
 * Licence Audit Bench — extraction endpoint.
 *
 * The operator supplies their own Anthropic key from the browser, sent per request
 * in the x-anthropic-key header. If no header arrives, the function falls back to
 * ANTHROPIC_API_KEY in the environment, so a shared deployment still works.
 *
 * The key is never logged and never stored. It is used for the one call and dropped.
 *
 * No validity logic here on purpose: date maths runs in the browser against the
 * auditor's chosen reference date, so it stays deterministic and reviewable.
 */

export const config = { path: "/api/extract" };

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_BYTES = 3_500_000;           // decoded. Netlify caps the request at ~4.5 MB of binary.
const ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const SYSTEM = `You read Tanzanian business documents: BRELA business licences, local government trading licences (Class A / Class B), TRA Taxpayer Identification Number certificates, and business registration certificates.

Return ONLY a JSON object. No markdown fences, no commentary, no explanation.

Keys, all required:
business_name, business_type, category, tin, licence_number, issuing_authority,
region, district, ward, address, issue_date, expiry_date,
renewal_evidence, document_type, legibility, notes

Rules:
- Use null for anything not clearly readable on the document. Never infer, never guess, never fill a field from what would be typical.
- issue_date and expiry_date: "YYYY-MM-DD". If only a month and year are printed, use the first of that month and say so in notes. If no expiry is printed at all, use null — do not calculate one.
- tin: the digits exactly as printed, keeping hyphens.
- business_type: the legal form (sole proprietorship, partnership, limited company) if stated.
- category: the trade activity or licence class printed on the document.
- renewal_evidence: one of "renewal stamp", "sequential validity dates", "none visible".
- legibility: one of "clear", "partial", "poor".
- notes: at most 20 words on anything an auditor should check by hand. Empty string if nothing.`;

const KEYS = ["business_name","business_type","category","tin","licence_number","issuing_authority",
  "region","district","ward","address","issue_date","expiry_date","renewal_evidence",
  "document_type","legibility","notes"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

/** Strip whitespace and wrapping quotes — the two things that silently break a pasted key. */
const clean = s => (s || "").trim().replace(/^["']|["']$/g, "");

/** Turn an upstream failure into something the operator can act on. */
function explain(status, detail) {
  if (status === 401) return "This key was rejected. Check it was copied in full from the Anthropic Console.";
  if (status === 403) return "This key is not permitted to make this call. Check its permissions in the Console.";
  if (status === 429) return "Rate limited. The key works — wait a moment and send fewer files at once.";
  if (status === 404) return "That model name was not found for this key. Try a different model.";
  if (status >= 500) return "The model service is busy. Try again shortly.";
  if (detail && /credit|balance|billing/i.test(detail)) return "This key has no credit. Add funds in the Anthropic Console.";
  if (detail && /model/i.test(detail)) return "That model is not available to this key. Try a different model.";
  return detail || `The model service refused the request (${status}).`;
}

async function callAnthropic(key, body) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
}

export default async (req) => {
  // Health check. Reports shape only, never the key.
  if (req.method === "GET") {
    const env = process.env.ANTHROPIC_API_KEY || "";
    return json({
      ok: true,
      serverKeyPresent: Boolean(env),
      serverKeyLength: env.length,
      defaultModel: DEFAULT_MODEL,
      deployContext: process.env.CONTEXT || null,
      deployId: process.env.DEPLOY_ID || null
    });
  }

  if (req.method !== "POST") return json({ ok: false, error: "Send a POST request." }, 405);

  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: "The request body was not valid JSON." }, 400); }

  const key = clean(req.headers.get("x-anthropic-key")) || clean(process.env.ANTHROPIC_API_KEY);
  if (!key) return json({ ok: false, error: "No API key was supplied. Enter one to begin.", needKey: true }, 401);

  const model = /^[a-z0-9.\-]{3,64}$/i.test(payload?.model || "") ? payload.model : DEFAULT_MODEL;

  /* ---- verify mode: one tiny call, just to confirm the key works ---- */
  if (payload?.verify) {
    let res;
    try {
      res = await callAnthropic(key, { model, max_tokens: 4, messages: [{ role: "user", content: "hi" }] });
    } catch {
      return json({ ok: false, error: "Could not reach the model service." }, 502);
    }
    if (res.ok || res.status === 429) return json({ ok: true, model });
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    return json({ ok: false, status: res.status, error: explain(res.status, detail), needKey: res.status === 401 }, 200);
  }

  /* ---- extraction ---- */
  const { data, mediaType } = payload || {};
  if (typeof data !== "string" || !data)
    return json({ ok: false, error: "No document data arrived with the request." }, 400);
  if (!ALLOWED.has(mediaType))
    return json({ ok: false, error: "Unsupported file type. Send a PDF, JPEG, PNG or WebP." }, 415);
  if (Math.floor(data.length * 3 / 4) > MAX_BYTES)
    return json({ ok: false, error: "This file is over 3.5 MB. Compress the scan or split the pages, then try again." }, 413);

  const block = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
    : { type: "image",    source: { type: "base64", media_type: mediaType, data } };

  const body = {
    model,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [block, { type: "text", text: "Extract the fields. Return only the JSON object." }]
    }]
  };

  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 700 * attempt));

    let res;
    try { res = await callAnthropic(key, body); }
    catch { last = "Could not reach the model service."; continue; }

    if (res.status === 429 || res.status >= 500) {
      last = explain(res.status, "");
      continue;
    }

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
      return json({ ok: false, error: explain(res.status, detail), needKey: res.status === 401 }, 200);
    }

    const out = await res.json();
    const text = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < 0) { last = "The reader returned no fields for this document."; continue; }

    let fields;
    try { fields = JSON.parse(text.slice(a, b + 1)); }
    catch { last = "The reader's response could not be parsed."; continue; }

    const norm = {};
    for (const k of KEYS) {
      const v = fields[k];
      norm[k] = (v === undefined || v === null || v === "" || v === "N/A" || v === "null") ? null : v;
    }
    norm.notes = norm.notes || "";

    return json({ ok: true, fields: norm, model, usage: out.usage || null });
  }

  return json({ ok: false, error: last || "The document could not be read. Try again." }, 200);
};
