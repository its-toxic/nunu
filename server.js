// server.js — سيرفر نونو
// التشغيل: node server.js   (يحتاج Node 18+)
// الإيميل يحتاج: npm install nodemailer  + GMAIL_USER + GMAIL_APP_PASSWORD

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const NUNU_USER = process.env.NUNU_USER || "nono";
const NUNU_PASS = process.env.NUNU_PASS || "nono_0807";
const GROQ_KEY = (process.env.GROQ_API_KEY || "").trim();
const MODEL_LIST = [...new Set([process.env.GROQ_MODEL, "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"].filter(Boolean))];
const VENT_TO = "its.toxic0807@gmail.com";
const HOURLY_LIMIT = 40;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 20 * 1024;

if (!NUNU_PASS) console.warn("⚠️  NUNU_PASS مش متحدد: تسجيل الدخول هيفشل");
if (!GROQ_KEY) console.warn("⚠️  GROQ_API_KEY مش متحدد: الشات هيرد بردود احتياطية");

/* ---------- الإيميل ---------- */
let mailer = null;
let mailError = "";
try {
  const nodemailer = require("nodemailer");
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    mailer = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "")
      }
    });
  } else {
    mailError = "GMAIL_USER أو GMAIL_APP_PASSWORD مش متحددين في الـ Terminal";
  }
} catch {
  mailError = "nodemailer مش متثبت: اكتبي npm install nodemailer في مجلد memo";
}
if (mailError) console.warn("⚠️  الإيميل: " + mailError);

const sessions = new Map(); // token -> { expires, stamps: [] }

const SYSTEM_PROMPT = `أنتِ "نونو"، أرنب صغير لطيف ودود، رفيق مذاكرة للي بتذاكر معاكي.
- اتكلمي بالعامية المصرية، بلطف وحنان، وبكلام قصير (جملتين أو تلاتة).
- شجّعيها وافتخري بمجهودها، وفكّريها إن الراحة جزء من المذاكرة.
- ماتعاقبيهاش ولا تزعلي منها أبداً لو ماذاكرتش أو قفلت الموقع، ومتخلّيهاش تحس بذنب.
- ماتطلبيش منها معلومات شخصية أو صور، ومتقوليش إنك إنسانة حقيقية.
- لو حسيتي إنها زعلانة أو تعبانة جداً، اسمعيها بحنية واقترحي تكلّم حد تثق فيه (أهلها أو صاحبة).
- ماتحليش واجباتها كاملة؛ ساعديها تفهم بالشرح والتلميح.`;

const FALLBACK = {
  ar: ["أنا جنبك يا قمر 🐰 قوليلي عايزة تذاكري إيه النهارده؟", "شطورة إنك بتحاولي، كملي كده 🤍"],
  en: ["I'm right here, sweetheart 🐰 What do you want to study today?", "Proud of you for trying 🤍"]
};

/* ---------- helpers ---------- */
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > MAX_BODY) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

// مقارنة آمنة من تايمنج أتاك
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getSession(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

/* ---------- Groq ---------- */
// بيجرّب الموديلات الواحد ورا التاني لو اسم الموديل مش متاح
async function callGroq(messages, maxTokens = 300) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY مش متحدد في الـ Terminal");
  let lastErr = "";
  for (const model of MODEL_LIST) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + GROQ_KEY },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages })
    });
    const raw = await r.text();
    if (r.ok) {
      const data = JSON.parse(raw);
      return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    }
    lastErr = `Groq ${r.status} (${model}): ${raw.slice(0, 160)}`;
    const modelIssue = r.status === 404 || /model/i.test(raw);
    if (!modelIssue) break; // مفتاح غلط أو حد الاستخدام: مفيش فايدة نجرب موديل تاني
  }
  throw new Error(lastErr);
}

/* ---------- handlers ---------- */
async function handleLogin(req, res) {
  const body = await readBody(req);
  const okUser = safeEqual(body.user || "", NUNU_USER);
  const okPass = NUNU_PASS && safeEqual(body.pass || "", NUNU_PASS);
  if (!okUser || !okPass) return send(res, 401, { error: "bad credentials" });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expires: Date.now() + SESSION_MS, stamps: [] });
  send(res, 200, { token });
}

async function handleChat(req, res) {
  const session = getSession(req);
  if (!session) return send(res, 401, { error: "login required" });

  // حد الرسايل بالساعة
  const now = Date.now();
  session.stamps = session.stamps.filter(t => now - t < 60 * 60 * 1000);
  if (session.stamps.length >= HOURLY_LIMIT) {
    return send(res, 429, { reply: "خدي نفس يا قمر، نكمل بعد شوية 🤍" });
  }
  session.stamps.push(now);

  const body = await readBody(req);
  const lang = body.lang === "en" ? "en" : "ar";
  const fallback = () => pick(FALLBACK[lang]);

  // تنظيف الرسايل: user/assistant بس، وطول معقول، وآخر 12
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 500) }))
    .slice(-12);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return send(res, 400, { error: "no user message" });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();

  // سياق المذاكرة (أرقام بس)
  const c = body.context || {};
  const num = v => Math.max(0, Math.min(100000, parseInt(v, 10) || 0));
  const subject = typeof c.subject === "string" ? c.subject.slice(0, 40) : "";
  // اسم المستخدم ونوعه (ولد/بنت) عشان الكلام يتقال بالصيغة الصح
  const who = typeof c.name === "string" ? c.name.slice(0, 30).replace(/["\n]/g, "").trim() : "";
  const isBoy = c.gender === "ولد";
  const genderLine = isBoy ? "المستخدم ولد: خاطبيه بصيغة المذكر (إنت، شاطر، مذاكر)" : "المستخدمة بنت: خاطبيها بصيغة المؤنث (إنتِ، شاطرة، مذاكرة)";
  const ctxLine = `سياق: ${who ? "اسم المستخدم: " + who + "، ناديه/ناديها باسمه أحياناً. " : ""}${genderLine}. ` +
    `دقايق مذاكرة=${num(c.minutes)}، أسئلة محلولة=${num(c.questions)}، نقاط=${num(c.points)}` +
    (subject ? `، المادة الحالية=${subject}` : "") +
    `. اللغة المفضلة: ${lang === "en" ? "English" : "العربية"}.`;

  if (!GROQ_KEY) {
    return send(res, 200, { reply: fallback(), error: "GROQ_API_KEY مش متحدد في الـ Terminal" });
  }

  try {
    const text = await callGroq([
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + ctxLine },
      ...messages
    ], 300);
    send(res, 200, { reply: text || fallback() });
  } catch (err) {
    console.error("chat error:", err.message);
    send(res, 200, { reply: fallback(), error: err.message.slice(0, 200) });
  }
}

// فحص: الشات والإيميل (بيرجع السبب لو واقف)
async function handleStatus(req, res) {
  if (!getSession(req)) return send(res, 401, { error: "login required" });
  let chat;
  try {
    const txt = await callGroq([{ role: "user", content: "قولي كلمة واحدة: تمام" }], 20);
    chat = { ok: true, reply: txt };
  } catch (err) {
    chat = { ok: false, error: err.message.slice(0, 200) };
  }
  send(res, 200, { chat, mail: { ok: !!mailer, error: mailError } });
}

// الفضفضة: بتتبعت على الإيميل، ومش بتتسجل في أي مكان تاني
async function handleVent(req, res) {
  if (!getSession(req)) return send(res, 401, { error: "login required" });
  const body = await readBody(req);
  const text = String(body.text || "").trim().slice(0, 5000);
  const mode = body.mode === "save" || body.mode === "vent" ? body.mode : "send";
  if (!text) return send(res, 400, { error: "empty" });
  if (!mailer) return send(res, 500, { error: "mail_not_configured", detail: mailError });

  const subjects = { send: "💌 رسالة من مريم لنونو", save: "💾 فضفضة محفوظة", vent: "🌠 فضفضة من مريم" };
  try {
    await mailer.sendMail({
      from: `"نونو" <${process.env.GMAIL_USER}>`,
      to: VENT_TO,
      subject: subjects[mode],
      text: text + "\n\n— أُرسلت من موقع نونو"
    });
    send(res, 200, { ok: true });
  } catch (err) {
    // مابنسجلش نص الرسالة، بس سبب الخطأ
    console.error("mail error:", err.message);
    send(res, 500, { error: "mail_failed", detail: err.message.slice(0, 160) });
  }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* ---------- static ---------- */
const INDEX = path.join(__dirname, "index.html");
function serveIndex(res) {
  fs.readFile(INDEX, (err, buf) => {
    if (err) return send(res, 500, { error: "index.html missing" });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
}

/* ---------- ملفات الـ PWA (الأيقونات والـ manifest) ---------- */
const STATIC = {
  "/manifest.webmanifest": ["application/manifest+json; charset=utf-8", "manifest.webmanifest"],
  "/icon.svg": ["image/svg+xml", "icon.svg"],
  "/icon-192.png": ["image/png", "icon-192.png"],
  "/icon-512.png": ["image/png", "icon-512.png"],
  "/icon-180.png": ["image/png", "icon-180.png"],
  "/sw.js": ["application/javascript; charset=utf-8", "sw.js"]
};
function serveStatic(res, type, file) {
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) return serveIndex(res);
    if (req.method === "GET" && STATIC[req.url]) return serveStatic(res, STATIC[req.url][0], STATIC[req.url][1]);
    if (req.method === "GET" && req.url === "/api/status") return await handleStatus(req, res);
    if (req.method === "POST" && req.url === "/api/login") return await handleLogin(req, res);
    if (req.method === "POST" && req.url === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && req.url === "/api/vent") return await handleVent(req, res);
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 400, { error: "bad request" });
  }
});

// تنظيف الجلسات المنتهية كل ساعة
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log(`نونو شغال على http://localhost:${PORT}`));
