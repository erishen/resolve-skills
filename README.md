# harness-skills

语言无关的「技能（提示词包）」独立仓库。定义一套与编程语言无关的契约
（见 [`SKILL_SPEC.md`](./SKILL_SPEC.md)），对齐 **Agent Skills** 开放标准
（被 Claude Code、OpenAI Codex 共同采用），使同一份 `skills/` 集合可零改动地
被多端消费：

| 消费者 | 发现路径 | 激活方式 |
|---|---|---|
| `resolve-tui`（Rust） | `HARNESS_SKILLS_DIR` 指向本仓库 `skills/` | 自适应（关键词预筛 / 模型自选） |
| `resolve-harness`（Python） | 同上 | 模型自选 |
| **Claude Code** | 软链/复制 `skills/` → `~/.claude/skills/` | 模型自选（`description`） |
| **OpenAI Codex** | `skills/` → `~/.codex/skills/`，或 `config.toml` 的 `[[skills.config]]` | 模型自选（`description`） |

## 结构

```
harness-skills/
├── SKILL_SPEC.md        # 语言无关契约（对齐 Agent Skills 标准）
├── README.md
├── skills/              # 种子技能集合（<skill>/SKILL.md + 可选 scripts/ references/ assets/）
│   ├── code-review/
│   ├── post-comment/
│   └── weekly-investment-review/
├── loaders/             # 各语言薄 loader（待实现）
│   ├── rust/            # 供 resolve-tui
│   └── python/          # 供 resolve-harness
└── schema/              # 可选 frontmatter 校验（additionalProperties: true）
```

## 用法（各 harness）

将本仓库作为 `git submodule` 加入 harness 项目，并在 loader 中把 `skills/` 目录设为
技能根（或通过环境变量指向它）。加载逻辑只需实现
[`SKILL_SPEC.md`](./SKILL_SPEC.md) 第 4 节的 `load_skills` 契约；未知 frontmatter
键须忽略，以保证 Claude Code / Codex 产出的技能也能加载。
