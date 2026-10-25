#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { posterName, validatePng } from './poster-files.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(root, 'config/site.json'), 'utf8'));
const base = String(process.env.PAGES_BASE_URL || config.pages_base_url).replace(/\/+$/, '');
const indexUrl = process.env.POSTER_INDEX_URL || `${base}/poster/index.json`;
const target = path.resolve(process.argv[2] || 'D:\\ntfy\\AI日报海报');
await fs.mkdir(target, { recursive: true });
async function log(message) {
  const line = `[save-posters ${new Date().toISOString()}] ${message}`;
  console.log(line);
  await fs.appendFile(path.join(target, 'save-posters.log'), line + '\n');
}
async function atomic(file, bytes) {
  const temp = `${file}.${process.pid}.tmp`;
  try { await fs.writeFile(temp, bytes); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response;
}
try {
  const index = await (await get(indexUrl)).json();
  if (!Array.isArray(index.posters)) throw new Error('索引缺少 posters 数组');
  const manifestPath = path.join(target, 'saved-manifest.json');
  let manifest = { saved: {} };
  try { const old = JSON.parse(await fs.readFile(manifestPath, 'utf8')); if (old.saved && typeof old.saved === 'object' && !Array.isArray(old.saved)) manifest = old; }
  catch { /* Initial run: actual PNGs remain authoritative. */ }
  let saved = 0, skipped = 0, failed = 0;
  for (const name of new Set(index.posters)) {
    if (typeof name !== 'string' || !posterName.test(name)) { failed++; await log(`非法文件名，拒绝: ${JSON.stringify(name)}`); continue; }
    const dest = path.join(target, name);
    try {
      let existing;
      try { existing = await fs.readFile(dest); validatePng(existing); } catch { existing = null; }
      if (existing) {
        manifest.saved[name] ||= { bytes: existing.length, savedAt: new Date().toISOString() };
        skipped++; continue;
      }
      // A manifest entry never suppresses repair of missing or damaged files.
      const bytes = Buffer.from(await (await get(`${base}/poster/${encodeURIComponent(name)}`)).arrayBuffer());
      validatePng(bytes);
      await atomic(dest, bytes);
      manifest.saved[name] = { bytes: bytes.length, savedAt: new Date().toISOString() };
      saved++; await log(`已保存: ${name} (${bytes.length} bytes)`);
    } catch (err) { failed++; await log(`下载/校验失败 ${name}: ${err.message}`); }
  }
  manifest.updatedAt = new Date().toISOString();
  await atomic(manifestPath, JSON.stringify(manifest, null, 2));
  await log(`完成：索引 ${index.posters.length} 个，新增 ${saved}，跳过 ${skipped}，失败 ${failed}`);
  if (failed) process.exitCode = 2;
} catch (err) { await log(`索引/归档失败: ${err.message}；下周期重试`); process.exitCode = 1; }
