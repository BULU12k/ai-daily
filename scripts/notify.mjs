#!/usr/bin/env node
/**
 * ntfy.sh 推送（海报驱动）：
 * - 优先把 data/outbox.json 中 pages 描述的海报 PNG 以"图片附件"形式推送，
 *   每页一条消息（最多 max_pages 条），手机端免点开直接看图；
 * - 海报文件缺失时降级为一条纯文本消息（标题 + 摘要 + 链接）；
 * - 无新条目（pages 为空且无 items）时不发送任何消息，仅日志留痕，避免刷屏。
 *
 * 使用 ntfy 原生附件上传：PUT 二进制正文 + Filename/Title/Message/Tags 头。
 * 成功判定：HTTP 200/202，响应 JSON 含消息 id。任一条失败以非零码退出。
 * 主题名可被环境变量 NTFY_TOPIC 覆盖（secret 或仓库变量皆可），默认取 config/site.json。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'site.json'), 'utf8'));

const server = (process.env.NTFY_SERVER || CONFIG.ntfy_server || 'https://ntfy.sh').replace(/\/+$/, '');
const topic = process.env.NTFY_TOPIC || CONFIG.ntfy_topic;
const outboxPath = path.join(ROOT, 'data', 'outbox.json');

const outbox = JSON.parse(await fs.readFile(outboxPath, 'utf8'));
if (outbox.pushed) {
  console.log('[notify] outbox 已标记为已推送，跳过。');
  process.exit(0);
}

if (!topic || !/^ai-daily-[0-9a-z]{6,16}$/.test(topic)) {
  console.error(`[notify] 主题名非法: "${topic}"`);
  process.exit(1);
}

// 双保险：清除任何可能残留的孤立代理项（ntfy 解析遇非法 UTF-8 会返回 400）
const scrub = (s) =>
  String(s ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );

const headline = scrub(outbox.headline || `AI日报 ${outbox.date ?? ''}`);
let ok = 0;
let fail = 0;

/** 发送一条消息并记录响应 id；body 为 Buffer 时即图片附件（PUT）。
 *  标题/正文/文件名经 URL 查询参数传递（UTF-8 安全）：
 *  Node 的 undici 禁止非 ASCII HTTP 头（ByteString 限制），而 ntfy 官方支持
 *  ?title=&message=&filename=&tags= 查询参数发布，效果与请求头等价。 */
async function send({ title, message, filename, body, contentType }) {
  const q = new URLSearchParams();
  q.set('title', scrub(title));
  q.set('tags', 'newspaper');
  if (message != null) q.set('message', scrub(message));
  if (filename) q.set('filename', filename);
  const res = await fetch(`${server}/${encodeURIComponent(topic)}?${q.toString()}`, {
    method: 'PUT',
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    body: body ?? '',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => '');
  if (res.status === 200 || res.status === 202) {
    let id = '';
    try {
      id = JSON.parse(text)?.id ?? '';
    } catch {
      /* 非代理响应，忽略 */
    }
    ok++;
    console.log(`[notify] OK ${res.status} id=${id || '(无)'} <- ${title}`);
  } else {
    fail++;
    console.error(`[notify] FAIL ${res.status} <- ${title}: ${text.slice(0, 160)}`);
  }
}

// 组装待发送页面：海报文件存在者用附件；全部缺失但有条目则降级为一条纯文本
const pages = [];
for (const p of outbox.pages ?? []) {
  const file = path.join(ROOT, p.file);
  try {
    const png = await fs.readFile(file);
    pages.push({ index: p.index, total: p.total, png, filename: path.basename(p.file) });
  } catch {
    console.warn(`[notify] 海报文件缺失，跳过附件: ${p.file}`);
  }
}

if (pages.length === 0) {
  if ((outbox.items ?? []).length === 0) {
    console.log('[notify] 本期无新条目，不推送任何消息（日志留痕）。');
    await fs.writeFile(outboxPath, JSON.stringify({ ...outbox, pushed: true }, null, 2), 'utf8');
    process.exit(0);
  }
  // 降级：纯文本一条（标题 + 要点 + 首条摘要链接），杜绝逐条刷屏
  const it = outbox.items[0];
  const points = (outbox.points ?? []).map((p) => `· ${p}`).join('\n');
  const message = [points, '', `${it.title_zh}`, take1(it.summary), it.link]
    .filter((x) => x != null && x !== '')
    .join('\n');
  console.log('[notify] 海报缺失，降级为纯文本推送 1 条。');
  await send({ title: headline, message });
} else {
  for (const p of pages) {
    const title =
      pages.length > 1 ? `${headline}（${p.index}/${p.total}）` : headline;
    // 消息正文：第 1 页附新闻要点，便于通知列表直接阅读；第 2 页仅页码说明
    const message =
      p.index === 1 && (outbox.points ?? []).length > 0
        ? outbox.points.map((x) => `· ${x}`).join('\n')
        : `海报第 ${p.index}/${p.total} 页`;
    try {
      await send({
        title,
        message,
        filename: p.filename,
        body: p.png,
        contentType: 'image/png',
      });
    } catch (err) {
      fail++;
      console.error(`[notify] ERROR <- ${title}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // 温和限速
  }
}

console.log(`[notify] 推送完成：成功 ${ok} 条，失败 ${fail} 条（主题 ${topic}）`);
if (fail > 0) process.exit(2);

// 全部成功才标记已推送
await fs.writeFile(outboxPath, JSON.stringify({ ...outbox, pushed: true }, null, 2), 'utf8');

function take1(s) {
  const m = String(s ?? '').match(/^[\s\S]*?[。！？!?]/);
  return m ? m[0] : String(s ?? '');
}
