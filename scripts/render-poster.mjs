#!/usr/bin/env node
/**
 * 日报海报渲染：把 data/outbox.json 中的条目渲染为竖屏海报 PNG（docs/poster/）。
 *
 * 版式（用户 2026-10-24 定稿）：
 * - 黑白配色：白底黑字，表格分隔线浅灰；关键名词（产品名/模型名/数字等）紫色强调；
 * - 结构：标题区（站名 + 日期 + 页码）→ 条目表（左列"新闻事件"含来源·日期，右列"信号解读"）→
 *   底部"新闻要点"总结条；不放任何署名/品牌页脚文字；
 * - 纯 Node 渲染：satori（HTML/CSS 子集 -> SVG）+ @resvg/resvg-js（SVG -> PNG），
 *   不引入浏览器级依赖；CJK 字体从本地 .fonts/（或 FONT_DIR）加载，不提交进仓库。
 *
 * 由 .github/workflows/daily.yml 在 fetch-daily 之后调用；也可本地运行：
 *   node scripts/render-poster.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const OUTBOX_PATH = path.join(ROOT, 'data', 'outbox.json');
const FONT_DIR = process.env.FONT_DIR || path.join(ROOT, '.fonts');

const log = (...a) => console.log('[render-poster]', ...a);

const PURPLE = '#7C3AED'; // 关键名词强调色
const INK = '#111111'; // 主文字
const SUB = '#8a8f98'; // 次要信息
const BODY = '#333333'; // 摘要正文
const LINE = '#e8e8ec'; // 浅灰分隔线
const BAR_BG = '#f4f4f7'; // 底部要点条底色

/* ---------------- 字体 ---------------- */

async function loadFont(file) {
  const p = path.join(FONT_DIR, file);
  try {
    return await fs.readFile(p);
  } catch {
    throw new Error(`缺少 CJK 字体文件: ${p}（请先下载 Noto Sans SC，字体不入仓库）`);
  }
}

/* ---------------- 文本度量（估算换行行数，用于确定画布高度） ---------------- */

/** 加权字宽（单位 = 字号）：CJK 全角记 1，空格 0.35，其余（拉丁/数字/标点）0.58 */
function widthUnits(text) {
  let w = 0;
  for (const ch of String(text ?? '')) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) w += 1;
    else if (ch === ' ') w += 0.35;
    else w += 0.58;
  }
  return w;
}

function estLines(text, fontSize, maxWidth) {
  const lines = String(text ?? '').split('\n');
  let n = 0;
  for (const ln of lines) {
    n += Math.max(1, Math.ceil((widthUnits(ln) * fontSize) / maxWidth));
  }
  return Math.max(1, n);
}

/* ---------------- 关键名词高亮：英文词组 / 数字+量词 / 「」引用 ---------------- */

const HL_RE =
  /「[^」]+」|[A-Za-z][A-Za-z0-9+#._'&-]*(?:[-/.@][A-Za-z0-9+#._'&-]+)*|\d[\d.,]*\s*(?:%|％|亿|万|千|百|倍|秒|分钟|小时|天|日|美元|美金|元|GB|TB|MB|KB|Tokens?|参数|条|款|个|位|名|次|轮|家|代|帧|人|字)?/g;

/** 返回 [{t, strong}] 相邻同色段已合并 */
function highlightSegments(text) {
  const s = String(text ?? '');
  const raw = [];
  let last = 0;
  for (const m of s.matchAll(HL_RE)) {
    if (m.index > last) raw.push({ t: s.slice(last, m.index), strong: false });
    const v = m[0];
    const strong = v.startsWith('「') || /\d/.test(v) || /[A-Za-z]{2,}/.test(v);
    raw.push({ t: v, strong });
    last = m.index + v.length;
  }
  if (last < s.length) raw.push({ t: s.slice(last), strong: false });
  const merged = [];
  for (const seg of raw) {
    if (!seg.t) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.strong === seg.strong) prev.t += seg.t;
    else merged.push({ ...seg });
  }
  return merged;
}

/** satori 文本节点：普通文字为字符串，关键名词包紫色 span */
function richText(text, baseStyle) {
  const segs = highlightSegments(text);
  return segs.map((seg) =>
    seg.strong
      ? { type: 'span', props: { style: { color: PURPLE, fontWeight: 700 }, children: seg.t } }
      : seg.t,
  );
}

/* ---------------- 画布高度：内容紧致（估算加裕量渲染 -> 像素实测 -> 二次渲染收尾） ----------------
 * 背景：旧版 Math.max(height, 1100) 强制最小高度，单条时下半张全是白；而近正方形海报
 * 在 ntfy 固定高度容器里按 cover 居中裁切，顶部标题区（站名+日期+分隔线）会被裁掉。
 * 方案：先按估算高度 +600px 裕量渲染（防止估算偏矮裁字），解码 PNG 从底部向上找最后
 * 一行非纯白像素得到内容实际底边，再以"内容底边 + 底部留白"二次渲染，底部不再有空白。
 */

/** 极简 PNG 解码（仅支持 resvg 输出的 8-bit RGB/RGBA 非隔行），返回像素缓冲 */
function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 格式 bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const dst = y > 0 ? out.subarray((y - 1) * stride + stride, y * stride + stride) : out.subarray(0, stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? dst[x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      dst[x] = v;
    }
  }
  return { width, height, pixels: out, stride, ch };
}

/** 从底部向上找最后一行非纯白像素（通道 < 250 视为内容），返回内容底边行号（含） */
function lastContentRow(png) {
  const { width, height, pixels, stride, ch } = png;
  for (let y = height - 1; y >= 0; y--) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width * ch; x += ch) {
      if (row[x] < 250 || row[x + 1] < 250 || row[x + 2] < 250) return y;
    }
  }
  return height - 1;
}

/* ---------------- satori 元素辅助 ---------------- */

const el = (type, style, children, extra = {}) => ({
  type,
  props: { style, children, ...extra },
});

/* ---------------- 版式 ---------------- */

const PAGE = {
  width: Number(CONFIG.poster?.width ?? 1080),
  padX: 48,
  padTop: 52,
  padBottom: 48,
};
PAGE.contentW = PAGE.width - PAGE.padX * 2;
PAGE.leftW = Math.round(PAGE.contentW * 0.635);
PAGE.rightW = PAGE.contentW - PAGE.leftW - 44;
PAGE.itemsPerpage = Math.max(1, Number(CONFIG.poster?.items_per_page ?? 4));

function posterTree(outbox, pageIndex, heightOverride) {
  const per = PAGE.itemsPerpage;
  const items = (outbox.items ?? []).slice((pageIndex - 1) * per, pageIndex * per);
  if (items.length === 0) return null;
  // 海报内条目按时间由早到晚自上而下（date_md 升序；outbox 条目无时刻字段，同日保持原顺序）
  items.sort((a, b) => String(a.date_md ?? '').localeCompare(String(b.date_md ?? '')));

  const dateMd = (outbox.date ?? '').slice(5); // MM-DD
  const leftW = PAGE.leftW;
  const rightW = PAGE.rightW;

  // ---- 高度估算 ----
  let height = PAGE.padTop + PAGE.padBottom;
  // 标题区
  height += 52 * 1.25 + 26 * 1.5 + 24 + 3 + 10;
  // 条目区
  for (const it of items) {
    const titleLines = estLines(it.title_zh, 38, leftW);
    const sumLines = estLines(it.summary, 27, leftW);
    const sigLines = estLines(it.signal || '—', 27, rightW);
    const leftH =
      titleLines * 38 * 1.4 + 16 + sumLines * 27 * 1.6 + 18 + 22 * 1.5;
    const rightH = 20 * 1.4 + 12 + sigLines * 27 * 1.5;
    height += Math.max(leftH, rightH) + 34 + 34 + 1; // 行内上下留白 + 分隔线
  }
  // 底部要点条
  const points = (outbox.points ?? []).slice(0, 4);
  height += 34; // marginTop
  height += 26 * 2; // bar 上下 padding
  height += 25 * 1.4; // "新闻要点" 标签
  for (const p of points) height += 12 + estLines(p, 25, PAGE.contentW - 60) * 25 * 1.55;
  if (points.length === 0) height += 12 + 25 * 1.55;
  // 不再强制最小高度 1100：高度紧贴内容，避免底部大面积留白与近正方形裁切伤标题
  height = heightOverride ? Math.round(heightOverride) : Math.round(height);

  // ---- 元素树 ----
  const itemNodes = [];
  items.forEach((it, idx) => {
    const left = el('div', { display: 'flex', flexDirection: 'column', width: leftW }, [
      el('div', { fontSize: 38, fontWeight: 700, color: INK, lineHeight: 1.4 }, [
        ...richText(it.title_zh),
      ]),
      it.summary
        ? el(
            'div',
            { marginTop: 16, fontSize: 27, color: BODY, lineHeight: 1.6 },
            richText(it.summary),
          )
        : null,
      el(
        'div',
        { marginTop: 18, fontSize: 22, color: SUB },
        `来源：${it.source ?? ''}${it.date_md ? ` · ${it.date_md}` : ''}`,
      ),
    ].filter(Boolean));
    const right = el(
      'div',
      { display: 'flex', flexDirection: 'column', width: rightW, marginLeft: 44 },
      [
        el('div', { fontSize: 20, color: SUB, letterSpacing: 3 }, '信号解读'),
        el(
          'div',
          { marginTop: 12, fontSize: 27, color: INK, fontWeight: 500, lineHeight: 1.5 },
          richText(it.signal || '—'),
        ),
      ],
    );
    itemNodes.push(
      el('div', { display: 'flex', flexDirection: 'row', paddingTop: 34, paddingBottom: 34 }, [
        left,
        right,
      ]),
    );
    if (idx < items.length - 1) {
      itemNodes.push(el('div', { height: 1, backgroundColor: LINE }));
    }
  });

  const pointNodes = points.map((p) =>
    el(
      'div',
      { marginTop: 12, fontSize: 25, color: INK, lineHeight: 1.55 },
      ['· ', ...richText(p)],
    ),
  );
  if (pointNodes.length === 0) {
    pointNodes.push(el('div', { marginTop: 12, fontSize: 25, color: INK }, '· 本期要点整理中'));
  }

  return {
    tree: el(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box', // satori 默认 content-box：不加此项根节点实际宽 = 1080 + 左右 padding，右侧会被画布裁掉
        width: PAGE.width,
        height,
        backgroundColor: '#ffffff',
        paddingTop: PAGE.padTop,
        paddingBottom: PAGE.padBottom,
        paddingLeft: PAGE.padX,
        paddingRight: PAGE.padX,
      },
      [
        // 标题区：站名 + 日期页码
        el(
          'div',
          {
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
          },
          [
            el('div', { fontSize: 52, fontWeight: 700, color: INK }, [
              ...richText(CONFIG.site_name ?? 'AI 前沿时讯日报'),
            ]),
            el(
              'div',
              { fontSize: 26, color: SUB, paddingBottom: 6 },
              `${dateMd} · ${pageIndex}/${outbox.pages?.length ?? 1}`,
            ),
          ],
        ),
        el('div', { height: 3, backgroundColor: INK, marginTop: 24 }),
        // 条目表
        el('div', { display: 'flex', flexDirection: 'column' }, itemNodes),
        // 底部"新闻要点"总结条（无任何署名/品牌页脚）
        el(
          'div',
          {
            marginTop: 34,
            backgroundColor: BAR_BG,
            borderRadius: 20,
            paddingTop: 26,
            paddingBottom: 26,
            paddingLeft: 30,
            paddingRight: 30,
            display: 'flex',
            flexDirection: 'column',
          },
          [
            el('div', { fontSize: 25, fontWeight: 700, color: PURPLE }, '新闻要点'),
            ...pointNodes,
          ],
        ),
      ],
    ),
    height,
  };
}

/* ---------------- 主流程 ---------------- */

const outbox = JSON.parse(await fs.readFile(OUTBOX_PATH, 'utf8'));
const pages = outbox.pages ?? [];
if (pages.length === 0) {
  log('无待渲染海报（本期无新条目），退出。');
  process.exit(0);
}

const [regular, bold] = await Promise.all([
  loadFont('NotoSansSC-Regular.ttf'),
  loadFont('NotoSansSC-Bold.ttf'),
]);
const fonts = [
  { name: 'Noto Sans SC', data: regular, weight: 400, style: 'normal' },
  { name: 'Noto Sans SC', data: bold, weight: 700, style: 'normal' },
];

let ok = 0;
let fail = 0;

async function renderPng(built) {
  const svg = await satori(built.tree, {
    width: PAGE.width,
    height: built.height,
    fonts,
  });
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: PAGE.width },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
}

for (const page of pages) {
  const estimate = posterTree(outbox, page.index);
  if (!estimate) {
    log(`第 ${page.index} 页无条目，跳过`);
    continue;
  }
  try {
    // 第一遍：估算高度 + 裕量，防止估算偏矮把内容裁掉
    let built = posterTree(outbox, page.index, estimate.height + 600);
    let png = await renderPng(built);
    // 第二遍：像素实测内容底边，高度收紧为"内容底边 + 底部留白"
    const measured = lastContentRow(decodePng(png)) + 1;
    if (measured >= built.height - 8) {
      log(`第 ${page.index} 页内容贴近第一遍画布底部（${measured}/${built.height}），保留裕量防裁切`);
    } else {
      built = posterTree(outbox, page.index, measured + PAGE.padBottom);
      png = await renderPng(built);
    }
    const outPath = path.join(ROOT, page.file);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, png);
    ok++;
    log(`已生成 ${page.file}（${PAGE.width}x${built.height}, ${(png.length / 1024).toFixed(0)}KB）`);
  } catch (err) {
    fail++;
    console.error(`[render-poster] 第 ${page.index} 页渲染失败: ${err.message}`);
  }
}

log(`海报渲染完成：成功 ${ok} 页，失败 ${fail} 页`);
if (fail > 0) process.exit(1);
