import { parseHTML } from 'linkedom';

// Only articles linked by the existing seven feeds; no arbitrary URL crawler.
const HOSTS = ['openai.com', 'anthropic.com', 'deepmind.google', 'blog.google', 'ai.meta.com', 'huggingface.co', 'techcrunch.com', 'qbitai.com'];
const MAX_BYTES = 1_500_000;
const MAX_CHARS = 8_000;
export function allowedArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// A permitted publisher host is not proof of an article: redirects commonly
// land on a home/category/login page. Check every target before fetching it.
function assertArticleTarget(value) {
  if (!allowedArticleUrl(value)) throw new Error('原文地址不在现有来源公开HTTPS域名范围');
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (!pathname || /^\/(?:news|blog|blogs|index(?:\.html?)?|app|login|signin|subscribe|subscription)$/.test(pathname) || /^\/(?:category|categories|tag|tags|author|authors|search|feed|rss|page)(?:\/|$)/.test(pathname) || ['s', 'search', 'q'].some(key => url.searchParams.has(key))) {
    throw new Error('原文目标为主页、聚合或非文章页面');
  }
}

function identityUrl(value) {
  const url = new URL(value);
  // Tracking parameters and canonical /amp redirects do not change identity.
  return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/amp\/?$/, '').replace(/\/+$/, '')}`;
}

function verifyArticleIdentity(document, url) {
  const canonical = [...document.querySelectorAll('link[rel="canonical"],meta[property="og:url"]')]
    .map(node => node.getAttribute('href') || node.getAttribute('content')).filter(Boolean);
  for (const address of canonical) {
    const resolved = new URL(address, url || undefined).href;
    assertArticleTarget(resolved);
    if (url && identityUrl(resolved) !== identityUrl(url)) throw new Error('页面声明的文章地址与抓取目标不一致');
  }
  const isArticle = [...document.querySelectorAll('meta[property="og:type"]')].some(node => node.getAttribute('content')?.toLowerCase() === 'article') ||
    [...document.querySelectorAll('script[type="application/ld+json"]')].some(node => {
      try {
        const visit = value => Array.isArray(value) ? value.some(visit) : value && typeof value === 'object' &&
          ([value['@type']].flat().some(type => /^(?:Article|NewsArticle|BlogPosting|TechArticle)$/.test(type)) || (value['@graph'] && visit(value['@graph'])));
        return visit(JSON.parse(node.textContent));
      } catch { return false; }
    });
  const headings = [...document.querySelectorAll('h1')].map(node => normalize(node.textContent)).filter(text => text.length >= 5);
  if (!isArticle || !headings.length) throw new Error('缺少可信单篇文章元数据或标题，未把列表当正文');
}

export function extractArticle(html, { url } = {}) {
  const { document } = parseHTML(html);
  if (url) assertArticleTarget(url);
  // Inspect metadata before removing scripts/header (JSON-LD and an article
  // heading may live there); never execute scripts or treat them as prose.
  verifyArticleIdentity(document, url);
  for (const node of document.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,[aria-hidden="true"],.related-posts,.newsletter,.advertisement')) node.remove();
  const selectors = ['[itemprop="articleBody"]', '[data-testid="article-body"]', '.entry-content', '.article-content', '.wp-block-post-content', '.article__content', '.post-content', '.article', 'article', 'main'];
  let paragraphs = [];
  for (const selector of selectors) {
    const roots = [...document.querySelectorAll(selector)];
    if (selector === 'article' && roots.length !== 1) continue;
    const root = roots[0];
    if (!root) continue;
    if ((selector === 'main' || selector === '.article') && root.querySelectorAll('article').length > 1) continue;
    const seen = new Set();
    const candidate = [...root.querySelectorAll('p,h2,h3,li')].filter(node => !(node.tagName === 'LI' && node.querySelector('p'))).map(node => normalize(node.textContent)).filter(text => text.length >= 5 && !seen.has(text) && seen.add(text));
    if (candidate.join(' ').length >= 150 && candidate.length >= 2) { paragraphs = candidate; break; }
  }
  if (!paragraphs.length) throw new Error('未提取到可信文章正文（结构变化或仅简介）');
  const total = paragraphs.join('\n').length;
  let chosen = paragraphs.map((text, index) => ({ text, index }));
  let clipped = false;
  if (total + paragraphs.length * 20 > MAX_CHARS) {
    clipped = true;
    // Keep the lead, quantitative/conditional passages and conclusion, not only
    // the first three sentences. Original order and paragraph numbers survive.
    const ranked = chosen.map(p => ({ ...p, score: (p.index < 3 ? 8 : 0) + (/\d/.test(p.text) ? 4 : 0) + (/however|limit|only|claim|according|cost|available|support|but |不过|仅|限制|条件|声称|据|成本|开放|支持/i.test(p.text) ? 3 : 0) + (p.index >= paragraphs.length - 2 ? 2 : 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
    let used = 0; chosen = [];
    for (const paragraph of ranked) {
      if (paragraph.text.length > MAX_CHARS) continue;
      if (used + paragraph.text.length + 20 > MAX_CHARS) continue;
      chosen.push(paragraph); used += paragraph.text.length + 20;
    }
    chosen.sort((a, b) => a.index - b.index);
  }
  if (!chosen.length) throw new Error('正文段落超出安全长度，未伪装为全文');
  return { text: chosen.map(p => `[P${p.index + 1}] ${p.text}`).join('\n'), basis: clipped ? 'article_excerpts' : 'article_body', note: clipped ? '原文较长，使用有界正文选段，可能遗漏未选段信息' : '可提取正文；不含交互图表、图片或付费隐藏内容', paragraphs: chosen.length, original_chars: total };
}

async function readHtml(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('正文响应超过1500000字节');
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) throw new Error('正文响应不是HTML');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('正文响应为空');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) throw new Error('正文响应超过1500000字节');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchArticle(link, fetchImpl = fetch) {
  let url = link;
  const signal = AbortSignal.timeout(12_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    assertArticleTarget(url);
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'ai-daily-bot/1.0 (personal news digest)', Accept: 'text/html' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('原文重定向缺少地址');
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) throw new Error(`原文HTTP ${response.status}`);
    // We can verify slash/www/amp canonicalization, but cannot establish that a
    // different slug is the same report without publisher-specific evidence.
    if (identityUrl(url) !== identityUrl(link)) throw new Error('重定向已更换文章路径，无法确认与订阅原文为同一报道');
    return { ...extractArticle(await readHtml(response), { url }), url };
  }
  throw new Error('原文重定向超过3次');
}

export async function enrichArticleContext(items, { log = () => {}, fetchImpl = fetch } = {}) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= items.length) break;
      const item = items[index];
      try {
        item.article = await fetchArticle(item.link, fetchImpl);
        log(`正文 ${item.source}: ${item.article.basis}，${item.article.text.length}字符，${item.article.paragraphs}段`);
      } catch (error) {
        item.article = { text: '', basis: 'feed_description', note: `原文不可用：${error.message}；仅依据订阅简介，信息可能不完整` };
        log(`正文 ${item.source}: ${item.article.note}`);
      }
    }
  }));
}
