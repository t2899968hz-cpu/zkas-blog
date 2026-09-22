"use strict";
/*
 * ZKas blog + admin.
 *   Public:  GET /blogs                index (published posts)
 *            GET /blog/<slug>          a post
 *            GET /blog/feed.xml        RSS
 *   Admin:   GET /blog/admin           login / dashboard (Markdown editor)
 *            POST /blog/admin/login|logout
 *            /blog/admin/api/*         posts CRUD, upload, preview  (auth + custom-header CSRF)
 *
 * Storage is file-based (no DB): one JSON file per post under STATE/posts,
 * images under MEDIA (served by nginx at /blog-media/). Secrets in STATE/secrets.json.
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const MarkdownIt = require("markdown-it");
const sanitizeHtml = require("sanitize-html");

// ---------- config ----------
const PORT = Number(process.env.ZB_PORT || 8530);
const STATE_DIR = process.env.ZB_STATE_DIR || "/root/zkas-blog";
const POSTS_DIR = path.join(STATE_DIR, "posts");
const MEDIA_DIR = process.env.ZB_MEDIA_DIR || "/var/www/zkas-blog-media";
const SECRETS_FILE = path.join(STATE_DIR, "secrets.json");
const SITE = "https://zkas.info";
const COOKIE = "zb_sess";

fs.mkdirSync(POSTS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

if (!fs.existsSync(SECRETS_FILE)) {
  console.error(`[zkas-blog] missing ${SECRETS_FILE} — run \`node setup.js\` first.`);
  process.exit(1);
}
const SECRETS = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));

// ---------- markdown + sanitize ----------
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
function renderMarkdown(src) {
  const raw = md.render(String(src || ""));
  return sanitizeHtml(raw, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li", "blockquote",
      "code", "pre", "em", "strong", "del", "s", "hr", "br", "img", "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td", "span",
    ],
    allowedAttributes: {
      a: ["href", "name", "title"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      span: ["class"],
      td: ["align"], th: ["align"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https", "http", "data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tn, a) => ({ tagName: "a", attribs: { ...a, target: "_blank", rel: "noopener nofollow ugc" } }),
      img: (tn, a) => ({ tagName: "img", attribs: { ...a, loading: "lazy", decoding: "async" } }),
    },
  });
}

// ---------- store ----------
let CACHE = null;
function loadAll() {
  if (CACHE) return CACHE;
  const list = [];
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { list.push(JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), "utf8"))); }
    catch (_) { /* skip corrupt */ }
  }
  list.sort((a, b) => new Date(b.published || b.created || 0) - new Date(a.published || a.created || 0));
  CACHE = list;
  return list;
}
function invalidate() { CACHE = null; }
function getPost(slug) { return loadAll().find((p) => p.slug === slug) || null; }
function savePost(p) {
  fs.writeFileSync(path.join(POSTS_DIR, p.slug + ".json"), JSON.stringify(p, null, 2));
  invalidate();
}
function deletePost(slug) {
  const f = path.join(POSTS_DIR, slug + ".json");
  if (fs.existsSync(f)) fs.unlinkSync(f);
  invalidate();
}

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function uniqueSlug(base, exceptSlug) {
  let s = slugify(base) || "post";
  let n = 1, cand = s;
  while (loadAll().some((p) => p.slug === cand && p.slug !== exceptSlug)) cand = s + "-" + (++n);
  return cand;
}
function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }
  catch (_) { return ""; }
}
function excerpt(body, n = 160) {
  const t = String(body || "")
    .replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

// ---------- auth ----------
function b64u(buf) { return Buffer.from(buf).toString("base64url"); }
function signToken(payload) {
  const data = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SECRETS.sessionSecret).update(data).digest("base64url");
  return data + "." + sig;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf(".") < 0) return null;
  const [data, sig] = tok.split(".");
  const expect = crypto.createHmac("sha256", SECRETS.sessionSecret).update(data).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((kv) => {
    const i = kv.indexOf("="); if (i < 0) return;
    out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) { return !!verifyToken(parseCookies(req)[COOKIE]); }
function checkPassword(pw) {
  try {
    const h = crypto.scryptSync(String(pw || ""), SECRETS.salt, 32);
    return crypto.timingSafeEqual(h, Buffer.from(SECRETS.hash, "hex"));
  } catch (_) { return false; }
}
// login rate limit (in-memory)
const attempts = new Map();
function rateOk(ip) {
  const now = Date.now(), w = 15 * 60 * 1000, max = 8;
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > w) { a.n = 0; a.t = now; }
  a.n++; attempts.set(ip, a);
  return a.n <= max;
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  // Custom-header CSRF: cross-site forms cannot set this header.
  if (req.method !== "GET" && req.get("X-ZB-CSRF") !== "1") return res.status(403).json({ error: "csrf" });
  next();
}

// ---------- theme / shell ----------
const CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url('/fonts/inter-var.woff2') format('woff2');}
:root{color-scheme:dark;--bg:#07100e;--panel:#0c1815;--panel-2:#10211c;--line:#203a32;--line-soft:#173028;--ink:#f1f8f5;--muted:#91aaa0;--faint:#61776e;--mint:#18d8bd;--mint-soft:rgba(24,216,189,.11);--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
html[data-theme="light"]{color-scheme:light;--bg:#eef1f0;--panel:#f8faf9;--panel-2:#e3e9e7;--line:#c8d4d0;--line-soft:#dbe3e0;--ink:#17231f;--muted:#4d625a;--faint:#6d8179;--mint:#087f72;--mint-soft:rgba(8,127,114,.09);}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);background:var(--bg);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;background-image:radial-gradient(900px 500px at 78% -200px,rgba(24,216,189,.12),transparent 72%);}
html[data-theme="light"] body{background-image:radial-gradient(900px 560px at 78% -200px,rgba(8,127,114,.10),transparent 72%);}
a{color:inherit;text-decoration:none}
img{max-width:100%}
.topbar{position:sticky;top:0;z-index:10;border-bottom:1px solid var(--line-soft);background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(16px)}
.bar{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:inline-flex;align-items:center;gap:9px;font-weight:750;font-size:16px}
.brand img{width:26px;height:26px;border-radius:7px}
.brand .z{color:var(--mint)}
.nav{display:flex;align-items:center;gap:16px;font-size:13px;color:var(--muted)}
.nav a:hover{color:var(--ink)}
.tt{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid var(--mint);border-radius:8px;color:var(--ink);background:var(--mint-soft);font:700 11px var(--mono);cursor:pointer}
.wrap{max-width:1080px;margin:0 auto;padding:34px 20px 80px}
.pagehead h1{font-size:34px;letter-spacing:-.02em;margin:0 0 6px}
.pagehead p{color:var(--muted);margin:0 0 8px;max-width:60ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin-top:26px}
.card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--panel);transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--mint);transform:translateY(-2px)}
.card .cov{aspect-ratio:16/9;background:var(--panel-2) center/cover no-repeat;border-bottom:1px solid var(--line-soft)}
.card .body{padding:15px 16px 18px;display:flex;flex-direction:column;gap:8px;flex:1}
.card h3{margin:0;font-size:17px;letter-spacing:-.01em;line-height:1.3}
.card .ex{color:var(--muted);font-size:13.5px;flex:1}
.meta{display:flex;gap:10px;align-items:center;color:var(--faint);font:11px var(--mono);text-transform:uppercase;letter-spacing:.06em}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font:600 11px var(--mono);color:var(--mint);border:1px solid var(--line);background:var(--mint-soft);border-radius:999px;padding:2px 9px}
.empty{border:1px dashed var(--line);border-radius:14px;padding:40px;text-align:center;color:var(--muted)}
/* article */
.article{max-width:760px;margin:0 auto}
.article .back{color:var(--muted);font-size:13px}
.article .cover{width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--line);border-radius:16px;margin:14px 0 8px}
.article h1{font-size:38px;letter-spacing:-.025em;line-height:1.12;margin:14px 0 6px}
.article .sub{font-size:19px;color:var(--muted);margin:0 0 12px}
.body-md{font-size:17px;line-height:1.75}
.body-md>*:first-child{margin-top:0}
.body-md h2{font-size:26px;letter-spacing:-.015em;margin:34px 0 10px}
.body-md h3{font-size:20px;margin:26px 0 8px}
.body-md p{margin:0 0 18px}
.body-md a{color:var(--mint);text-decoration:underline;text-underline-offset:2px}
.body-md img{border-radius:12px;border:1px solid var(--line);margin:10px 0}
.body-md blockquote{margin:18px 0;padding:2px 0 2px 16px;border-left:3px solid var(--mint);color:var(--muted)}
.body-md pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font:13px/1.6 var(--mono)}
.body-md code{font:13.5px var(--mono);background:var(--mint-soft);padding:.12em .4em;border-radius:5px}
.body-md pre code{background:none;padding:0}
.body-md ul,.body-md ol{margin:0 0 18px;padding-left:24px}
.body-md li{margin:6px 0}
.body-md table{border-collapse:collapse;width:100%;margin:18px 0;font-size:15px}
.body-md th,.body-md td{border:1px solid var(--line);padding:8px 11px;text-align:left}
.body-md hr{border:0;border-top:1px solid var(--line);margin:30px 0}
.foot{border-top:1px solid var(--line-soft);color:var(--faint);font-size:12px;text-align:center;padding:26px 20px}
@media(max-width:640px){.wrap{padding:22px 16px 60px}.pagehead h1{font-size:27px}.article h1{font-size:29px}.body-md{font-size:16px}}
`;

function shell({ title, desc, canonical, cover, bodyHtml, extraHead = "" }) {
  const d = esc(desc || "Private-by-default proof-of-work BlockDAG — news, guides and releases.");
  const og = cover ? `<meta property="og:image" content="${esc(SITE + cover)}">` : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${d}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${d}">
<meta property="og:type" content="article"><meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">${og}
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="alternate" type="application/rss+xml" title="ZKas blog" href="/blog/feed.xml">
<script>try{var t=localStorage.getItem('zkas-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
<style>${CSS}</style>${extraHead}
</head><body>
<header class="topbar"><div class="bar">
  <a class="brand" href="/"><img src="/logo-192.png" alt="ZKas" onerror="this.style.display='none'"><span><span class="z">Z</span>Kas</span></a>
  <nav class="nav"><a href="/blogs">Blog</a><a href="/whitepaper.html">Whitepaper</a>
    <button class="tt" id="tt" type="button" aria-label="Toggle theme"><span id="tti">☾</span></button></nav>
</div></header>
<main class="wrap">${bodyHtml}</main>
<footer class="foot">© ${new Date().getFullYear()} ZKas · <a href="/blogs">Blog</a> · <a href="/blog/feed.xml">RSS</a></footer>
<script>
(function(){var r=document.documentElement,b=document.getElementById('tt'),i=document.getElementById('tti');
function u(){var l=r.dataset.theme==='light';i.textContent=l?'☾':'☼';}
if(!r.dataset.theme){try{r.dataset.theme=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}catch(e){r.dataset.theme='dark';}}
u();b.addEventListener('click',function(){r.dataset.theme=r.dataset.theme==='light'?'dark':'light';try{localStorage.setItem('zkas-theme',r.dataset.theme);}catch(e){}u();});})();
</script>
</body></html>`;
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// Public: index
app.get("/blogs", (req, res) => {
  const posts = loadAll().filter((p) => p.status === "published");
  const cards = posts.map((p) => `
    <a class="card" href="/blog/${esc(p.slug)}">
      ${p.cover ? `<div class="cov" style="background-image:url('${esc(p.cover)}')"></div>` : `<div class="cov"></div>`}
      <div class="body">
        <div class="meta"><span>${esc(fmtDate(p.published || p.created))}</span></div>
        <h3>${esc(p.title)}</h3>
        <div class="ex">${esc(p.subtitle || excerpt(p.body))}</div>
        ${(p.tags && p.tags.length) ? `<div class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      </div>
    </a>`).join("");
  const body = `
    <div class="pagehead"><h1>Blog</h1><p>News, releases and deep dives on ZKas — the private-by-default proof-of-work BlockDAG.</p></div>
    ${posts.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No posts yet — check back soon.</div>`}`;
  res.type("html").set("Cache-Control", "public, max-age=60").send(
    shell({ title: "Blog · ZKas", desc: "News, releases and deep dives on ZKas.", canonical: SITE + "/blogs", bodyHtml: body }));
});

// Public: RSS
app.get("/blog/feed.xml", (req, res) => {
  const posts = loadAll().filter((p) => p.status === "published").slice(0, 30);
  const items = posts.map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${SITE}/blog/${esc(p.slug)}</link>
    <guid>${SITE}/blog/${esc(p.slug)}</guid>
    <pubDate>${new Date(p.published || p.created).toUTCString()}</pubDate>
    <description>${esc(p.subtitle || excerpt(p.body))}</description>
  </item>`).join("\n");
  res.type("application/rss+xml").set("Cache-Control", "public, max-age=300").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>ZKas blog</title>
  <link>${SITE}/blogs</link>
  <description>News, releases and deep dives on ZKas.</description>
${items}
</channel></rss>`);
});

// Admin dashboard / login page (HTML shell; logic in /blog/admin/app.js)
app.get("/blog/admin", (req, res) => {
  res.type("html").set("Cache-Control", "no-store").send(shell({
    title: "Admin · ZKas blog",
    desc: "ZKas blog admin",
    extraHead: `<style>
      .adminwrap{max-width:1080px}
      .login{max-width:360px;margin:8vh auto;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:24px}
      .login h1{font-size:20px;margin:0 0 14px}
      input,textarea,select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px 12px}
      textarea{min-height:340px;resize:vertical;font:13.5px/1.6 var(--mono)}
      label{display:block;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
      .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 15px;border:1px solid var(--mint);border-radius:9px;background:var(--mint);color:#06130f;font-weight:750;font-size:13px;cursor:pointer}
      html[data-theme="light"] .btn{color:#fff}
      .btn.sec{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500}
      .btn.danger{background:transparent;border-color:#d66;color:#e88}
      .admin{display:grid;grid-template-columns:280px 1fr;gap:20px}
      .plist{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:10px;max-height:78vh;overflow:auto}
      .pitem{padding:9px 10px;border-radius:9px;cursor:pointer;display:flex;flex-direction:column;gap:3px}
      .pitem:hover{background:var(--mint-soft)}
      .pitem.active{background:var(--mint-soft);outline:1px solid var(--mint)}
      .pitem .t{font-weight:650;font-size:13.5px}
      .badge{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.05em;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);width:max-content}
      .badge.pub{color:var(--mint);border-color:var(--mint)}
      .editor{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:18px}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
      .split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .preview{border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;max-height:60vh;background:var(--bg)}
      .cov-prev{width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--line);border-radius:10px;margin-top:6px;background:var(--panel-2)}
      .msg{font-size:12.5px;color:var(--muted);min-height:16px}
      @media(max-width:820px){.admin{grid-template-columns:1fr}.split{grid-template-columns:1fr}.row{grid-template-columns:1fr}}
    </style>`,
    bodyHtml: `<div id="app" class="adminwrap"></div><script src="/blog/admin/app.js"></script>`,
  }));
});

app.get("/blog/admin/app.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store")
    .sendFile(path.join(__dirname, "public", "admin.js"));
});

// Login / logout
app.post("/blog/admin/login", (req, res) => {
  const ip = req.ip || "?";
  if (!rateOk(ip)) return res.status(429).json({ error: "too many attempts, wait 15 min" });
  if (!checkPassword(req.body && req.body.password)) return res.status(401).json({ error: "wrong password" });
  const tok = signToken({ exp: Date.now() + 7 * 864e5 });
  res.set("Set-Cookie", `${COOKIE}=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`);
  res.json({ ok: true });
});
app.post("/blog/admin/logout", (req, res) => {
  res.set("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Admin API
app.get("/blog/admin/api/session", (req, res) => res.json({ authed: isAuthed(req) }));
app.get("/blog/admin/api/posts", requireAuth, (req, res) => {
  res.json(loadAll().map((p) => ({ slug: p.slug, title: p.title, status: p.status, published: p.published, created: p.created, updated: p.updated })));
});
app.get("/blog/admin/api/post/:slug", requireAuth, (req, res) => {
  const p = getPost(req.params.slug);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});
app.post("/blog/admin/api/preview", requireAuth, (req, res) => {
  res.json({ html: renderMarkdown(req.body && req.body.body) });
});
app.post("/blog/admin/api/save", requireAuth, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();
  if (!title) return res.status(400).json({ error: "title required" });
  const now = new Date().toISOString();
  const orig = b.origSlug ? getPost(b.origSlug) : null;
  const slug = uniqueSlug(b.slug || title, orig ? orig.slug : null);
  const status = b.status === "published" ? "published" : "draft";
  const post = {
    slug, title,
    subtitle: String(b.subtitle || "").trim(),
    cover: String(b.cover || "").trim(),
    tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
      : String(b.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
    body: String(b.body || ""),
    status,
    created: orig ? orig.created : now,
    updated: now,
    published: status === "published" ? (orig && orig.published ? orig.published : now) : (orig ? orig.published : null),
  };
  // rename: remove old file if slug changed
  if (orig && orig.slug !== slug) deletePost(orig.slug);
  savePost(post);
  res.json({ ok: true, slug });
});
app.post("/blog/admin/api/delete", requireAuth, (req, res) => {
  const slug = req.body && req.body.slug;
  if (!slug || !getPost(slug)) return res.status(404).json({ error: "not found" });
  deletePost(slug);
  res.json({ ok: true });
});

// Image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" })[file.mimetype] || "";
    cb(null, Date.now().toString(36) + "-" + crypto.randomBytes(5).toString("hex") + ext);
  },
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.mimetype)),
});
app.post("/blog/admin/api/upload", requireAuth, (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "not an image (png/jpg/webp/gif/svg)" });
    res.json({ url: "/blog-media/" + req.file.filename });
  });
});

// Fallback media serving (nginx normally serves /blog-media/ directly).
app.use("/blog-media", express.static(MEDIA_DIR, { maxAge: "7d", immutable: true }));

// Public: a post (keep LAST so it doesn't shadow /blog/admin, /blog/feed.xml)
app.get("/blog/:slug", (req, res) => {
  const p = getPost(req.params.slug);
  const visible = p && (p.status === "published" || isAuthed(req));
  if (!visible) {
    return res.status(404).type("html").send(shell({
      title: "Not found · ZKas blog",
      bodyHtml: `<div class="empty">Post not found. <a href="/blogs" style="color:var(--mint)">Back to the blog</a></div>`,
    }));
  }
  const body = `<article class="article">
    <a class="back" href="/blogs">← Blog</a>
    ${p.status !== "published" ? `<div class="tag" style="margin:10px 0">Draft preview</div>` : ""}
    ${p.cover ? `<img class="cover" src="${esc(p.cover)}" alt="${esc(p.title)}">` : ""}
    <div class="meta" style="margin-top:14px"><span>${esc(fmtDate(p.published || p.created))}</span></div>
    <h1>${esc(p.title)}</h1>
    ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ""}
    ${(p.tags && p.tags.length) ? `<div class="tags" style="margin:6px 0 4px">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    <hr style="border:0;border-top:1px solid var(--line);margin:18px 0 26px">
    <div class="body-md">${renderMarkdown(p.body)}</div>
  </article>`;
  res.type("html").set("Cache-Control", p.status === "published" ? "public, max-age=120" : "no-store").send(shell({
    title: `${p.title} · ZKas blog`,
    desc: p.subtitle || excerpt(p.body),
    canonical: SITE + "/blog/" + p.slug,
    cover: p.cover || "",
    bodyHtml: body,
  }));
});

app.get("/blog", (req, res) => res.redirect(301, "/blogs"));

app.listen(PORT, "127.0.0.1", () => console.log(`[zkas-blog] listening on 127.0.0.1:${PORT}`));
