#!/usr/bin/env node
/**
 * 海报本地自动保存（电脑端，索引驱动版）：
 * 由 Windows 计划任务定期运行。海报文件名自 2026-10-25 起带本班时刻
 * （<date>-<HHmm>-pN.png，每班永久独立、无法按日期逐页猜测），故改为：
 *
 *  1. 拉取海报索引（与海报同域发布，不依赖 raw.githubusercontent.com）：
 *     {pages_base_url}/poster/index.json —— fetch-daily 每班维护（追加本班海报
 *     文件名（去重）、裁剪只保留最近 3 天含今天），随仓库提交、由 Pages 发布；
 *     索引 404 或网络失败时日志报错退出（非零码），留待下个周期重试；
 *  2. 对索引中每个文件名，目标目录尚不存在的，从
 *     {pages_base_url}/poster/{filename} 下载保存；
 *  3. saved-manifest.json 幂等：已存在或已登记的文件不重复下载、不覆盖。
 *
 * "最近 3 天"语义由索引自身裁剪保证（脚本不做日期探测，只按索引办事）。
 * 注意：索引与海报同在 GitHub Pages 上，Pages 有 CDN 缓存（约 10 分钟），
 * 最坏情况本轮拿到的索引落后一班，海报晚一班补齐，下轮自动追上。
 *
 * 仍然不经过 git pull：与本地仓库状态完全解耦；Pages 地址永久稳定。
 *
 * 用法：node save-posters.mjs [目标目录]
 * 缺省目标目录：D:\ntfy\AI日报海报
 * 环境变量（仅测试用，缺省走生产默认）：
 *   POSTER_INDEX_URL  覆盖索引地址
 *   PAGES_BASE_URL    覆盖海报下载与索引拉取基址（缺省取 config/site.json 的 pages_base_url）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));

const PAGES_BASE = String(
  process.env.PAGES_BASE_URL || CONFIG.pages_base_url || 'https://bulu12k.github.io/ai-daily',
).replace(/\/+$/, '');
const INDEX_URL = process.env.POSTER_INDEX_URL || `${PAGES_BASE}/poster/index.json`;

const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : 'D:\\ntfy\\AI日报海报';

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

/* ---------------- 1. 拉取海报索引（失败即退出，留待下周期） ---------------- */

let posters = [];
try {
  const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const summary = `拉取索引失败：HTTP ${res.status}（${INDEX_URL}），本轮退出，留待下周期`;
    console.error(`[save-posters] ${summary}`);
    process.exit(1);
  }
  const index = JSON.parse(await res.text());
  if (!Array.isArray(index?.posters)) throw new Error('索引缺少 posters 数组');
  posters = index.posters.filter((n) => typeof n === 'string' && n.endsWith('.png'));
} catch (err) {
  const summary = `拉取/解析索引失败（${err.message}），本轮退出，留待下周期`;
  console.error(`[save-posters] ${summary}`);
  process.exit(1);
}
log(`索引就绪：${posters.length} 个海报文件名（${INDEX_URL}）`);

/* ---------------- 2/3. 按索引下载未保存的海报（manifest 幂等） ---------------- */

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
let missing = 0;
for (const name of posters) {
  const dest = path.join(targetDir, name);
  if (fs.existsSync(dest) || manifest.saved[name]) {
    skipped++; // 已存在或已登记：不重复下载、不覆盖
    continue;
  }
  let res;
  try {
    res = await fetch(`${PAGES_BASE}/poster/${name}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log(`请求失败（网络/超时），跳过: ${name}: ${err.message}`);
    missing++;
    continue;
  }
  if (res.status === 404) {
    // 索引领先于 Pages 部署（刚提交尚未发布）时会出现；最坏延迟一班补齐
    log(`404（Pages 尚未发布或已被清理），跳过: ${name}`);
    missing++;
    continue;
  }
  if (!res.ok) {
    log(`HTTP ${res.status}，跳过: ${name}`);
    missing++;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    log(`空响应，跳过: ${name}`);
    missing++;
    continue;
  }
  await fsp.writeFile(dest, bytes);
  manifest.saved[name] = { bytes: bytes.length, savedAt: new Date().toISOString() };
  saved++;
  log(`已保存: ${name} (${bytes.length} bytes)`);
}

manifest.updatedAt = new Date().toISOString();
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
const summary = `完成：索引 ${posters.length} 个，新增 ${saved} 个，跳过 ${skipped} 个，缺失 ${missing} 个，目标目录 ${targetDir}`;
log(summary);
await appendLog(summary);
