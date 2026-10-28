import fs from 'node:fs/promises';
import path from 'node:path';
import { posterName, validatePng } from './poster-files.mjs';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const galleryCss = `.poster-gallery{margin:24px 0}.poster-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.poster-tile{margin:0;padding:12px;background:var(--card,#181b22);border:1px solid var(--line,#2a2f3a);border-radius:12px}.poster-tile img{display:block;width:100%;height:210px;object-fit:contain;background:#fff;border-radius:6px}.poster-tile figcaption{margin-top:10px;font-size:14px}.poster-tile a{display:block}.poster-empty{color:var(--sub,#9aa0a6)}`;
export async function validPosterFiles(directory) {
  const files = [];
  for (const name of await fs.readdir(directory).catch(() => [])) {
    if (!posterName.test(name)) continue;
    try { validatePng(await fs.readFile(path.join(directory, name))); files.push(name); }
    catch (error) { console.warn(`[poster-gallery] 排除 ${name}: ${error.message}`); }
  }
  return files.sort();
}
export function renderGallery(date, files) {
  const names = files.filter(name => posterName.test(name) && name.startsWith(`${date}-`));
  const groups = new Map();
  for (const name of names) {
    const stamp = name.match(/-(\d{4})-p\d+\.png$/)?.[1];
    const batch = stamp ? `${stamp.slice(0, 2)}:${stamp.slice(2)}` : '早期归档';
    const page = Number(name.match(/-p(\d+)\.png$/)[1]);
    if (!groups.has(batch)) groups.set(batch, []);
    groups.get(batch).push({ name, page });
  }
  const content = [...groups].map(([batch, entries]) => `<section class="poster-batch"><h3>${escape(batch)} 班次</h3><div class="poster-grid">${entries.sort((a,b) => a.page-b.page).map(({name,page}) => `<figure class="poster-tile"><a href="../poster-reader.html?file=${encodeURIComponent(name)}"><img src="../poster/${escape(name)}" loading="lazy" decoding="async" alt="${escape(date)} ${escape(batch)} 第 ${page} 页海报"></a><figcaption>第 ${page} 页 · <a href="../poster-reader.html?file=${encodeURIComponent(name)}">放大阅读</a></figcaption></figure>`).join('')}</div></section>`).join('');
  return `<!-- POSTER-GALLERY:START --><section class="poster-gallery" aria-label="当天全部海报"><h2>当天海报 · ${names.length} 张</h2>${content || '<p class="poster-empty">当前没有保留的海报，以下新闻文字仍可阅读。</p>'}</section><!-- POSTER-GALLERY:END -->`;
}
export function updateDailyGallery(html, date, files) {
  const gallery = renderGallery(date, files);
  let updated = html;
  const block = /<!-- POSTER-GALLERY:START -->[\s\S]*?<!-- POSTER-GALLERY:END -->/;
  if (block.test(updated)) updated = updated.replace(block, () => gallery);
  else {
    // Migrate only our generated legacy poster element; preserve all article text.
    const legacy = /<img class="poster" src="\.\.\/poster\/[^"<>]+"[^>]*>/;
    if (legacy.test(updated)) updated = updated.replace(legacy, () => gallery);
    else updated = updated.replace(/(<p class="meta">[\s\S]*?<\/p>)/, match => `${match}\n${gallery}`);
  }
  const style = `<style id="poster-gallery-style">${galleryCss}</style>`;
  if (/<style id="poster-gallery-style">/.test(updated)) updated = updated.replace(/<style id="poster-gallery-style">[\s\S]*?<\/style>/, () => style);
  else updated = updated.replace('</head>', `${style}</head>`);
  return updated;
}
