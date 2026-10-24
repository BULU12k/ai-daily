#!/usr/bin/env node
/**
 * AI 前沿时讯日报 —— 内容流水线（GitHub Actions 内运行，也可本地运行）
 *
 * 流程：抓取精选 RSS/Atom 源 -> 按 URL/guid 哈希去重（data/seen.json）->
 *       调 LLM 生成中文摘要与玩梗润色（无可用 key 时自动降级为平实摘要）->
 *       生成当日日报页面与全站索引（docs/）-> 写出待推送清单（data/outbox.json）
 *
 * 推送由 scripts/notify.mjs 单独执行，与本脚本解耦。
 * 本脚本不读取、不写入任何密钥文件；密钥一律通过环境变量注入。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const DOCS_DIR = path.join(ROOT, 'docs');
const DAILY_DIR = path.join(DOCS_DIR, 'daily');
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'site.json'), 'utf8'));

/**
 * 精选源（>=5 个）。urls 为候选列表，按顺序尝试，第一个成功者胜出；
 * 全部失败则跳过该源并记日志，不阻塞整条流水线。
 */
const FEEDS = [
  { name: 'OpenAI Blog', urls: ['https://openai.com/news/rss.xml'] },
  {
    name: 'Anthropic News',
    // Anthropic 官网无稳定官方 RSS：先试官方路径，失败再用 RSSHub 公共实例（尽力而为）
    urls: ['https://www.anthropic.com/rss.xml', 'https://rsshub.app/anthropic/news'],
  },
  { name: 'Google DeepMind Blog', urls: ['https://deepmind.google/blog/rss.xml'] },
  { name: 'Meta AI Blog', urls: ['https://ai.meta.com/blog/rss/'] },
  { name: 'Hugging Face Blog', urls: ['https://huggingface.co/blog/feed.xml'] },
  { name: 'TechCrunch AI', urls: ['https://techcrunch.com/category/artificial-intelligence/feed/'] },
  { name: '量子位', urls: ['https://www.qbitai.com/feed'] },
];

const SEEN_TTL_DAYS = 60;
const FETCH_TIMEOUT_MS = 25_000;

const log = (...a) => console.log('[fetch-daily]', ...a);

/** Asia/Shanghai 当日日期，YYYY-MM-DD（日报按此时区分日） */
function shanghaiDate(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
}
function shanghaiTime(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function cleanText(raw) {
  if (!raw) return '';
  return raw
    .replaceAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replaceAll(/<script[\s\S]*?<\/script>/gi, '')
    .replaceAll(/<style[\s\S]*?<\/style>/gi, '')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&apos;', "'")
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    // 清除切片/截断可能产生的孤立代理项（会导致 ntfy JSON 发布返回 400）
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
}

function pick(tag, xml) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

/** 极简 RSS/Atom 解析：title / link / id / date / description */
function parseFeed(xml) {
  const items = [];
  const blocks = xml.includes('<entry')
    ? xml.match(/<entry[\s\S]*?<\/entry>/g) ?? []
    : xml.match(/<item[\s\S]*?<\/item>/g) ?? [];

  for (const b of blocks) {
    const title = cleanText(pick('title', b));
    let link = cleanText(pick('link', b));
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = cleanText(m[1]);
    }
    const id = cleanText(pick('guid', b)) || cleanText(pick('id', b)) || link;
    const dateRaw = pick('pubDate', b) || pick('published', b) || pick('updated', b) || pick('dc:date', b);
    const date = dateRaw ? new Date(cleanText(dateRaw)) : null;
    // 不在解析阶段截断：完整描述保留给句子级处理（摘要按整句边界选取）
    const desc = cleanText(pick('description', b));
    if (title && link) items.push({ title, link, id, date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, desc });
  }
  return items;
}

async function fetchFeed(feed) {
  for (const url of feed.urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'ai-daily-bot/1.0 (personal news digest)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseFeed(xml);
      if (items.length === 0) throw new Error('响应不是可解析的 RSS/Atom');
      log(`源 ${feed.name}: OK (${url}), ${items.length} 条`);
      return items.map((it) => ({ ...it, source: feed.name }));
    } catch (err) {
      log(`源 ${feed.name}: ${url} 失败(${err.message})`);
    }
  }
  log(`源 ${feed.name}: 所有候选地址均失败，本轮跳过`);
  return [];
}

async function loadSeen() {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'seen.json'), 'utf8'));
  } catch {
    return { items: {} };
  }
}

function pruneSeen(seen) {
  const cutoff = Date.now() - SEEN_TTL_DAYS * 86400_000;
  const items = {};
  for (const [hash, iso] of Object.entries(seen.items ?? {})) {
    if (new Date(iso).getTime() >= cutoff) items[hash] = iso;
  }
  return { items };
}

/* ---------------- LLM：优先环境变量里的 key，否则 GitHub Models 免费推理 ---------------- */

function llmConfig() {
  const env = process.env;
  const zai = env.ZAI_API_KEY || env.ZHIPUAI_API_KEY || env.GLM_API_KEY;
  if (zai) {
    return {
      label: 'zhipu',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: env.LLM_MODEL || 'glm-4-flash',
      key: zai,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      label: 'openai',
      // 支持 OpenAI 兼容接口（如 DeepSeek：OPENAI_BASE_URL=https://api.deepseek.com/v1/chat/completions）
      url: env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
      model: env.LLM_MODEL || (env.OPENAI_BASE_URL ? 'deepseek-chat' : 'gpt-4o-mini'),
      key: env.OPENAI_API_KEY,
    };
  }
  if (env.GITHUB_TOKEN) {
    return {
      label: 'github-models',
      url: 'https://models.github.ai/inference/chat/completions',
      model: env.LLM_MODEL || 'openai/gpt-4o-mini',
      key: env.GITHUB_TOKEN,
    };
  }
  return null;
}

const SYSTEM_PROMPT = `你是"AI前沿时讯日报"的中文编辑。你的任务是把英文/中文的 AI 新闻原始信息改写成简洁日报条目。

对每一条输入（带索引 i），输出：
1. title_zh：中文标题，不超过 20 字，不夸大；
2. summary：中文摘要，严格不超过 3 句话，回答"发生了什么、为什么重要"；
3. signal：一句话"信号解读"，严格不超过 20 个汉字（标点计入），点出这条新闻背后的产业信号或值得注意的趋势，必须具体、可感知，禁止空话套话（如"值得关注""意义重大"单独成句属于空话）；
4. point：一句"新闻要点"，不超过 28 字，用于日报海报底部要点条，必须包含该新闻最关键的事实或数字；
5. 可玩梗，但梗必须紧跟近一年的流行趋势；对拿不准时效性的梗，一律降级为平实表达；
6. 禁止使用陈年旧梗（如 yyds、666、绝绝子、awsl 等早已过时的表达）；
7. 禁止编造输入中不存在的事实；信息不足时只写已给内容。

中文输出是硬约束：title_zh、summary、signal、point 必须全部为中文（专有名词与数字保留原文）。
只输出 JSON 数组，形如 [{"i":0,"title_zh":"...","summary":"...","signal":"...","point":"..."}]，不要输出任何其他文字或代码围栏。`;

async function llmSummarize(items, cfg) {
  const payload = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(
          items.map((it, i) => ({
            i,
            source: it.source,
            title: it.title,
            // 送入 LLM 的描述同样按整句裁剪，控制 payload 且保证输出可整句组织
            desc: takeSentences(it.desc || '', 3),
            published: it.date || '',
          })),
        ),
      },
    ],
    temperature: 0.4,
  };

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('LLM 输出中未找到 JSON 数组');
  const arr = JSON.parse(text.slice(start, end + 1));
  const map = new Map();
  for (const e of arr) {
    if (typeof e?.i === 'number' && e.title_zh && e.summary) {
      const signal = e.signal ? String(e.signal).trim() : '';
      const point = e.point ? String(e.point).trim() : '';
      map.set(e.i, {
        title_zh: truncateTitle(String(e.title_zh), 60),
        // LLM 输出同样做整句边界处理与中文校验，杜绝英文/断句泄漏
        summary: takeSentences(String(e.summary), 3),
        // 信号解读限 22 字（含标点），要点限 30 字，超限按词/字边界截断
        signal: signal ? truncateTitle(signal, 22) : '',
        point: point ? truncateTitle(point, 30) : '',
        by_llm: true,
      });
    }
  }
  for (const [k, v] of map) {
    if (!isMostlyChinese(v.title_zh) || !isMostlyChinese(v.summary)) {
      log(`LLM 第 ${k} 条输出非中文，转降级处理`);
      map.delete(k);
    }
  }
  log(`LLM(${cfg.label}/${cfg.model}) 润色成功：${map.size}/${items.length} 条`);
  return map;
}

/* ---------------- 中文输出工具（截断规则：标题按边界、摘要按整句） ---------------- */

const CJK_RE = /[\u4e00-\u9fff]/;

/** 中文字符占比是否达到"可视为中文输出"的程度 */
function isMostlyChinese(s) {
  const compact = String(s ?? '').replace(/\s/g, '');
  if (!compact) return false;
  const cjk = (compact.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk / compact.length >= 0.3;
}

/** 按句末标点切分整句（。！？!? 或英文句点+空白）；无任何句末标点时整段视为一句 */
function splitSentences(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    cur += c;
    const next = s[i + 1] ?? '';
    const isCnEnd = '。！？!?'.includes(c);
    const isEnEnd = c === '.' && /\s/.test(next);
    if (isCnEnd || isEnEnd) {
      parts.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

/**
 * 取完整句子（默认 ≤3 句，总量软上限 maxLen 只用于整句取舍，绝不句中截断）。
 * 单句超长时整句保留——摘要长度让位于"禁止句中截断"的硬规则。
 */
function takeSentences(text, maxCount = 3, maxLen = 260) {
  const sents = splitSentences(text);
  if (sents.length === 0) return String(text ?? '').trim();
  const out = [];
  let len = 0;
  for (const s of sents) {
    if (out.length >= maxCount) break;
    if (out.length > 0 && len + s.length > maxLen) break;
    out.push(s);
    len += s.length + 1;
  }
  if (out.length === 0) out.push(sents[0]); // 第一句无论多长都整句保留
  return out.join(' ');
}

const TITLE_BREAK_RE = /[\s，。、；：！？,.;:!?\-—()（）"'“”「」』…·|/]+/g;

/**
 * 标题截断：优先保留完整语义；确需限长时在词/标点边界截断并加省略号，
 * 禁止断词。中日韩连续文本无空白词界，按字符单元截断（CJK 每字即一词）。
 */
function truncateTitle(text, max = 60) {
  const t = String(text ?? '').trim();
  const units = [...t];
  if (units.length <= max) return t;
  const cut = units.slice(0, max).join('');
  let last = -1;
  TITLE_BREAK_RE.lastIndex = 0;
  for (const m of cut.matchAll(TITLE_BREAK_RE)) {
    if (m.index > 0 && m.index < cut.length - 1) last = m.index; // 边界位于分隔符前
  }
  if (last > max * 0.5) return cut.slice(0, last).trimEnd() + '…';
  return cut.trimEnd() + '…';
}

/* ---------------- 免费翻译降级链（无密钥；保证降级路径仍输出中文） ---------------- */

const TRANSLATORS = [
  {
    name: 'google-gtx',
    async run(text) {
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
        encodeURIComponent(text);
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const out = (data?.[0] ?? []).map((x) => x?.[0] ?? '').join('');
      if (!out) throw new Error('空结果');
      return out;
    },
  },
  {
    name: 'mymemory',
    async run(text) {
      // MyMemory 免费通道单次 ≤500 字节，且需显式语言对；输入已按整句裁剪，长度可控
      const q = text.length > 480 ? text.slice(0, 480) : text; // 仅影响送翻文本，输出仍整句组织
      const url =
        'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(q);
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const out = data?.responseData?.translatedText ?? '';
      if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('配额或空结果');
      return out;
    },
  },
];

const transCache = new Map();
let translatorFailureLogged = false;

async function translateToZh(text) {
  const key = sha256(text).slice(0, 16);
  if (transCache.has(key)) return transCache.get(key);
  for (const t of TRANSLATORS) {
    try {
      await new Promise((r) => setTimeout(r, 300)); // 免费通道温和限速
      const out = await t.run(text);
      transCache.set(key, out);
      return out;
    } catch (err) {
      if (!translatorFailureLogged) {
        log(`翻译通道 ${t.name} 失败(${err.message})，尝试下一个`);
        translatorFailureLogged = true;
      }
    }
  }
  return null; // 全部翻译通道不可用
}

/** 降级路径：中文源直接整句组织；非中文先经免费翻译；翻译全挂则返回 null（调用方决定丢弃该条） */
async function fallbackEntry(item) {
  const titleText = item.title;
  const descSents = takeSentences(item.desc || '', 3);

  // 无可用描述时直接丢弃本条：宁可少推，也不输出"发布了新内容，详情见原文"这类无信息量文案
  if (!descSents) {
    log(`降级丢弃（无可用描述，避免无信息量文案）: ${truncateTitle(item.title, 40)}`);
    return null;
  }

  let titleZh = isMostlyChinese(titleText) ? titleText : await translateToZh(titleText);
  if (titleZh === null) {
    return null; // 标题无法中文化 → 本条放弃，保证日报全中文
  }
  const descZh = isMostlyChinese(descSents) ? descSents : await translateToZh(descSents);
  if (descZh === null) return null;
  const summary = takeSentences(descZh, 3);
  return {
    title_zh: truncateTitle(titleZh, 60),
    summary,
    // 无 LLM 时信号解读留空为"—"，要点用摘要首句压缩，保持信息量而非套话
    signal: '—',
    point: truncateTitle(takeSentences(summary, 1), 30),
    by_llm: false,
    degraded: true,
  };
}

/* ---------------- 页面生成 ---------------- */

const BASE_CSS = `
:root { --bg:#0f1115; --card:#181b22; --fg:#e8eaed; --sub:#9aa0a6; --accent:#7aa2ff; --line:#2a2f3a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif; }
.wrap { max-width: 820px; margin: 0 auto; padding: 24px 16px 64px; }
header.site h1 { font-size: 26px; margin: 0 0 4px; }
header.site p { margin: 0 0 24px; color: var(--sub); font-size: 14px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { color: var(--sub); font-size: 13px; margin-bottom: 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 14px 0; }
.card h2 { font-size: 18px; margin: 0 0 6px; line-height: 1.5; }
.card p { margin: 6px 0; }
.card .src { font-size: 12px; color: var(--sub); }
.card .src .meme { margin-left: 8px; }
img.poster { display:block; width:100%; height:auto; border:1px solid var(--line); border-radius:12px; margin:16px 0; }
.tag { display:inline-block; background:#232838; color:var(--accent); border-radius:6px; padding:1px 8px; font-size:12px; margin-right:8px; }
ul.dates { list-style:none; padding:0; }
ul.dates li { padding: 10px 0; border-bottom: 1px solid var(--line); }
footer { margin-top: 40px; color: var(--sub); font-size: 13px; }
`;

function siteHeader(cfg) {
  return `<header class="site"><h1>${escapeHtml(cfg.site_name)}</h1><p>${escapeHtml(cfg.site_desc)}</p></header>`;
}

function itemCard(it) {
  const flag = it.by_llm ? '' : '<span class="meme">平实摘要（LLM 未启用，中文整理）</span>';
  return `<div class="card">
  <h2>${escapeHtml(it.title_zh)}</h2>
  <p>${escapeHtml(it.summary)}</p>
  <p class="src"><span class="tag">${escapeHtml(it.source)}</span>${escapeHtml(it.time || '')}<a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">原文链接 ↗</a>${flag}</p>
</div>`;
}

function renderDaily(cfg, dateStr, items) {
  const allDegraded = items.length > 0 && items.every((it) => it.degraded);
  const degradeNote = allDegraded
    ? ' · 本期为降级模式：LLM 不可用，条目经免费翻译/中文源整理，全中文输出'
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(dateStr)} · ${escapeHtml(cfg.site_name)}</title><style>${BASE_CSS}</style></head>
<body><div class="wrap">
${siteHeader(cfg)}
<p class="meta">日报日期 ${escapeHtml(dateStr)}（Asia/Shanghai）· 共 ${items.length} 条${escapeHtml(degradeNote)} · 生成时间 ${escapeHtml(shanghaiTime())}</p>
<img class="poster" src="../poster/${dateStr}-p1.png" alt="当日日报海报" onerror="this.remove()">
${items.map(itemCard).join('\n')}
<footer><a href="../index.html">← 返回往期</a> ｜ 手机推送：订阅 ntfy 主题 <code>${escapeHtml(cfg.ntfy_topic)}</code></footer>
</div></body></html>`;
}

function renderIndex(cfg, days) {
  const latest = days[0];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(cfg.site_name)}</title><style>${BASE_CSS}</style></head>
<body><div class="wrap">
${siteHeader(cfg)}
${latest ? `<h2 style="font-size:20px">最新一期：${escapeHtml(latest.date)}</h2>
${latest.items.map(itemCard).join('\n')}` : '<p>暂无日报，等待第一次运行。</p>'}
<h2 style="font-size:20px;margin-top:36px">往期</h2>
<ul class="dates">
${days.map((d) => `<li><a href="daily/${escapeHtml(d.date)}.html">${escapeHtml(d.date)}</a> · ${d.items.length} 条</li>`).join('\n')}
</ul>
<footer>本站由 GitHub Actions 自动生成 · 推送主题：<code>${escapeHtml(cfg.ntfy_topic)}</code>（ntfy.sh，手机/桌面均可订阅）</footer>
</div></body></html>`;
}

/* ---------------- 主流程 ---------------- */

const today = shanghaiDate();
log(`本期日报日期（Asia/Shanghai）: ${today}`);

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(DAILY_DIR, { recursive: true });

const seen = await loadSeen();
const feedResults = await Promise.all(FEEDS.map(fetchFeed));
const all = feedResults.flat();

// 去重：URL/guid 哈希
const nowIso = new Date().toISOString();
const fresh = [];
const freshIds = new Set();
for (const it of all) {
  const key = it.id || it.link;
  const h = sha256(key);
  it.hash = h;
  if (!seen.items[h] && !freshIds.has(h)) {
    freshIds.add(h);
    fresh.push(it);
  }
}
log(`抓取合计 ${all.length} 条，去重后新增 ${fresh.length} 条`);

// 全部标记为已见（含被时效过滤淘汰的），避免同一旧闻在后续运行反复被处理
for (const it of fresh) seen.items[it.hash] = nowIso;

// 时效红线：必须带可解析发布时间，且距运行时刻 ≤ max_age_hours。
// 无时间戳条目一律不入页、不推送；过期条目同样剔除，杜绝旧闻混入。
const maxAgeMs = Number(CONFIG.max_age_hours ?? 24) * 3600_000;
const nowMs = Date.now();
const inTime = [];
let droppedStale = 0;
let droppedNoTime = 0;
for (const it of fresh) {
  if (!it.date) {
    droppedNoTime++;
    continue;
  }
  if (nowMs - new Date(it.date).getTime() > maxAgeMs) {
    droppedStale++;
    continue;
  }
  inTime.push(it);
}
log(
  `时效过滤（≤ ${maxAgeMs / 3600_000} 小时）：入选 ${inTime.length} 条；` +
    `剔除旧闻 ${droppedStale} 条、无时间戳 ${droppedNoTime} 条`,
);

// 按时间倒序，取每日上限条目进入日报
const picked = [...inTime]
  .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  .slice(0, CONFIG.max_items_per_day);

// LLM 润色（可用则用）；未覆盖或产出非中文的条目一律走"免费翻译→仅中文源"降级链，
// 任何链路都保证日报全中文、摘要整句、单条 ≤3 句。
const cfgLlm = llmConfig();
const enrichedMap = new Map();
if (picked.length && cfgLlm) {
  try {
    const m = await llmSummarize(picked, cfgLlm);
    for (const [k, v] of m) enrichedMap.set(k, v);
  } catch (err) {
    log(`LLM 调用失败，全部条目转入降级链: ${err.message}`);
  }
}

let droppedNonChinese = 0;
let degradedCount = 0;
const items = [];
for (let i = 0; i < picked.length; i++) {
  const it = picked[i];
  const en = enrichedMap.get(i) ?? (await fallbackEntry(it));
  if (!en) {
    droppedNonChinese++;
    log(`条目已丢弃（翻译通道不可用且非中文源）: ${it.source} | ${truncateTitle(it.title, 40)}`);
    continue;
  }
  if (en.degraded) degradedCount++;
  items.push({
    title_zh: en.title_zh,
    summary: en.summary,
    signal: en.signal || '—',
    point: en.point || truncateTitle(takeSentences(en.summary, 1), 30),
    by_llm: !!en.by_llm,
    degraded: !!en.degraded,
    source: it.source,
    link: it.link,
    date: it.date,
    time: it.date ? shanghaiTime(new Date(it.date)) : '',
    date_md: it.date ? shanghaiDate(new Date(it.date)).slice(5) : '', // 月-日，如 10-24
  });
}
if (droppedNonChinese > 0) {
  log(`降级模式：${droppedNonChinese} 条非中文且无法翻译的条目已排除，本期仅保留可中文化条目`);
}

// 合并进当日条目库（data/days.json 持久化，同日多次运行自动追加，按时间倒序）
const dailyFile = path.join(DAILY_DIR, `${today}.html`);
const daysStorePath = path.join(DATA_DIR, 'days.json');
let daysStore = {};
try { daysStore = JSON.parse(await fs.readFile(daysStorePath, 'utf8')); } catch { /* 首次 */ }
const existing = Array.isArray(daysStore[today]) ? daysStore[today] : [];
const seenLinks = new Set(existing.map((i) => i.link));
const merged = [...existing, ...items.filter((i) => !seenLinks.has(i.link))]
  .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
daysStore[today] = merged;
// 保留最近 30 天
const cutoffDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
for (const d of Object.keys(daysStore)) if (d < cutoffDate) delete daysStore[d];
await fs.writeFile(daysStorePath, JSON.stringify(daysStore, null, 1), 'utf8');

if (items.length > 0) {
  await fs.writeFile(dailyFile, renderDaily(CONFIG, today, merged), 'utf8');
  log(`已写当日页面: docs/daily/${today}.html（${items.length} 条新增，共 ${merged.length} 条）`);
} else {
  log('本期无新增条目，页面保持不变');
}

// 重建索引：最新一期带正文卡片，往期仅列日期
const days = Object.entries(daysStore)
  .sort(([a], [b]) => b.localeCompare(a))
  .map(([date, its]) => ({ date, count: its.length, items: date === today ? merged : [] }));
await fs.writeFile(path.join(DOCS_DIR, 'index.html'), renderIndex(CONFIG, days), 'utf8');
log('已重建索引: docs/index.html');

// 持久化去重状态与待推送清单
await fs.writeFile(path.join(DATA_DIR, 'seen.json'), JSON.stringify(seen, null, 1), 'utf8');

// 待推送清单（海报驱动）：
// - pages 描述本次应生成的海报页（由 scripts/render-poster.mjs 渲染为 docs/poster/*.png）；
// - notify.mjs 优先以海报 PNG 附件推送（每页一条消息，最多 max_pages 条）；
//   海报文件缺失时降级为一条纯文本消息；无新条目时 pages 为空、notify 不发送任何消息。
const posterCfg = CONFIG.poster ?? {};
const perPage = Math.max(1, Number(posterCfg.items_per_page ?? 4));
const maxPages = Math.max(1, Number(posterCfg.max_pages ?? 2));
const posterItems = items.slice(0, perPage * maxPages);
const pageCount = posterItems.length > 0 ? Math.min(maxPages, Math.ceil(posterItems.length / perPage)) : 0;
const pages = [];
for (let p = 0; p < pageCount; p++) {
  pages.push({
    index: p + 1,
    total: pageCount,
    file: `docs/poster/${today}-p${p + 1}.png`,
    count: Math.min(perPage, posterItems.length - p * perPage),
  });
}
const outbox = {
  date: today,
  pushed: false,
  headline: `AI日报 ${today.slice(5)} ${shanghaiTime()} · ${items.length}条新知`,
  pages,
  points: items.slice(0, 4).map((it) => it.point).filter(Boolean),
  items: posterItems.map((it) => ({
    title_zh: it.title_zh,
    summary: takeSentences(it.summary, 2),
    signal: it.signal,
    point: it.point,
    source: it.source,
    link: it.link,
    date_md: it.date_md,
  })),
};
await fs.writeFile(
  path.join(DATA_DIR, 'outbox.json'),
  JSON.stringify(outbox, null, 2),
  'utf8',
);
log(`待推送海报 ${pages.length} 页（${posterItems.length} 条）-> data/outbox.json`);
log('完成。');
