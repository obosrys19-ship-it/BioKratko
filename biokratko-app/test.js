// Запуск: npm test. Поднимает поддельный API модели и проверяет сервер, ключ и сетевые вызовы не нужны.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

let seen, mode = "line";
const fake = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/commons")) { // поддельный Wikimedia Commons
    return res.end(JSON.stringify({ query: { pages: {
      2: { index: 2, title: "File:Second.png", imageinfo: [{ mime: "image/png", width: 900, thumburl: "https://upload.wikimedia.org/b.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:Second.png", extmetadata: {} }] },
      1: { index: 1, title: "File:PCR_cycle.svg", imageinfo: [{ mime: "image/svg+xml", width: 900, thumburl: "https://upload.wikimedia.org/a.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:PCR_cycle.svg", extmetadata: { Artist: { value: "<a href='x'>Иван</a>" }, LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
    } } }));
  }
  const body = JSON.parse(b); seen = { auth: req.headers.authorization, body };
  const short = body.max_tokens <= 40;
  const content = short ? "PCR thermal cycle" : mode === "line" ? "ПЦР размножает участок ДНК.\nКАРТИНКА: PCR cycle diagram" : mode === "none" ? "Отвечаю только на вопросы по биологии.\nКАРТИНКА: нет" : "ПЦР размножает участок ДНК.";
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
}).listen(0);
await new Promise((r) => fake.once("listening", r));

const PORT = 3999;
const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT, API_BASE: `http://127.0.0.1:${fake.address().port}`, COMMONS_API: `http://127.0.0.1:${fake.address().port}/commons`, API_KEY: "k", MODEL: "m" }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));
const post = (b) => fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: "POST", body: JSON.stringify(b) });

try {
  const ask = async () => (await post({ section: "mol", messages: [{ role: "user", content: "Что такое ПЦР?" }] })).json();

  let d = await ask(); // модель дала строку КАРТИНКА
  assert.equal(d.text, "ПЦР размножает участок ДНК.");
  assert.equal(d.truncated, false);
  assert.deepEqual(d.image, { url: "https://upload.wikimedia.org/a.png", page: "https://commons.wikimedia.org/wiki/File:PCR_cycle.svg", title: "PCR cycle", author: "Иван", license: "CC BY-SA 4.0" });
  assert.equal(seen.body.messages[0].role, "system");
  assert.match(seen.body.messages[0].content, /Молекулярная биология/);

  mode = "forgot"; d = await ask(); // модель забыла строку: запасной запрос
  assert.equal(d.text, "ПЦР размножает участок ДНК.");
  assert.equal(d.image?.title, "PCR cycle");

  mode = "none"; d = await ask(); // иллюстрация не нужна
  assert.equal(d.image, null);
  assert.equal(d.text, "Отвечаю только на вопросы по биологии.");
  mode = "line";
  assert.equal(seen.auth, "Bearer k");

  for (const bad of [
    { section: "nope", messages: [{ role: "user", content: "x" }] },
    { section: "mol", messages: [] },
    { section: "mol", messages: [{ role: "assistant", content: "x" }] },
    { section: "mol", messages: [{ role: "system", content: "x" }] },
    { section: "mol", messages: [{ role: "user", content: "x".repeat(4001) }] },
  ]) assert.equal((await post(bad)).status, 400);

  assert.equal((await fetch(`http://127.0.0.1:${PORT}/../server.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/sections.json`)).status, 200);
  assert.match(await (await fetch(`http://127.0.0.1:${PORT}/`)).text(), /БиоКратко/);
  console.log("OK");
} finally { srv.kill(); fake.close(); }
