# resolve-skills

语言无关的**技能（提示词包）**独立仓库。定义一套与编程语言无关的契约（见 [`SKILL_SPEC.md`](./SKILL_SPEC.md)），对齐 **Agent Skills** 开放标准（被 Claude Code、OpenAI Codex 共同采用），使同一份 `skills/` 集合可零改动地被多端消费。

## 支持的消费者

| 消费者 | 发现路径 | 激活方式 |
|---|---|---|
| `resolve-studio`（TypeScript / Cordis） | `HARNESS_SKILLS_DIR` 指向本仓库 `skills/` | 自适应（关键词预筛 / 模型自选） |
| `resolve-tui`（Rust） | 同上环境变量 | 自适应（关键词预筛 / 模型自选） |
| `resolve-harness`（Python） | 同上环境变量 | 模型自选 |
| **Claude Code** | 软链/复制 `skills/` → `~/.claude/skills/` | 模型自选（`description`） |
| **OpenAI Codex** | `skills/` → `~/.codex/skills/`，或 `config.toml` 的 `[[skills.config]]` | 模型自选（`description`） |

## 技能列表

| 技能 | 说明 | 含脚本 |
|---|---|---|
| [`code-review`](./skills/code-review/SKILL.md) | 审查代码文件并输出结构化审查报告（问题列表 + 严重度 + 建议） | ✅ `stats.py` |
| [`post-comment`](./skills/post-comment/SKILL.md) | 在 erishen.cn 随机挑一篇已发布文章并提交评论（测试站内评论/互动功能） | ✅ `random-comment.mjs` |
| [`rust-review`](./skills/rust-review/SKILL.md) | 按 Rust 团队惯例审查代码质量 | — |
| [`weekly-investment-review`](./skills/weekly-investment-review/SKILL.md) | 生成本地投资组合周报。先调 `portfolio-summary` 拿真实持仓快照摘要（Markdown），再按流程输出结构化周报（组合概览 / 收益点评 / 风险警示 / 调仓建议） | ✅ `portfolio-summary.mjs`, `pse-review.mjs`, `lib-mcp.mjs` |

## Souls（PSE 三角色人格）

`souls/` 目录包含 **Planner–Specialist–Evaluator（PSE）** 三角色模式的人格定义，对齐 Agent Skills 的 `SOUL.md` 约定：

| Soul | 角色 |
|---|---|
| [`planner`](./souls/planner/SOUL.md) | 任务拆解、规划与步骤编排 |
| [`specialist`](./souls/specialist/SOUL.md) | 领域专属执行与深度工作 |
| [`evaluator`](./souls/evaluator/SOUL.md) | 独立验证、质量门禁与证据驱动评估 |

设置 `PSE_SOULS_DIR` 后（默认为 `HARNESS_SKILLS_DIR/../souls`），PSE 插件会加载这些人格来驱动三角色循环。

## 快速开始

### 1. 克隆或作为子模块添加

```bash
git clone https://github.com/your-org/resolve-skills.git
# 或者，在你的 harness 项目中：
git submodule add https://github.com/your-org/resolve-skills.git
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入你的凭据：

```bash
cp .env.example .env
# 编辑 .env 填入真实值
```

所有可用变量见 [`.env.example`](./.env.example)。关键变量：

| 变量 | 用途 |
|---|---|
| `HARNESS_SKILLS_DIR` | 指向本仓库 `skills/` 目录的路径（所有 harness 共用） |
| `HARNESS_SKILLS_ENV` | 可选：指定要加载的 `.env` 文件路径（优先于 cwd 的 `.env`） |
| `PSE_SOULS_DIR` | 可选：`souls/` 目录路径（默认为 `HARNESS_SKILLS_DIR/../souls`） |
| `PROD_WORDPRESS_USERNAME` | WordPress 用户名（`post-comment` 技能用） |
| `PROD_WORDPRESS_APP_PASSWORD` | WordPress 应用密码（`post-comment` 技能用） |
| `ERISHEN_BASE` | 可选：覆盖博客 base URL（默认 `https://erishen.cn`） |
| `AUTOGEN_PSE_DIR` | 可选：覆盖 autogen-pse 路径（`weekly-investment-review` 技能用） |
| `PSE_REVIEW_PROVIDER` | 可选：`agnes`（免费，默认）或 `deepseek`（付费）用于 PSE 回顾 |

> **隐私**：`.env` 已被 gitignore 忽略，永远不要提交真实凭据。`.env.example` 仅含占位符。

### 3. 配合 resolve-studio 使用

在 resolve-studio 的 `.env` 中设置：

```env
HARNESS_SKILLS_DIR=/path/to/resolve-skills/skills
```

重启 resolve-studio。技能索引会自动注入到系统提示中；模型通过调用 `skill-run` 工具加载技能的完整指令。

### 4. 配合 Claude Code 使用

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/resolve-skills/skills/* ~/.claude/skills/
```

重启 Claude Code。技能会根据 `description` 出现在技能列表中。

## 添加新技能

1. 在 `skills/` 下创建目录：
   ```
   skills/my-skill/
   ├── SKILL.md          # 必需：frontmatter + 指令
   ├── scripts/          # 可选：辅助脚本
   ├── references/       # 可选：参考文档
   └── assets/           # 可选：静态资源
   ```

2. 编写 `SKILL.md`，包含必需的 frontmatter：
   ```markdown
   ---
   name: my-skill
   description: 一句话说明何时使用此技能
   ---

   # 我的技能

   分步指令...
   ```

3.（可选）在 `scripts/` 下添加辅助脚本。脚本可以是任何语言；技能指令告诉模型如何调用它们。

4. 用你选择的 harness 测试。

完整契约规范见 [`SKILL_SPEC.md`](./SKILL_SPEC.md)。

## 目录结构

```
resolve-skills/
├── SKILL_SPEC.md              # 语言无关契约（对齐 Agent Skills 标准）
├── README.md                  # 英文文档
├── README.zh.md               # 中文文档（本文件）
├── .env.example               # 环境变量模板（复制为 .env）
├── skills/                    # 技能集合
│   ├── code-review/           # 代码审查技能
│   │   ├── SKILL.md
│   │   └── scripts/stats.py
│   ├── post-comment/          # 博客评论技能
│   │   ├── SKILL.md
│   │   └── scripts/random-comment.mjs
│   ├── rust-review/           # Rust 代码审查技能
│   │   └── SKILL.md
│   └── weekly-investment-review/  # 投资周报技能
│       ├── SKILL.md
│       └── scripts/
│           ├── lib-mcp.mjs         # 零依赖 MCP stdio 服务器骨架
│           ├── portfolio-summary.mjs # MCP 桥接：投资组合摘要
│           └── pse-review.mjs       # MCP 桥接：完整 PSE 回顾
└── souls/                     # PSE 三角色人格
    ├── planner/SOUL.md
    ├── specialist/SOUL.md
    └── evaluator/SOUL.md
```

## 许可证

MIT
