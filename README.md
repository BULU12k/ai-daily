# AI 前沿时讯日报

个人专用的 AI 领域要闻日报站：GitHub Actions 每半小时自动抓取精选 AI 资讯源，用 LLM 生成"发生了什么、为什么重要"的中文摘要（通常3–5句，必要时最多6句），发布为 GitHub Pages 静态站，并把新增条目推送到 ntfy.sh 主题——手机（App 后台推送）和电脑（浏览器/App 订阅）都能收到，不依赖电脑开机。

无账号、无多用户、无商业化。密钥全部走 GitHub Secrets，仓库内不含任何密钥。

## 架构

```
RSS/Atom 与官方网页来源（≥5 个）
  OpenAI Blog / Anthropic News / Google DeepMind / Meta AI /
  Hugging Face Blog / TechCrunch AI / 量子位
        │  GitHub Actions（cron 每半小时 + 手动触发）
        ▼
scripts/fetch-daily.mjs
  抓取 → 按 URL/guid 的 SHA-256 哈希去重（状态持久化在 data/seen.json，随仓库提交）
  → 提取原文正文/标记依据 → LLM 中文事实摘要（数字、条件、局限与宣传归属）
  → 生成 docs/index.html + docs/daily/YYYY-MM-DD.html（Asia/Shanghai 时区分日）
        │  git commit & push
        ▼
GitHub Pages（docs/ 目录）        scripts/notify.mjs → ntfy.sh 主题
```

LLM 通道优先级（全部通过环境变量注入，仓库内零硬编码）：

1. `ZAI_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY`（智谱开放平台，默认模型 `glm-4-flash`）
2. `OPENAI_API_KEY`（默认模型 `gpt-4o-mini`）
3. 都没有 → 自动使用 GitHub Models 免费推理（内置 `GITHUB_TOKEN`，模型 `openai/gpt-4o-mini`）
4. 连 GitHub Models 都失败 → 自动降级为平实中文摘要（不玩梗），日报照常发布

## 手机推送与电脑端订阅

- **推送主题（ntfy.sh，免注册免费）**：`ai-daily-f02c73ab`
  完整 URL：`https://ntfy.sh/ai-daily-f02c73ab`
- **Android**：安装 [ntfy - Put the notification to use](https://play.google.com/store/apps/details?id=io.heckel.ntfy) → 添加订阅 → 输入 `ai-daily-f02c73ab`。建议在系统设置里允许 ntfy 后台运行。
- **iOS**：App Store 安装 ntfy → 添加订阅 → 输入 `ai-daily-f02c73ab`（iOS 走官方即时推送服务，无需保活）。
- **电脑端（覆盖电脑不在网站前的情况）**：
  - 最快方式：浏览器打开 `https://ntfy.sh/ai-daily-f02c73ab`，点击 Subscribe（保持标签页开着即可收到）；
  - 桌面常驻：安装 [ntfy 桌面版](https://ntfy.sh/docs/subscribe/desktop/) 或用 CLI `ntfy subscribe ai-daily-f02c73ab`。
- 通知优先为海报图片附件，并附在线链接；缺图时降级为本班文字和日报链接。

> 想换主题名：修改 `config/site.json` 的 `ntfy_topic`，或在仓库 Settings → Variables and secrets → Actions 里加 `NTFY_TOPIC` 变量覆盖。

## 部署步骤（约 10 分钟，全程免费）

1. **创建 GitHub 仓库**：在 GitHub 上新建一个公开仓库（例如 `ai-daily`），把本目录内容全部推上去：
   ```bash
   cd ai-daily
   git init -b main
   git add -A
   git commit -m "init: ai-daily"
   git remote add origin https://github.com/<你的用户名>/ai-daily.git
   git push -u origin main
   ```
2. **启用 GitHub Pages**：仓库 Settings → Pages → Build and deployment → Source 选 **Deploy from a branch**，Branch 选 **main**，Folder 选 **/docs** → Save。一两分钟后站点地址即为
   `https://<你的用户名>.github.io/ai-daily/`
3. **（可选）配置 LLM 密钥**：Settings → Secrets and variables → Actions → New repository secret，按需添加 `ZAI_API_KEY`（或 `ZHIPUAI_API_KEY` / `GLM_API_KEY` / `OPENAI_API_KEY`）。不配置也能跑（自动走 GitHub Models 免费推理 → 仍未命中则平实摘要）。
4. **验证定时任务**：仓库 Actions 页 → 选 "AI Daily" workflow → Run workflow 手动跑一次。绿勾后：
   - `docs/daily/` 下出现当天日报页，Pages 站点可访问；
   - `data/seen.json` 有去重状态；
   - ntfy 主题收到新条目推送（先完成上面的订阅步骤即可看到）。
5. **订阅 ntfy 主题**：见上一节。到此手机 + 电脑双端推送生效。

## 定制

- **换/加资讯源**：编辑 `scripts/fetch-daily.mjs` 顶部 `FEEDS` 数组。其余来源保持 RSS/Atom；Anthropic 使用 `https://www.anthropic.com/news`，Meta 使用 `https://ai.meta.com/blog/` 的官方服务端文章卡片（包括精选、Latest News 和普通列表），不再调用失效 RSS 或公共 RSSHub。单个源网络/HTTP/页面结构失败会明确记日志并跳过，不影响其余源。页面正常但没有时效内文章会单独记录，不能把空内容当成抓取成功。
- **官方网页的日期与覆盖边界**：`scripts/official-news.mjs` 使用 linkedom 解析 HTML，不执行网页脚本。标题、URL、日期来自文章卡片，按官方原文 URL 去重，排除导航/分类；Meta 对时效候选补读官方文章的描述，描述失败单独记录。两页目前只有日精度，固定按 UTC 当日 00:00 表示，再进入原有 24 小时筛选；这不是已知的实际发布时刻，可能提前排除部分晚间发布的文章。缺失、无效及未来日期不参与筛选，绝不使用抓取时刻补日期。仅覆盖官方当前返回的可见列表，未来结构变化需维护，不能保证全量无遗漏。
- **验证环境**：本机可用现有代理的单次 `node --use-env-proxy` 请求验证页面；脚本不修改系统代理，也不将本机结果视为 GitHub 云端已验证。云端发布后须查看两源实际日志，CI 绿灯不替代来源成功。
- **每日条目上限**：`config/site.json` 的 `max_items_per_day`（默认每次取 12 条进入日报；海报及推送取前 4 条，最多 2 页）。
- **LLM 模型**：仓库 Variables 加 `LLM_MODEL` 可覆盖默认模型。
- **cron 时间**：编辑 `.github/workflows/daily.yml`（现为每小时的 00、30 分）。

## 文件结构

```
.github/workflows/daily.yml   定时 + 手动触发的工作流
scripts/fetch-daily.mjs        抓取 / 去重 / 摘要 / 建页（linkedom 解析静态正文，Node 22）
scripts/notify.mjs             ntfy.sh 海报附件及缺图文字降级推送
config/site.json               站点与推送主题配置
data/seen.json                 去重状态（Actions 自动提交回仓库持久化）
data/days.json                 近 30 天每日条目库（同日多次运行自动追加）
data/outbox.json               本期待推送清单（流水线内部产物）
docs/                          GitHub Pages 站点根（index.html + daily/*.html，均为生成物）
```

## 海报与电脑本地归档

每班最多 4 条新闻，每张最多 2 条、最多 2 张，文件名为 `YYYY-MM-DD-HHmm-pN.png`，不同班次互不覆盖。仅抓取最近 24 小时有明确日期的新闻；没有新增条目时不会发通知。

工作流先抓取建页、再渲染 PNG，随后运行 `node scripts/maintain-posters.mjs`。即使空班或渲染失败也扫描真实有效 PNG，发布 `docs/poster/index.json`；索引按上海日期保留含今天最近 3 天，日期严格早于 7 天的 PNG 清理。日报文字页与图片保留期不同，海报在线链接不保证保留期外仍可用。

`node scripts/save-posters.mjs [目标目录]` 默认保存到 `D:\ntfy\AI日报海报`。现有 Windows 后台计划任务定期执行，不依赖 git pull。脚本从 Pages 索引逐张下载，校验文件名与 PNG 结构，原子保存，并维护 `saved-manifest.json`。实际有效文件存在就不覆盖；文件缺失或损坏时即使有 manifest 也会重新下载。索引、HTTP、网络或内容错误均写入目标目录 `save-posters.log`，失败退出非零，下一周期重试。电脑离线超过索引保留期可能漏归档；本地已归档文件不随在线清理删除。

通知优先发送可用海报；部分或全部海报不可用时另发本班文字与日报链接，避免漏掉缺页新闻。文字版通过请求正文发送，按 UTF-8 字节限制在 4096 字节内，保留全部新闻的编号标题和日报链接，超长标题或摘要会明确省略；完整内容和原文链接可在日报查看。HTTP 200/202 且含合法消息 id 才记成功，任何消息失败均非零退出且不标记整班已推送。工作流通知失败不会回滚已发布页面，需查看步骤日志；自动测试只使用 localhost mock，不实际发 ntfy 消息。定时调度可能延迟，Pages 缓存也可能导致归档晚一周期。

### 手机查看海报
新通知使用已上线的网站 PNG 作为 ntfy 外部附件，不再上传具有三小时有效期的 ntfy 临时文件。点击通知或“查看海报”打开本页图片，“阅读日报”打开当天文字日报；正文也保留完整链接。图片仍受网站现有保留期约束，旧消息不会自动修复或重发。
发送前所有页共享最多六分钟的上线等待，每十五秒重试，单次公开请求最多十秒；公开响应须为 PNG 且 SHA256 与本班本地图片一致。等待失败/缺图时仅发本班文字和日报入口，不发布坏附件；通知请求单次最多六十秒，两页及一次降级最多再三分钟。可用 POSTER_WAIT_MS / POSTER_POLL_MS / POSTER_REQUEST_TIMEOUT_MS 缩短等待（不能超过默认上限）。
客户端自动下载仍取决于 ntfy 设置、手机网络及后台限制；外部附件与按钮的本地隔离验证不代表手机已经实测。发布后应分别确认手机能打开图片和是否自动下载；无法访问网站时仍需排查手机网络。线上通知与实际手机验证须另行授权/观察。

### 正文依据与摘要质量

编辑输入优先使用现有七个来源链接到的原文正文，而非只取 RSS 简介前三句。正文获取仅允许这些来源的公开 HTTPS 域名；最多三次重定向、并发三条、每篇总超时12秒、响应最多1.5MB。不运行页面脚本、不抓取文内外链。支持常见 article/正文容器；不承诺覆盖交互内容、图片、图表、登录或付费隐藏内容。

每个抓取及重定向目标先排除主页、栏目、搜索、作者等聚合地址；HTML还需单篇文章元数据和标题，canonical/og:url必须与最终地址一致，泛main或文本够长本身不构成正文证据。多篇article卡片不作为一篇正文。www、尾斜杠、amp规范化跳转可接受，换成另一文章路径的跳转因不能确认同一报道而降级。缺少这些证据的合法文章也可能被保守拒绝；这些检查不是对网站元数据真实性或摘要事实的独立认证。

每篇最多8000字符；长文章选择开头、带数字/条件/限制和结尾的段落，保留原段落编号和“原文选段”标记。读取或身份核对失败明确标为“订阅简介”，记录失败原因；这不代表没有新闻，也不能声称读了全文。正文新增输入会增加后续模型token与费用，发布前用真实样例报告输入变化，不能把字符数直接换成费用。

摘要编辑要求保留核心事件、数字及单位、比较基线、变化、适用条件和局限；公司预测/宣传必须注明归属。通常3–5句，必要时最多6句；不为凑结构编造缺失事实。模型还返回原段落编号供追溯，编号匹配只能证明引用存在，不能独立证明模型没有误读。未实际调用模型的参考改写必须单列为人工示例。

模型失败时，从可用正文选取有事实/数字/条件的完整句子再进行免费翻译，输入总量有界；没有正文时才用简介。该路径属于摘译，不等于综合摘要，不输出虚构的“信号解读”。网站与海报显示依据和摘译状态；原文链接仍在日报页面。历史已见条目不因此重新抓取或重发，来源/24小时时效/去重规则保持原样。

通知要点使用同一段落，以“ · ”分隔；海报链接标签简写为“海报”。公开图片校验、外部附件、点击看图、两个按钮、字节预算和无新闻静默行为不变。海报按加长摘要扩展画布，若有界扩展后仍贴近底边则报错，避免把已裁切图片当成功保存。

成功模型响应仅在运行日志记录provider、接口origin、请求/响应模型名和usage的token/缓存计数白名单；缺失为unknown，不记录密钥、正文或金额。旧版本未保存的usage不能事后恢复为累计账单；运行日志留存也不等同完整计费账本。
