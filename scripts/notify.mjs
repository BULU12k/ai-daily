#!/usr/bin/env node
/**
 * ntfy.sh 推送：把 data/outbox.json 中的新条目推送到配置主题。
 * 使用 ntfy JSON 发布格式（UTF-8 中文标题安全）。
 * 成功判定：HTTP 200/202。任一条失败则以非零码退出（workflow 中以 warning 呈现）。
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

let ok = 0;
let fail = 0;
// 双保险：清除任何可能残留的孤立代理项（ntfy JSON 解析遇非法 UTF-8 会返回 400）
const scrub = (s) => String(s ?? '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
for (const it of outbox.items ?? []) {
  const body = {
    topic,
    title: scrub(it.title_zh),
    message: scrub(`${it.summary}\n${it.link}`),
    tags: ['newspaper'],
    // 注意：JSON 发布格式中 priority 只接受数字 1-5；字符串 "default" 会返回 400，故省略
  };
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 200 || res.status === 202) {
      ok++;
      console.log(`[notify] OK ${res.status} <- ${it.title_zh}`);
    } else {
      fail++;
      console.error(`[notify] FAIL ${res.status} <- ${it.title_zh}: ${(await res.text()).slice(0, 120)}`);
    }
  } catch (err) {
    fail++;
    console.error(`[notify] ERROR <- ${it.title_zh}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 400)); // 温和限速，避免触发限流
}

console.log(`[notify] 推送完成：成功 ${ok} 条，失败 ${fail} 条（主题 ${topic}）`);
if (fail > 0) process.exit(2);

// 全部成功才标记已推送
outbox.pushed = true;
await fs.writeFile(outboxPath, JSON.stringify(outbox, null, 2), 'utf8');
