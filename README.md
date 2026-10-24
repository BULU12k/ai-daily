# AI 前沿时讯日报

个人专用的 AI 领域要闻日报站：GitHub Actions 每 3 小时自动抓取精选 AI 资讯源，用 LLM 生成"发生了什么、为什么重要"的中文短摘要（单条 ≤3 句），发布为 GitHub Pages 静态站，并把新增条目推送到 ntfy.sh 主题——手机（App 后台推送）和电脑（浏览器/App 订阅）都能收到，不依赖电脑开机。

无账号、无多用户、无商业化。密钥全部走 GitHub Secrets，仓库内不含任何密钥。

## 架构

```
RSS/Atom 源（≥5 个）
  OpenAI Blog / Anthropic News / Google DeepMind / Meta AI /
  Hugging Face Blog / TechCrunch AI / 量子位
        │  GitHub Actions（cron 每 3 小时 + 手动触发）
        ▼
scripts/fetch-daily.mjs
  抓取 → 按 URL/guid 的 SHA-256 哈希去重（状态持久化在 data/seen.json，随仓库提交）
  → LLM 中文摘要 + 玩梗润色（只用近期流行表达，拿不准时效的梗自动降级为平实表达）
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
- 通知内容为条目标题 + 一句话摘要 + 原文链接。

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

- **换/加资讯源**：编辑 `scripts/fetch-daily.mjs` 顶部 `FEEDS` 数组（RSS/Atom 均可）。单个源抓取失败会被跳过并记日志，不影响其余源。
- **每日条目上限**：`config/site.json` 的 `max_items_per_day`（默认 12，推送最多取前 5 条，避免刷屏）。
- **LLM 模型**：仓库 Variables 加 `LLM_MODEL` 可覆盖默认模型。
- **cron 时间**：编辑 `.github/workflows/daily.yml`（现为每 3 小时整点一次）。

## 文件结构

```
.github/workflows/daily.yml   定时 + 手动触发的工作流
scripts/fetch-daily.mjs        抓取 / 去重 / 摘要 / 建页（无第三方依赖，Node 22）
scripts/notify.mjs             ntfy.sh JSON 推送
config/site.json               站点与推送主题配置
data/seen.json                 去重状态（Actions 自动提交回仓库持久化）
data/days.json                 近 30 天每日条目库（同日多次运行自动追加）
data/outbox.json               本期待推送清单（流水线内部产物）
docs/                          GitHub Pages 站点根（index.html + daily/*.html，均为生成物）
```
