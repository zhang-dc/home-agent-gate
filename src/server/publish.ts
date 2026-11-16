/**
 * Publish server — turns agent-written files into web pages.
 *
 * Anything an agent writes into a configured root is immediately a URL.
 * Markdown is rendered on request, so agents keep writing .md and you get a
 * phone-readable page for free; .html files are served as authored, for when
 * the agent wants charts. Chat apps that only show plain text get a short
 * summary plus a link instead of a collapsed wall of tables.
 *
 * Two audiences:
 *  - direct requests (loopback, or whatever exact address you bind) see the
 *    whole tree of every root;
 *  - requests that came through a reverse proxy (X-Real-IP / X-Forwarded-For
 *    present) only see <root>/<publicDirs>/** (and <root>/<linkOnlyDirs>/<file>
 *    by exact URL); everything else answers 404 as if it did not exist.
 *
 * THERE IS NO AUTHENTICATION. Whatever is reachable through the proxy is
 * public. Bind exact addresses only: on 0.0.0.0 the whole LAN counts as "direct".
 */

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { marked } from "marked";

import { createLogger } from "../util/logger.js";

const log = createLogger("publish");

export interface PublishOptions {
  port: number;
  binds: string[];
  /** Public base URL, used only to print links in logs and on the index page. */
  baseUrl: string;
  /** Title of the index pages. */
  title?: string;
  /** Short name -> absolute directory. The short name is the first path segment. */
  roots: Record<string, string>;
  /** First-level subdirectories of each root that the public internet may read. */
  publicDirs?: string[];
  /**
   * First-level subdirectories the internet may read by exact file URL only — no
   * directory listing, not on the public index. For links pushed to chats whose
   * archives should not be browsable by strangers.
   */
  linkOnlyDirs?: string[];
}

/**
 * A reverse proxy (nginx etc.) sets X-Real-IP / X-Forwarded-For on the way in,
 * and a direct client on loopback / your private interface has no reason to — so their presence means
 * "from the internet". Failing closed: a header we didn't expect only hides more.
 */
const isExternal = (req: Request): boolean =>
  req.headers.has("x-real-ip") || req.headers.has("x-forwarded-for");

/** Inside <root>/<dir> after resolving symlinks — a link must not tunnel out. */
function underPublic(rootDir: string, dir: string, abs: string): boolean {
  try {
    const pub = fs.realpathSync(path.join(rootDir, dir));
    const real = fs.realpathSync(abs);
    return real === pub || real.startsWith(pub + path.sep);
  } catch {
    return false;
  }
}

/** Directory entries are capped so a data dump with 10k files still renders. */
const MAX_ENTRIES = 500;
/** Rendered inline rather than offered as a download. */
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".log", ".json", ".csv", ".yml", ".yaml"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/**
 * Markdown may carry text the agent pulled from the internet (forum posts,
 * research feeds), so rendered pages get no script privileges at all. Pages the
 * agent authored as .html are a different case — see HTML_CSP.
 */
const DOC_CSP = "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
/** Agent-authored HTML is deliberate, and self-contained chart pages need inline script/style. */
const HTML_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; font-src * data:; base-uri 'none'";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Resolve a URL path inside a root, refusing anything that escapes it.
 * Returns null for traversal attempts and dotfiles.
 */
function safeJoin(rootDir: string, rel: string): string | null {
  const decoded = rel.split("/").filter((seg) => seg && seg !== ".");
  if (decoded.some((seg) => seg === ".." || seg.startsWith("."))) return null;
  const abs = path.resolve(rootDir, ...decoded);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) return null;
  return abs;
}

function page(title: string, body: string, csp: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Render markdown, adding anchor ids to h2/h3 and collecting a table of
 * contents — the daily archives run to hundreds of KB and are unnavigable flat.
 *
 * Ids are added by rewriting the output rather than through a custom renderer:
 * marked's renderer API has changed shape across majors, the output shape has not.
 */
function renderMarkdown(md: string): { html: string; toc: string } {
  // Belt and braces with the CSP: markdown can carry text the agent scraped, so
  // drop script/iframe/object outright instead of trusting one header.
  const safe = md.replace(/<\/?(script|iframe|object|embed|form)\b[^>]*>/gi, "");
  let html = marked.parse(safe, { gfm: true, breaks: false, async: false }) as string;

  const toc: string[] = [];
  const seen = new Map<string, number>();
  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, depth: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const base = text.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "") || `h${depth}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    toc.push(`<li class="d${depth}"><a href="#${esc(id)}">${esc(text)}</a></li>`);
    return `<h${depth} id="${esc(id)}">${inner}</h${depth}>`;
  });
  return { html, toc: toc.join("") };
}

function breadcrumb(root: string | null, rel: string): string {
  const parts: string[] = [`<a href="/">全部</a>`];
  if (root) {
    parts.push(`<a href="/${encodeURIComponent(root)}/">${esc(root)}</a>`);
    const segs = rel.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < segs.length; i++) {
      acc += `/${encodeURIComponent(segs[i]!)}`;
      const last = i === segs.length - 1;
      parts.push(last ? `<span>${esc(segs[i]!)}</span>` : `<a href="/${encodeURIComponent(root)}${acc}/">${esc(segs[i]!)}</a>`);
    }
  }
  return `<nav class="crumb">${parts.join('<i>/</i>')}</nav>`;
}

export function startPublish(opts: PublishOptions): Promise<void> {
  const app = new Hono();
  const publicDirs = opts.publicDirs ?? ["public"];
  const linkOnlyDirs = opts.linkOnlyDirs ?? [];
  const title = opts.title ?? "Home Agent Gate";
  const roots = new Map<string, string>();
  for (const [name, dir] of Object.entries(opts.roots)) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) {
      log.warn(`root "${name}" -> ${abs} does not exist, skipping`);
      continue;
    }
    roots.set(name, abs);
  }

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/*", (c) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("bad path", 400);
    }
    const segs = urlPath.split("/").filter(Boolean);
    const external = isExternal(c.req.raw);
    const notFound = (): Response =>
      page("找不到", `${breadcrumb(null, "")}<h1>文件不存在</h1>`, DOC_CSP, 404);

    // ---- internet: only <root>/<publicDirs>/** exists ----
    if (external && segs.length === 0) {
      const cards = [...roots.entries()]
        .flatMap(([name, dir]) => publicDirs.filter((d) => fs.existsSync(path.join(dir, d))).map((d) => [name, d] as const))
        .map(([name, d]) => `<a class="card" href="/${encodeURIComponent(name)}/${encodeURIComponent(d)}/"><b>${esc(name)}/${esc(d)}</b></a>`)
        .join("");
      return page(title, `<header><h1>${esc(title)}</h1></header><div class="cards">${cards || '<p class="dim">暂无公开文章。</p>'}</div>`, DOC_CSP);
    }
    if (external && segs.length === 1 && roots.has(segs[0]!)) {
      return c.redirect("/", 302);
    }
    const linkOnly = external && linkOnlyDirs.includes(segs[1]!);
    if (external && !publicDirs.includes(segs[1]!) && !linkOnly) return notFound();

    // ---- index of roots ----
    if (segs.length === 0) {
      const cards = [...roots.entries()]
        .map(([name, dir]) => {
          let recent = "";
          try {
            const newest = fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isFile())
              .map((e) => ({ name: e.name, m: fs.statSync(path.join(dir, e.name)).mtimeMs }))
              .sort((a, b) => b.m - a.m)[0];
            if (newest) recent = `最近：${esc(newest.name)} · ${fmtTime(newest.m)}`;
          } catch { /* unreadable root still gets a card */ }
          return `<a class="card" href="/${encodeURIComponent(name)}/"><b>${esc(name)}</b><span class="dim mono">${esc(dir)}</span><span class="dim">${recent}</span></a>`;
        })
        .join("");
      return page(
        title,
        `<header><h1>${esc(title)}</h1><p class="dim">agent 写进工作区的报告，这里直接看。Markdown 现渲染成 HTML。</p></header>
         <div class="cards">${cards || '<p class="dim">还没有配置任何目录。</p>'}</div>`,
        DOC_CSP,
      );
    }

    const rootName = segs[0]!;
    const rootDir = roots.get(rootName);
    if (!rootDir) return external ? notFound() : page("找不到", `${breadcrumb(null, "")}<h1>没有这个目录</h1><p class="dim">「${esc(rootName)}」不在已发布的目录里。</p>`, DOC_CSP);

    const rel = segs.slice(1).join("/");
    let abs = safeJoin(rootDir, rel);
    if (!abs) return c.text("forbidden", 403);

    // Extension-optional URLs: /notes/weekly-report finds weekly-report.md.
    if (!fs.existsSync(abs) && !path.extname(abs)) {
      for (const ext of [".md", ".html", ".txt"]) {
        if (fs.existsSync(abs + ext)) { abs += ext; break; }
      }
    }

    if (external && !underPublic(rootDir, segs[1]!, abs)) return notFound();

    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return page("找不到", `${breadcrumb(rootName, rel)}<h1>文件不存在</h1><p class="dim mono">${esc(rel || "/")}</p>`, DOC_CSP);
    }

    // ---- directory listing ----
    if (st.isDirectory()) {
      if (linkOnly) return notFound();
      let entries: { name: string; dir: boolean; size: number; m: number }[];
      try {
        entries = fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => {
            let size = 0, m = 0;
            try { const s = fs.statSync(path.join(abs, e.name)); size = s.size; m = s.mtimeMs; } catch { /* vanished mid-listing */ }
            return { name: e.name, dir: e.isDirectory(), size, m };
          });
      } catch {
        return c.text("unreadable directory", 500);
      }
      // Newest first — these directories are append-only report archives, so the
      // thing you want is almost always the thing written last.
      entries.sort((a, b) => (a.dir === b.dir ? b.m - a.m : a.dir ? -1 : 1));
      const shown = entries.slice(0, MAX_ENTRIES);
      const base = `/${encodeURIComponent(rootName)}${rel ? "/" + rel.split("/").map(encodeURIComponent).join("/") : ""}`;
      const rows = shown
        .map((e) => {
          const href = `${base}/${encodeURIComponent(e.name)}${e.dir ? "/" : ""}`;
          const kind = e.dir ? "📁" : /\.(md|markdown)$/i.test(e.name) ? "📄" : /\.html?$/i.test(e.name) ? "🌐" : "•";
          return `<tr><td>${kind} <a href="${href}">${esc(e.name)}</a></td><td class="dim num">${e.dir ? "" : fmtSize(e.size)}</td><td class="dim num">${e.m ? fmtTime(e.m) : ""}</td></tr>`;
        })
        .join("");
      const more = entries.length > shown.length ? `<p class="dim">共 ${entries.length} 项，只列出最近 ${MAX_ENTRIES} 项。</p>` : "";
      return page(
        `${rootName}/${rel}`,
        `${breadcrumb(rootName, rel)}<table class="list">${rows || '<tr><td class="dim">空目录</td></tr>'}</table>${more}`,
        DOC_CSP,
      );
    }

    const ext = path.extname(abs).toLowerCase();
    const raw = new URL(c.req.url).searchParams.has("raw");

    // ---- agent-authored HTML: serve as written ----
    if ((ext === ".html" || ext === ".htm") && !raw) {
      return new Response(fs.readFileSync(abs), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": HTML_CSP,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // ---- markdown -> HTML ----
    if ((ext === ".md" || ext === ".markdown") && !raw) {
      const md = fs.readFileSync(abs, "utf-8");
      const { html, toc } = renderMarkdown(md);
      const tocBlock = toc
        ? `<details class="toc"${md.length > 40000 ? "" : " open"}><summary>目录</summary><ul>${toc}</ul></details>`
        : "";
      const name = path.basename(abs);
      return page(
        name,
        `${breadcrumb(rootName, rel)}
         <header><h1>${esc(name.replace(/\.(md|markdown)$/i, ""))}</h1>
         <p class="dim">${fmtTime(st.mtimeMs)} · ${fmtSize(st.size)} · <a href="?raw=1">原始 Markdown</a></p></header>
         ${tocBlock}<article>${html}</article>`,
        DOC_CSP,
      );
    }

    // ---- everything else: raw bytes ----
    const inline = raw || TEXT_EXT.has(ext) || ext.startsWith(".") === false;
    return new Response(fs.readFileSync(abs), {
      headers: {
        "content-type": raw && TEXT_EXT.has(ext) ? "text/plain; charset=utf-8" : (MIME[ext] ?? "application/octet-stream"),
        "content-disposition": inline || MIME[ext] ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  });

  const started: Promise<void>[] = opts.binds.map(
    (bind) =>
      new Promise<void>((resolve) => {
        const server = serve({ fetch: app.fetch, port: opts.port, hostname: bind }, () => {
          log.info(`publish listening on http://${bind}:${opts.port}`);
          resolve();
        });
        // A bind that fails must not take the gateway down — e.g. a VPN
        // interface address is absent while the tunnel is down at boot.
        server.on("error", (err) => {
          log.warn(`publish could not bind ${bind}:${opts.port} — ${String(err)}`);
          resolve();
        });
      }),
  );

  return Promise.all(started).then(() => {
    log.info(`publish roots: ${[...roots.keys()].map((n) => `${opts.baseUrl}/${n}/`).join(" ")}`);
  });
}

const STYLE = `
:root { color-scheme: light dark;
  --bg:#fbfbfa; --fg:#1f2328; --dim:#6b737c; --line:#e3e5e8; --card:#fff; --accent:#0b62d0; --code:#f2f3f5; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#14181c; --fg:#dbe4ec; --dim:#8b98a6; --line:#272e35; --card:#1a2027; --accent:#63b3ff; --code:#0f1418; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); padding:18px 16px 64px;
  font:16px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  max-width:860px; margin-inline:auto; word-wrap:break-word; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:22px; line-height:1.4; margin:0 0 6px; }
h2 { font-size:19px; margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
h3 { font-size:17px; margin:24px 0 8px; } h4,h5,h6 { font-size:16px; margin:18px 0 6px; }
p { margin:12px 0; } ul,ol { padding-left:1.4em; } li { margin:4px 0; }
.dim { color:var(--dim); font-size:14px; } .mono { font-family:ui-monospace, Consolas, monospace; font-size:12px; }
.num { text-align:right; white-space:nowrap; }
header { margin-bottom:18px; } header p { margin:2px 0; }
.crumb { font-size:14px; color:var(--dim); margin-bottom:14px; }
.crumb i { margin:0 6px; font-style:normal; opacity:.5; }
.cards { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); }
.card { display:flex; flex-direction:column; gap:3px; padding:14px 16px; background:var(--card);
  border:1px solid var(--line); border-radius:12px; }
.card:hover { border-color:var(--accent); text-decoration:none; }
.card b { font-size:17px; }
table { border-collapse:collapse; width:100%; }
table.list td { padding:9px 8px; border-bottom:1px solid var(--line); }
article { overflow-wrap:anywhere; }
article table { display:block; overflow-x:auto; white-space:nowrap; margin:16px 0; font-size:14px; }
article th, article td { border:1px solid var(--line); padding:6px 10px; text-align:left; }
article th { background:var(--code); }
code { background:var(--code); padding:1px 5px; border-radius:4px; font-family:ui-monospace, Consolas, monospace; font-size:14px; }
pre { background:var(--code); padding:12px 14px; border-radius:8px; overflow-x:auto; }
pre code { background:none; padding:0; }
blockquote { margin:14px 0; padding:2px 14px; border-left:3px solid var(--line); color:var(--dim); }
img { max-width:100%; height:auto; }
hr { border:none; border-top:1px solid var(--line); margin:26px 0; }
.toc { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 14px; margin:18px 0; }
.toc summary { cursor:pointer; color:var(--dim); font-size:14px; }
.toc ul { list-style:none; padding-left:0; margin:10px 0 4px; max-height:50vh; overflow-y:auto; }
.toc li.d3 { padding-left:1.2em; font-size:14px; }
`;
