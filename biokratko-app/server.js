// БиоКратко: статика + /api/chat, который передаёт вопрос модели через любой OpenAI-совместимый API.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(); } catch {} // .env необязателен, если переменные заданы окружением

const { COMMONS_API = "https://commons.wikimedia.org/w/api.php", API_BASE = "https://openrouter.ai/api/v1", API_KEY = "", MODEL = "meta-llama/llama-3.3-70b-instruct", PORT = 3000, HOST = "127.0.0.1" } = process.env;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");
const SECTIONS = JSON.parse(await readFile(join(ROOT, "sections.json"), "utf8"));
const byId = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));

const BASE = `Ты справочный ассистент для специалистов по биологии и биотехнологии. Отвечай на языке вопроса.
Правила ответа:
– Сразу по сути: без приветствий, вступлений, повторения вопроса, заключений и предложений помочь ещё.
– Коротко и точно: обычно 1–5 предложений или список до 6 пунктов. Длиннее только если вопрос явно требует протокола, расчёта или кода.
– Точные термины, названия генов, белков, организмов, реагентов, единицы измерения. Числа давай с единицами и условиями, при которых они верны.
– Если данные спорные или ты не уверен, скажи это одной короткой фразой. Не выдумывай цифры, источники и ссылки.
– Только простой текст: без markdown-разметки (никаких **, #, таблиц). Пункты списка начинай с «– ».
– Вопрос не по биологии и биотехнологии: ответь одной строкой, что отвечаешь только на эти темы.
– Вопрос по биологии, но из другого раздела: ответь по существу, не отказывай.
– Не давай инструкций по созданию, усилению или распространению патогенов и токсинов, пригодных как оружие: ответь одной строкой, что не можешь помочь с этим.
– Вопрос о лечении конкретного человека: одна-две фразы общей научной информации и совет обратиться к врачу.
– Самой последней строкой ответа, отдельно от текста, напиши КАРТИНКА: и поисковый запрос на английском (2–5 слов) для схемы или иллюстрации по теме, например «КАРТИНКА: PCR cycle diagram». Если иллюстрация не нужна (отказ, не по теме), напиши «КАРТИНКА: нет».`;

const MIME = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// shortcut: лимит в памяти одного процесса, за прокси или в нескольких копиях заменить на общий
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now); hits.set(ip, list);
  return list.length > 20;
};

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function parseChat(raw) {
  let b; try { b = JSON.parse(raw); } catch { return null; }
  const m = b?.messages;
  if (!byId[b?.section] || !Array.isArray(m) || !m.length || m.length > 12) return null;
  if (!m.every((x) => (x?.role === "user" || x?.role === "assistant") && typeof x.content === "string" && x.content.length > 0 && x.content.length <= 4000)) return null;
  if (m.at(-1).role !== "user") return null;
  return { section: byId[b.section], messages: m.map(({ role, content }) => ({ role, content })) };
}

// Достаёт из ответа строку «КАРТИНКА: ...». undefined: строки нет, null: иллюстрация не нужна.
function splitImageQuery(text) {
  const m = text.match(/^[\s*_>]*КАРТИНКА\s*:\s*(.*?)\s*$/im);
  if (!m) return { text, query: undefined };
  const q = m[1].replace(/[*_"«»\[\]<>`]/g, "").trim();
  return { text: text.slice(0, m.index).trim(), query: !q || /^(нет|none|-)$/i.test(q) ? null : q.slice(0, 80) };
}

const upstream = (messages, max_tokens) => fetch(`${API_BASE}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(API_KEY && { authorization: `Bearer ${API_KEY}` }) },
  body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens, messages }),
  signal: AbortSignal.timeout(60_000),
});

// Запасной путь, если модель забыла строку с картинкой: короткий отдельный запрос.
async function askImageQuery(question, answer) {
  const r = await upstream([{ role: "user", content: `Вопрос: ${question}\nОтвет: ${answer.slice(0, 600)}\n\nНапиши поисковый запрос на английском (2–5 слов) для схемы или иллюстрации к этой теме на Wikimedia Commons. Только запрос, без пояснений. Если иллюстрация не нужна, напиши: нет.` }], 30);
  if (!r.ok) return null;
  return splitImageQuery("КАРТИНКА: " + ((await r.json()).choices?.[0]?.message?.content ?? "")).query ?? null;
}

// Реальные иллюстрации с Wikimedia Commons (свободные лицензии), автор и лицензия показываются под картинкой.
async function findImage(q) {
  const u = new URL(COMMONS_API);
  u.search = new URLSearchParams({ action: "query", format: "json", generator: "search", gsrsearch: `${q} filetype:bitmap|drawing`, gsrnamespace: "6", gsrlimit: "8", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "800" });
  const r = await fetch(u, { headers: { "user-agent": "BioKratko/1.0 (educational app)" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const pages = Object.values((await r.json()).query?.pages ?? {}).sort((a, b) => a.index - b.index);
  const strip = (v) => (v?.value ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 80);
  for (const p of pages) {
    const i = p.imageinfo?.[0];
    if (!i || !/^image\/(jpeg|png|svg\+xml)$/.test(i.mime) || i.width < 300) continue;
    if (!i.thumburl?.startsWith("https://upload.wikimedia.org/") || !i.descriptionurl?.startsWith("https://commons.wikimedia.org/")) continue;
    return { url: i.thumburl, page: i.descriptionurl, title: p.title.replace(/^File:/, "").replace(/\.\w+$/, "").replaceAll("_", " "), author: strip(i.extmetadata?.Artist), license: strip(i.extmetadata?.LicenseShortName) };
  }
  return null;
}

async function chat(req, res) {
  if (limited(req.socket.remoteAddress)) return send(res, 429, { code: "rate_limited" });
  let raw = "";
  for await (const part of req) { raw += part; if (raw.length > 60_000) return send(res, 413, { code: "prompt_too_large" }); }
  const parsed = parseChat(raw);
  if (!parsed) return send(res, 400, { code: "bad_request" });
  if (!API_KEY && !/localhost|127\.0\.0\.1/.test(API_BASE)) return send(res, 503, { code: "not_configured" });

  const system = `${BASE}\n\nТвой раздел: ${parsed.section.name}. ${parsed.section.profile}`;
  try {
    const r = await upstream([{ role: "system", content: system }, ...parsed.messages], 750);
    if (!r.ok) {
      console.error("upstream", r.status, (await r.text()).slice(0, 300));
      return send(res, r.status === 429 ? 429 : 502, { code: r.status === 429 ? "rate_limited" : "upstream_error" });
    }
    const d = await r.json();
    const raw = d.choices?.[0]?.message?.content?.trim();
    if (!raw) return send(res, 502, { code: "empty_completion" });
    let { text, query } = splitImageQuery(raw);
    if (!text) return send(res, 502, { code: "empty_completion" });
    let image = null;
    try { // картинка необязательна: любой сбой здесь не должен ломать ответ
      if (query === undefined) query = await askImageQuery(parsed.messages.at(-1).content, text);
      if (query) image = await findImage(query);
    } catch (e) { console.error("image", e.message); }
    send(res, 200, { text, truncated: d.choices[0].finish_reason === "length", image });
  } catch (e) {
    console.error("upstream", e.message);
    send(res, 502, { code: "upstream_error" });
  }
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && path === "/api/chat") return await chat(req, res);
    if (req.method !== "GET") return send(res, 405, { code: "bad_request" });
    if (path === "/sections.json") return send(res, 200, SECTIONS);
    const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
    if (!file.startsWith(PUBLIC)) return send(res, 404, "not found", "text/plain");
    send(res, 200, await readFile(file), MIME[extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(+PORT, HOST, () => console.log(`БиоКратко: http://${HOST}:${PORT}  модель: ${MODEL}  api: ${API_BASE}`));
