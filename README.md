# workflows

各仓库共用的 GitHub Actions 可复用工作流。

## Codex PR 审查

`.github/workflows/codex-pr-review.yml`：PR 打开、更新、重新打开或转为 ready 时，用 [openai/codex-action](https://github.com/openai/codex-action) 让 Codex 审查这个 PR 引入的改动，然后以 GitHub review 的形式发回 PR。能定位到 diff 行的问题发成行内评论，定位不到的写在 review 正文里。

### 接入一个仓库

1. 在仓库里设置 secret `OPENAI_API_KEY`：

   ```sh
   gh secret set OPENAI_API_KEY -R godisabug/<仓库名>
   ```

   个人账号没有账号级 secret，每个仓库都要单独设置一次。

2. 把 [`templates/codex-pr-review.yml`](templates/codex-pr-review.yml) 复制到该仓库的 `.github/workflows/codex-pr-review.yml`。

### 改用 OpenAI 兼容网关（如 sub2api）

不直接调 api.openai.com 时，再设一个 secret：

| Secret | 值 |
|---|---|
| `OPENAI_API_KEY` | 网关签发的 key（建议给 CI 单独建一个，便于限额和吊销） |
| `RESPONSES_API_ENDPOINT` | 网关的完整 Responses 地址，如 `http://100.x.y.z:8080/v1/responses` |

网关只在 tailnet 里可达时，runner 要先临时加入 tailnet。工作流用 Tailscale 的 workload identity federation（GitHub OIDC），不存长期密钥：

1. Tailscale 策略里加 `tag:ci`，并只放行它访问网关端口：

   ```jsonc
   "tagOwners": { "tag:ci": ["autogroup:admin"] },
   "grants": [
     { "src": ["tag:ci"], "dst": ["100.x.y.z"], "ip": ["tcp:8080"] }
   ]
   ```

2. 在 Tailscale 管理后台 Trust credentials 新建 OpenID Connect 凭据：Issuer 选 GitHub，Subject 填 `repo:godisabug/*:pull_request`，scope 选 `auth_keys`（可写），标签 `tag:ci`。

   GitHub 对 2026-07-15 之后新建的仓库强制使用不可变的 OIDC subject：`repo:godisabug@<账号 ID>/<仓库>@<仓库 ID>:pull_request`，改不回旧格式。这类仓库要再建一个凭据，Subject 填 `repo:godisabug@<账号 ID>/*:pull_request`，然后把它的 Client ID 和 Audience 设到这些仓库。仓库用的是哪种格式，看 `gh api repos/godisabug/<仓库>/actions/oidc/customization/sub` 返回的 `sub_claim_prefix`。格式不匹配时，"Connect to Tailscale" 这一步会报 `token exchange failed with status 403`。
3. 把凭据的 Client ID 和 Audience 设为 secret `TS_OAUTH_CLIENT_ID`、`TS_AUDIENCE`。

runner 以临时节点加入，不接受 tailnet DNS，任务结束后退出。工作流会在调用 Codex 前先探测网关；连不上时直接失败并给出提示，不会让 Codex 反复重试。调用方模板里的 `id-token: write` 就是给这一步用的，没配 Tailscale 时不会被用到。

### 会审查什么、不审查什么

- 只看 `base...head` 这一段改动，只报会导致实际故障的问题（错误行为、崩溃、数据丢失、安全、竞态、契约破坏等），不报风格和偏好。仓库里 `AGENTS.md`、`CLAUDE.md` 写明的约定除外。
- 优先级 P0–P3，默认发出 P0–P2，P3 只在正文里报个数。
- 以下情况跳过：草稿 PR、来自 fork 的 PR（fork 拿不到 secret）、机器人开的 PR（如 Dependabot）、打了 `no-codex-review` 标签的 PR。
- 同一个 PR 连续推送时，旧的审查会被取消，只保留最新提交的那次。每次推送都会产生一次新的 review。

### 可选参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `model` | `gpt-6.2-sol` | Codex 模型；传空字符串用 Codex CLI 默认 |
| `effort` | `high` | 推理强度：none / minimal / low / medium / high / xhigh；传空字符串用模型默认（可能是 none，审查质量差） |
| `language` | 简体中文 | 审查内容的语言 |
| `max-priority` | 2 | 发出 P0 到该优先级的问题 |
| `review-bots` | false | 也审查机器人 PR；Dependabot 触发的运行读的是 Dependabot secrets，还要在那里再配一份 key |
| `extra-instructions` | 空 | 追加给本仓库的审查要求 |

更长期的规则建议写进仓库的 `AGENTS.md`，Codex 会自动读取。

### 安全

- 只有对仓库有写权限的人触发的运行才会调用 Codex（codex-action 自带检查）。
- Codex 运行在 `:workspace` 权限配置和 `drop-sudo` 下，没有网络，不能读到 API key；审查任务只拿 `contents: read`，发评论的任务单独拿 `pull-requests: write`，不检出、不运行仓库代码。
- 提示词里明确 PR 标题、描述、代码都是不可信数据，但提示注入无法完全杜绝，所以 review 只作参考，不作为合并门禁。
- 本仓库是公开的，里面没有任何密钥；别人调用时用的是他们自己的 secret。

### 费用

按 OpenAI API 用量计费，每次推送一次调用。改动大的 PR 读的代码多，花费也高。不想审的 PR 打 `no-codex-review` 标签。

### 版本

调用方引用 `@v1`。不破坏调用方的改动直接移动 `v1` 标签；输入、输出或行为有破坏性变化时发 `v2`。

### 开发

```sh
node --test test/*.test.mjs
```

测试从工作流 YAML 里取出发评论的那段 github-script，用模拟的 GitHub API 运行。CI 另外用 actionlint 检查工作流。
