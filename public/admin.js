/* ZKas blog admin — vanilla JS. Talks to /blog/admin/api/*. */
(function () {
  "use strict";
  var app = document.getElementById("app");
  var CSRF = { "Content-Type": "application/json", "X-ZB-CSRF": "1" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: method === "GET" ? {} : CSRF,
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { renderLogin(); throw new Error("unauthorized"); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
    });
  }
  function fmt(iso) { try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } }

  // ---------- HTML → Markdown (for rich paste from Word/LibreOffice/Docs/web) ----------
  function inlineMd(node) { var o = ""; node.childNodes.forEach(function (n) { o += nodeMd(n); }); return o; }
  function blockMd(node) { var o = ""; node.childNodes.forEach(function (n) { o += nodeMd(n); }); return o; }
  function listMd(node, ordered) {
    var i = 0, out = [];
    node.childNodes.forEach(function (li) {
      if (li.nodeType === 1 && li.tagName.toLowerCase() === "li") {
        i++;
        var marker = ordered ? (i + ". ") : "- ";
        var parts = "", nested = "";
        li.childNodes.forEach(function (c) {
          if (c.nodeType === 1 && /^(ul|ol)$/.test(c.tagName.toLowerCase())) {
            nested += "\n" + listMd(c, c.tagName.toLowerCase() === "ol").split("\n").map(function (l) { return "  " + l; }).join("\n");
          } else { parts += nodeMd(c); }
        });
        out.push(marker + parts.replace(/\s+/g, " ").trim() + nested);
      }
    });
    return out.join("\n");
  }
  function tableMd(table) {
    var rows = [];
    table.querySelectorAll("tr").forEach(function (tr) {
      var cells = [];
      tr.querySelectorAll("th,td").forEach(function (td) { cells.push(inlineMd(td).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")); });
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return "";
    var out = "| " + rows[0].join(" | ") + " |\n| " + rows[0].map(function () { return "---"; }).join(" | ") + " |\n";
    rows.slice(1).forEach(function (r) { out += "| " + r.join(" | ") + " |\n"; });
    return out + "\n";
  }
  function nodeMd(n) {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, " ");
    if (n.nodeType !== 1) return "";
    var tag = n.tagName.toLowerCase(), inner;
    switch (tag) {
      case "br": return "  \n";
      case "strong": case "b": inner = inlineMd(n).trim(); return inner ? "**" + inner + "**" : "";
      case "em": case "i": inner = inlineMd(n).trim(); return inner ? "*" + inner + "*" : "";
      case "s": case "strike": case "del": inner = inlineMd(n).trim(); return inner ? "~~" + inner + "~~" : "";
      case "code": if (n.closest("pre")) return n.textContent; inner = n.textContent.trim(); return inner ? "`" + inner + "`" : "";
      case "a": inner = inlineMd(n).trim(); var href = n.getAttribute("href") || ""; return href && inner ? "[" + inner + "](" + href + ")" : inner;
      case "img": var alt = n.getAttribute("alt") || "", src = n.getAttribute("src") || ""; return src ? "![" + alt + "](" + src + ")" : "";
      case "u": case "span": case "font": case "sub": case "sup": case "small": case "mark": case "abbr": return inlineMd(n);
      case "p": case "div": case "section": case "article": inner = blockMd(n).trim(); return inner ? inner + "\n\n" : "";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        inner = inlineMd(n).replace(/\s+/g, " ").trim(); return inner ? new Array(+tag[1] + 1).join("#") + " " + inner + "\n\n" : "";
      case "blockquote": inner = blockMd(n).trim(); return inner ? inner.split("\n").map(function (l) { return l ? "> " + l : ">"; }).join("\n") + "\n\n" : "";
      case "ul": return listMd(n, false) + "\n\n";
      case "ol": return listMd(n, true) + "\n\n";
      case "pre": return "```\n" + n.textContent.replace(/\n+$/, "") + "\n```\n\n";
      case "hr": return "\n---\n\n";
      case "table": return tableMd(n);
      case "head": case "style": case "script": case "meta": case "title": return "";
      default: return blockMd(n);
    }
  }
  function htmlToMarkdown(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    ["style", "script", "meta", "title", "head"].forEach(function (t) {
      Array.prototype.forEach.call(doc.querySelectorAll(t), function (e) { e.remove(); });
    });
    var mdtext = blockMd(doc.body || doc.documentElement);
    return mdtext.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------- login ----------
  function renderLogin(err) {
    app.innerHTML =
      '<div class="login"><h1>Admin login</h1>' +
      '<label>Password</label><input id="pw" type="password" autocomplete="current-password" autofocus>' +
      '<div class="msg" id="m" style="margin:10px 0">' + (err ? esc(err) : "") + '</div>' +
      '<button class="btn" id="go" style="width:100%">Sign in</button></div>';
    function submit() {
      var pw = document.getElementById("pw").value;
      document.getElementById("m").textContent = "…";
      api("POST", "/blog/admin/login", { password: pw })
        .then(function () { boot(); })
        .catch(function (e) { document.getElementById("m").textContent = e.message; });
    }
    document.getElementById("go").onclick = submit;
    document.getElementById("pw").addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  // ---------- dashboard ----------
  var posts = [];
  function renderDashboard(activeSlug) {
    var items = posts.map(function (p) {
      return '<div class="pitem' + (p.slug === activeSlug ? " active" : "") + '" data-slug="' + esc(p.slug) + '">' +
        '<span class="t">' + esc(p.title) + '</span>' +
        '<span class="badge ' + (p.status === "published" ? "pub" : "") + '">' + esc(p.status) + "</span>" +
        '<span class="msg" style="font:11px var(--mono);color:var(--faint)">' + fmt(p.updated || p.created) + "</span>" +
        "</div>";
    }).join("");
    app.innerHTML =
      '<div class="bar" style="padding:0 0 16px;max-width:none"><h1 style="font-size:22px;margin:0">Blog admin</h1>' +
      '<div style="display:flex;gap:8px"><a class="btn sec" href="/blogs" target="_blank">View blog ↗</a>' +
      '<button class="btn sec" id="logout">Log out</button></div></div>' +
      '<div class="admin"><div><button class="btn" id="new" style="width:100%;margin-bottom:10px">+ New post</button>' +
      '<div class="plist">' + (items || '<div class="msg" style="padding:10px">No posts yet.</div>') + "</div></div>" +
      '<div id="edwrap"></div></div>';
    document.getElementById("logout").onclick = function () { api("POST", "/blog/admin/logout").then(renderLogin); };
    document.getElementById("new").onclick = function () { renderEditor(null); highlight(null); };
    Array.prototype.forEach.call(document.querySelectorAll(".pitem"), function (el) {
      el.onclick = function () {
        var slug = el.getAttribute("data-slug");
        api("GET", "/blog/admin/api/post/" + encodeURIComponent(slug)).then(function (p) { renderEditor(p); highlight(slug); });
      };
    });
    if (activeSlug === undefined) renderEditor(null);
  }
  function highlight(slug) {
    Array.prototype.forEach.call(document.querySelectorAll(".pitem"), function (el) {
      el.classList.toggle("active", el.getAttribute("data-slug") === slug);
    });
  }

  // ---------- editor ----------
  function renderEditor(p) {
    var e = document.getElementById("edwrap");
    var isNew = !p;
    p = p || { slug: "", title: "", subtitle: "", cover: "", tags: [], body: "", status: "draft" };
    e.innerHTML =
      '<div class="editor">' +
      '<div class="row"><div><label>Title</label><input id="f_title" value="' + esc(p.title) + '"></div>' +
      '<div><label>Slug (URL) — blank = from title</label><input id="f_slug" value="' + esc(p.slug) + '" placeholder="my-post"></div></div>' +
      '<label>Subtitle</label><input id="f_subtitle" value="' + esc(p.subtitle) + '">' +
      '<div class="row"><div><label>Tags (comma-separated)</label><input id="f_tags" value="' + esc((p.tags || []).join(", ")) + '"></div>' +
      '<div><label>Cover image URL</label><div style="display:flex;gap:8px"><input id="f_cover" value="' + esc(p.cover) + '" placeholder="/blog-media/…">' +
      '<button class="btn sec" id="cov_up" type="button">Upload</button></div></div></div>' +
      (p.cover ? '<img class="cov-prev" id="cov_prev" src="' + esc(p.cover) + '">' : '<img class="cov-prev" id="cov_prev" style="display:none">') +
      '<div class="toolbar" id="fmtbar">' +
      '<button class="btn sec" id="ins_b" type="button" title="Bold (Ctrl/Cmd+B)"><b>B</b></button>' +
      '<button class="btn sec" id="ins_i" type="button" title="Italic (Ctrl/Cmd+I)"><i>I</i></button>' +
      '<button class="btn sec" id="ins_strike" type="button" title="Strikethrough"><s>S</s></button>' +
      '<button class="btn sec" id="ins_h2" type="button" title="Heading 2">H2</button>' +
      '<button class="btn sec" id="ins_h3" type="button" title="Heading 3">H3</button>' +
      '<button class="btn sec" id="ins_ul" type="button" title="Bullet list">• List</button>' +
      '<button class="btn sec" id="ins_ol" type="button" title="Numbered list">1. List</button>' +
      '<button class="btn sec" id="ins_quote" type="button" title="Quote">❝ Quote</button>' +
      '<button class="btn sec" id="ins_code" type="button" title="Inline code">&lt;/&gt;</button>' +
      '<button class="btn sec" id="ins_pre" type="button" title="Code block">Code block</button>' +
      '<button class="btn sec" id="ins_hr" type="button" title="Divider">― HR</button>' +
      '<button class="btn sec" id="ins_link" type="button" title="Link">🔗 Link</button>' +
      '<button class="btn sec" id="ins_img" type="button" title="Insert image">🖼 Image</button>' +
      '<span class="msg" id="msg" style="margin-left:auto"></span></div>' +
      '<div class="split"><div><label>Markdown</label><textarea id="f_body" spellcheck="true">' + esc(p.body) + "</textarea></div>" +
      '<div><label>Preview</label><div class="preview body-md" id="prev"></div></div></div>' +
      '<div class="toolbar" style="margin-top:16px">' +
      '<button class="btn" id="save_draft">Save draft</button>' +
      '<button class="btn" id="publish">' + (p.status === "published" ? "Update (published)" : "Publish") + "</button>" +
      (p.status === "published" ? '<button class="btn sec" id="unpublish">Unpublish</button>' : "") +
      (isNew ? "" : '<a class="btn sec" id="view" href="/blog/' + esc(p.slug) + '" target="_blank">View ↗</a>') +
      (isNew ? "" : '<button class="btn danger" id="del" style="margin-left:auto">Delete</button>') +
      "</div></div>";

    var origSlug = isNew ? "" : p.slug;
    var body = document.getElementById("f_body");
    var msg = document.getElementById("msg");
    function setMsg(t) { msg.textContent = t; }

    // live preview (debounced)
    var pt;
    function preview() {
      clearTimeout(pt);
      pt = setTimeout(function () {
        api("POST", "/blog/admin/api/preview", { body: body.value })
          .then(function (r) { document.getElementById("prev").innerHTML = r.html; }).catch(function () {});
      }, 250);
    }
    body.addEventListener("input", preview); preview();

    function insert(before, after) {
      after = after || "";
      var s = body.selectionStart, en = body.selectionEnd, v = body.value;
      var sel = v.slice(s, en);
      body.value = v.slice(0, s) + before + sel + after + v.slice(en);
      body.focus();
      body.selectionStart = s + before.length; body.selectionEnd = s + before.length + sel.length;
      preview();
    }
    // Keep the textarea focused/selected when a toolbar button is pressed —
    // otherwise mousedown moves focus to the button and collapses the selection,
    // so bold/italic/etc. would wrap nothing.
    var fmtbar = document.getElementById("fmtbar");
    if (fmtbar) fmtbar.addEventListener("mousedown", function (ev) { if (ev.target.closest("button")) ev.preventDefault(); });
    function bind(id, before, after) { var el = document.getElementById(id); if (el) el.onclick = function () { insert(before, after); }; }
    bind("ins_b", "**", "**");
    bind("ins_i", "*", "*");
    bind("ins_strike", "~~", "~~");
    bind("ins_h2", "\n## ", "\n");
    bind("ins_h3", "\n### ", "\n");
    bind("ins_ul", "\n- ", "\n");
    bind("ins_ol", "\n1. ", "\n");
    bind("ins_quote", "\n> ", "\n");
    bind("ins_code", "`", "`");
    bind("ins_pre", "\n```\n", "\n```\n");
    bind("ins_hr", "\n\n---\n\n", "");
    bind("ins_link", "[", "](https://)");
    // keyboard shortcuts
    body.addEventListener("keydown", function (ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var k = ev.key.toLowerCase();
      if (k === "b") { ev.preventDefault(); insert("**", "**"); }
      else if (k === "i") { ev.preventDefault(); insert("*", "*"); }
      else if (k === "k") { ev.preventDefault(); insert("[", "](https://)"); }
    });
    // Replace the current selection with raw text (used by rich paste).
    function replaceSel(text) {
      var s = body.selectionStart, en = body.selectionEnd, v = body.value;
      body.value = v.slice(0, s) + text + v.slice(en);
      var pos = s + text.length; body.focus(); body.selectionStart = body.selectionEnd = pos;
      preview();
    }
    // Paste from Word/LibreOffice/Docs/web: convert the clipboard HTML to clean
    // Markdown so bold/italic/headings/lists/links/paragraphs survive.
    body.addEventListener("paste", function (ev) {
      var cd = ev.clipboardData || window.clipboardData; if (!cd) return;
      var html = cd.getData("text/html");
      if (!html || !html.trim()) return; // plain text → let the browser paste normally
      var mdtext = "";
      try { mdtext = htmlToMarkdown(html); } catch (e) { return; }
      if (!mdtext) return;
      ev.preventDefault();
      replaceSel(mdtext);
    });

    function pickImage(cb) {
      var inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
      inp.onchange = function () {
        if (!inp.files[0]) return;
        setMsg("uploading…");
        var fd = new FormData(); fd.append("image", inp.files[0]);
        fetch("/blog/admin/api/upload", { method: "POST", headers: { "X-ZB-CSRF": "1" }, credentials: "same-origin", body: fd })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
          .then(function (j) { setMsg("uploaded"); cb(j.url); })
          .catch(function (err) { setMsg("upload failed: " + err.message); });
      };
      inp.click();
    }
    document.getElementById("ins_img").onclick = function () { pickImage(function (url) { insert("\n![", "](" + url + ")\n"); }); };
    document.getElementById("cov_up").onclick = function () {
      pickImage(function (url) {
        document.getElementById("f_cover").value = url;
        var cp = document.getElementById("cov_prev"); cp.src = url; cp.style.display = "";
      });
    };
    document.getElementById("f_cover").addEventListener("input", function () {
      var cp = document.getElementById("cov_prev"), v = this.value.trim();
      if (v) { cp.src = v; cp.style.display = ""; } else { cp.style.display = "none"; }
    });

    function collect(status) {
      return {
        origSlug: origSlug,
        slug: document.getElementById("f_slug").value.trim(),
        title: document.getElementById("f_title").value.trim(),
        subtitle: document.getElementById("f_subtitle").value.trim(),
        tags: document.getElementById("f_tags").value,
        cover: document.getElementById("f_cover").value.trim(),
        body: body.value,
        status: status,
      };
    }
    function save(status) {
      var d = collect(status);
      if (!d.title) { setMsg("title required"); return; }
      setMsg("saving…");
      api("POST", "/blog/admin/api/save", d).then(function (r) {
        setMsg("saved ✓");
        origSlug = r.slug;
        return api("GET", "/blog/admin/api/posts").then(function (list) {
          posts = list; renderDashboard(r.slug);
          return api("GET", "/blog/admin/api/post/" + encodeURIComponent(r.slug)).then(function (fresh) { renderEditor(fresh); });
        });
      }).catch(function (err) { setMsg("error: " + err.message); });
    }
    document.getElementById("save_draft").onclick = function () { save("draft"); };
    document.getElementById("publish").onclick = function () { save("published"); };
    if (document.getElementById("unpublish")) document.getElementById("unpublish").onclick = function () { save("draft"); };
    if (document.getElementById("del")) document.getElementById("del").onclick = function () {
      if (!confirm("Delete this post permanently?")) return;
      api("POST", "/blog/admin/api/delete", { slug: origSlug }).then(function () {
        return api("GET", "/blog/admin/api/posts").then(function (list) { posts = list; renderDashboard(); });
      }).catch(function (err) { setMsg("error: " + err.message); });
    };
  }

  // ---------- boot ----------
  function boot() {
    api("GET", "/blog/admin/api/posts").then(function (list) { posts = list; renderDashboard(); })
      .catch(function () {/* renderLogin already called on 401 */ });
  }
  api("GET", "/blog/admin/api/session").then(function (s) { if (s.authed) boot(); else renderLogin(); }).catch(function () { renderLogin(); });
})();
