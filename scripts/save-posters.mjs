#!/usr/bin/env node
/**
 * 海报本地自动保存（电脑端）：
 * 由 Windows 计划任务定期运行，直接从 GitHub Pages 永久地址拉取海报 PNG 落地到
 * 本机目录，作为 ntfy 免费附件链接过期后的永久本地副本。
 *
 * 不经过 git pull：本地仓库常有未提交改动会让 pull 冲突中断（实测 2026-10-25），
 * 而 Pages 地址永久稳定，与本地仓库状态完全解耦。
 *
 * 流程：
 *  1. 以 Asia/Shanghai 今天为基准，取最近 3 天日期（含今天，升序）；
 *  2. 对每天依次请求 {PAGES_BASE}/poster/{date}-p1.png、-p2.png…，
 *     404 即认为当日无更多页；PAGES_BASE 取 config/site.json 的 pages_base_url；
 *  3. 目标目录尚不存在的文件保存进去，写入 saved-manifest.json（幂等，
 *     重复运行不重复下载、不覆盖已有文件）。
 *
 * 用法：node save-posters.mjs [目标目录]
 * 缺省目标目录：D:\ntfy\AI日报海报
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const PAGES_BASE = String(CONFIG.pages_base_url || 'https://bulu12k.github.io/ai-daily').replace(/\/+$/, '');

const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : 'D:\\ntfy\\AI日报海报';

const KEEP_DAYS = 3; // 只补最近 3 天的海报，更早的不补
const MAX_PAGES_PER_DAY = 8; // 安全上限：逐页探测遇 404 即止，防止异常情况下死循环
const FETCH_TIMEOUT_MS = 20_000;

function log(msg) {
  const line = `[save-posters ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  return line;
}

async function appendLog(line) {
  try {
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.appendFile(path.join(targetDir, 'save-posters.log'), line + '\n', 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** Asia/Shanghai 最近 KEEP_DAYS 天日期（含今天，升序），YYYY-MM-DD */
function recentDates() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const out = [];
  for (let i = KEEP_DAYS - 1; i >= 0; i--) {
    out.push(fmt.format(new Date(Date.now() - i * 86400_000)));
  }
  return out;
}

await fsp.mkdir(targetDir, { recursive: true });
const manifestPath = path.join(targetDir, 'saved-manifest.json');
let manifest = { saved: {} };
try {
  manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (!manifest.saved || typeof manifest.saved !== 'object') manifest = { saved: {} };
} catch {
  /* 首次运行无 manifest */
}

let saved = 0;
let skipped = 0;
for (const date of recentDates()) {
  for (let p = 1; p <= MAX_PAGES_PER_DAY; p++) {
    const name = `${date}-p${p}.png`;
    const dest = path.join(targetDir, name);
    if (fs.existsSync(dest) || manifest.saved[name]) {
      skipped++; // 已存在或已登记：不重复下载、不覆盖（仍继续探测更高页码）
      continue;
    }
    let res;
    try {
      res = await fetch(`${PAGES_BASE}/poster/${name}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      log(`请求失败（网络/超时），本日后续页跳过: ${name}: ${err.message}`);
      break;
    }
    if (res.status === 404) break; // 当日没有更多页
    if (!res.ok) {
      log(`HTTP ${res.status}，本日后续页跳过: ${name}`);
      break;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) {
      log(`空响应，本日后续页跳过: ${name}`);
      break;
    }
    await fsp.writeFile(dest, bytes);
    manifest.saved[name] = { bytes: bytes.length, savedAt: new Date().toISOString() };
    saved++;
    log(`已保存: ${name} (${bytes.length} bytes)`);
  }
}

manifest.updatedAt = new Date().toISOString();
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
const summary = `完成：新增 ${saved} 个，跳过 ${skipped} 个，目标目录 ${targetDir}`;
log(summary);
await appendLog(summary);
