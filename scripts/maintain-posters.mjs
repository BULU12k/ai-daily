import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { posterName, validatePng } from './poster-files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'docs', 'poster');
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const cutoff = (days) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(new Date(`${today}T00:00:00+08:00`).getTime() - (days - 1) * 86400000));
await fs.mkdir(dir, { recursive: true });
const posters = [];
for (const name of await fs.readdir(dir)) {
  if (!posterName.test(name)) continue;
  const date = name.slice(0, 10);
  // Preserve the existing policy: delete only dates strictly older than 7 days.
  if (date < cutoff(8)) { await fs.rm(path.join(dir, name)); continue; }
  if (date < cutoff(3) || date > today) continue;
  try { validatePng(await fs.readFile(path.join(dir, name))); posters.push(name); }
  catch (err) { console.warn(`[poster-index] 排除 ${name}: ${err.message}`); }
}
const target = path.join(dir, 'index.json');
await fs.writeFile(`${target}.tmp`, JSON.stringify({ posters: posters.sort() }, null, 2));
await fs.rename(`${target}.tmp`, target);
// Daily text remains useful when rendering failed or old online PNGs were cleaned.
const daily = path.join(root, 'docs', 'daily');
for (const name of await fs.readdir(daily).catch(() => [])) {
  if (!/^\d{4}-\d{2}-\d{2}\.html$/.test(name)) continue;
  const file = path.join(daily, name);
  const html = await fs.readFile(file, 'utf8');
  const images = [...html.matchAll(/<img class="poster" src="\.\.\/poster\/([^"<>]+)"[^>]*>/g)];
  let updated = html;
  for (const match of images) {
    try {
      if (!posterName.test(match[1])) throw new Error('非法海报名');
      validatePng(await fs.readFile(path.join(dir, match[1])));
    } catch { updated = updated.replace(match[0], ''); }
  }
  if (updated !== html) await fs.writeFile(file, updated);
}
console.log(`[poster-index] 实际 PNG 索引：${posters.length} 个，上海日期 ${today}`);
