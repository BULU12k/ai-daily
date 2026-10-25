#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { posterName, validatePng } from './poster-files.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/site.json'), 'utf8'));
const outboxPath = path.join(ROOT, 'data/outbox.json');
const outbox = JSON.parse(await fs.readFile(outboxPath, 'utf8'));
if (outbox.pushed) { console.log('[notify] 已推送，跳过'); process.exit(0); }
if (!(outbox.items ?? []).length && !(outbox.pages ?? []).length) {
  console.log('[notify] 本期无新条目，不推送');
  await fs.writeFile(outboxPath, JSON.stringify({ ...outbox, pushed: true }, null, 2));
  process.exit(0);
}
const server = String(process.env.NTFY_SERVER || config.ntfy_server || 'https://ntfy.sh').replace(/\/+$/, '');
const topic = process.env.NTFY_TOPIC || config.ntfy_topic;
if (!/^ai-daily-[0-9a-z]{6,16}$/.test(topic)) throw new Error('主题名非法');
const base = String(config.pages_base_url || '').replace(/\/+$/, '');
const dailyLink = base ? `\n\n🔗 日报: ${base}/daily/${encodeURIComponent(outbox.date)}.html` : '';
const scrub = (s) => String(s ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const headline = scrub(outbox.headline || `AI日报 ${outbox.date}`);
let ok = 0, fail = 0;

// ntfy's limits are UTF-8 bytes, not JavaScript UTF-16 code units.
function limitUtf8(value, maxBytes) {
  const text = scrub(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (maxBytes < 3) return '';
  let result = '', used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes - 3) break;
    result += ch; used += size;
  }
  return result + '…';
}

function fallbackText() {
  const prefix = `海报${missing.length ? ` ${missing.map(p => p.index).join('、')} 页` : ''}暂不可用，以下为本班文字版：\n`;
  const footer = `\n\n摘要可能省略，完整内容及原文链接见日报。${dailyLink}`;
  const items = outbox.items ?? [];
  const titles = items.map((it, i) => `${i + 1}. ${limitUtf8(it.title_zh, 512)}`);
  // Reserve all titles and the complete daily URL before allocating summaries.
  const fixedBytes = Buffer.byteLength(prefix + titles.join('\n\n') + footer, 'utf8');
  const summaryBudget = Math.floor((4096 - fixedBytes) / Math.max(1, items.length)) - 1;
  if (summaryBudget < 0) throw new Error('文字版标题与日报链接超过 4096 字节');
  return prefix + titles.map((title, i) => {
    const summary = limitUtf8(items[i].summary, summaryBudget);
    return summary ? `${title}\n${summary}` : title;
  }).join('\n\n') + footer;
}

async function send({ title, message, filename, body }) {
  try {
    const query = new URLSearchParams({ title: limitUtf8(title, 1024), tags: 'newspaper' });
    if (filename) {
      query.set('filename', filename);
      query.set('message', limitUtf8(message, 4096));
    }
    const textBody = scrub(message);
    if (!filename && Buffer.byteLength(textBody, 'utf8') > 4096) throw new Error('文字通知超过 4096 字节');
    const res = await fetch(`${server}/${encodeURIComponent(topic)}?${query}`, {
      method: 'PUT', headers: { 'Content-Type': filename ? 'image/png' : 'text/plain; charset=utf-8' },
      body: filename ? body : textBody, signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let id;
    try { id = JSON.parse(text)?.id; } catch { /* handled below */ }
    if (![200, 202].includes(res.status) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`HTTP ${res.status}，缺少合法消息 id 或响应失败: ${text.slice(0, 160)}`);
    ok++; console.log(`[notify] OK ${res.status} id=${id} <- ${title}`);
  } catch (err) { fail++; console.error(`[notify] FAIL <- ${title}: ${err.message}`); }
}
const available = [], missing = [];
for (const page of outbox.pages ?? []) {
  try {
    const filename = path.basename(page.file);
    if (!posterName.test(filename) || page.file !== `docs/poster/${filename}`) throw new Error('海报路径非法');
    const png = await fs.readFile(path.join(ROOT, page.file));
    validatePng(png);
    available.push({ ...page, filename, png });
  } catch (err) { missing.push(page); console.warn(`[notify] 海报不可用 ${page.file}: ${err.message}`); }
}
for (const page of available) {
  const points = page.index === 1 ? (outbox.points ?? []).map(x => `· ${x}`).join('\n') : `海报第 ${page.index}/${page.total} 页`;
  const link = base ? `\n\n🔗 海报链接（在线保留期内）: ${base}/poster/${page.filename}` : '';
  await send({ title: `${headline}（${page.index}/${page.total}）`,
    message: limitUtf8(points, Math.max(0, 4096 - Buffer.byteLength(link, 'utf8'))) + link,
    filename: page.filename, body: page.png });
}
if (missing.length || !available.length) {
  // Keep every title and the daily URL even when full summaries cannot fit.
  await send({ title: headline, message: fallbackText() });
}
console.log(`[notify] 成功 ${ok}，失败 ${fail}`);
if (fail) process.exitCode = 2;
else await fs.writeFile(outboxPath, JSON.stringify({ ...outbox, pushed: true }, null, 2));
