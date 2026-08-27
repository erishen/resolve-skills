# SKILL_SPEC — 语言无关的技能契约（对齐 Agent Skills 开放标准）

- **spec-version**: 1.0
- **状态**: 草案（待评审定稿）
- **目标**: 让「技能（提示词包）」成为一套与编程语言无关的契约。一份 `skills/`
  集合可同时被：
  - `resolve-tui`（Rust harness，薄 loader 加载）
  - `resolve-harness`（Python harness）
  - **Claude Code**（原生识别，放到 `~/.claude/skills/` 即可）
  - **OpenAI Codex**（原生识别，放到 `~/.codex/skills/` 或 `config.toml` 的 `[[skills.config]]`）
  - 任何兼容 **Agent Skills** 开放标准的工具（GitHub Copilot 等）

  本规范的字段集合 = **Agent Skills 标准字段** ∪ **本 harness 的少量可选扩展**，
  以保证「写一次、处处可用」。

---

## 0. 生态对齐要点

Claude Code 与 OpenAI Codex 当前均采用 Agent Skills 标准：目录 `<skill>/SKILL.md`、
frontmatter 仅 `name` + `description` 参与路由、靠 `description` 让模型**自选**何时加载、
可选附带 `scripts/ references/ assets/`。因此本契约直接复用该形态，差异只在各工具的
**发现路径**与**激活策略**，均不需改文件内容。

---

## 1. 设计原则

1. **语言无关**：技能文件是纯文本 + 可选脚本；正文（Markdown 指令）跨语言可直接注入。
2. **可迁移 / 可独立**：技能集合是独立仓库（`harness-skills`），通过 `git submodule`
   / 依赖嵌入各 harness，版本可钉死。
3. **标准优先**：字段以 Agent Skills 为标准；本 harness 只在标准之外加两三个**可选**
   扩展，且其它工具忽略它们。
4. **激活策略是 harness 私事**：契约只规定文件怎么写、loader 怎么读，**不规定**何时
   注入正文；但以「模型自选」为跨工具基线（见 §5）。
5. **前向兼容**：loader 必须**忽略未知 frontmatter 键**，保证 Claude Code / Codex
   专属字段（如 `when_to_use`、`allowed-tools`、`disable-model-invocation`）不会让
   我们的 loader 崩溃。

---

## 2. 目录布局（与 Agent Skills 完全一致）

```
<skill-name>/
  SKILL.md        # 必需：技能定义（frontmatter + 正文）
  scripts/        # 可选：环境特定可执行脚本（.py / .mjs / .sh ...）
  references/     # 可选：按需读入上下文的文档（渐进式披露）
  assets/         # 可选：模板、图标、输出用文件
  agents/         # 可选：Codex 的 UI 元数据（openai.yaml，控制展示与调用策略）
```

- loader 仅扫描文件名精确为 **`SKILL.md`**（大写）的文件，递归不限深度。
- **`<skill-name>` 必须等于 `SKILL.md` 内的 `name`**（Agent Skills / Claude Code
  移植性硬性要求）。目录名即命令名 / 调用标识。

---

## 3. `SKILL.md` 格式

首行 `---` 起为 YAML frontmatter，第二个 `---` 结束，其后全为 Markdown 正文。

### 3.1 标准字段（Agent Skills）

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | **是（且 == 目录名）** | 技能唯一标识 / 命令名，`kebab-case` |
| `description` | **是** | **路由逻辑**：模型据此判断何时启用。**必须写明触发场景**（如「用户要求 review 时使用」） |
| `metadata` | 否 | 任意 YAML 结构，常放 `version` / `author` |
| `license` | 否 | 许可证 |
| `compatibility` | 否 | 兼容性声明 |
| `allowed-tools` | 否 | 预授权工具列表（Claude Code / API 识别；resolve-tui 可忽略或仅作提示） |

### 3.2 本 harness 扩展（可选，其它工具忽略）

| 字段 | 必需 | 说明 |
|---|---|---|
| `triggers` | 否 | 关键词预筛列表（见 §5）。字符串可用 `,` `，` `;` `；` 分隔 |
| `version` | 否 | 技能版本（等价于 `metadata.version`；loader 任取其一） |

### 3.3 未知字段规则（关键）

**loader 必须忽略一切未在本规范列出的 frontmatter 键，不得报错。** 典型被忽略的
生态专属键：`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、
`user-invocable`、`model`、`effort`、`context`、`paths`、`tags`、`homepage`、
`repository`、`author` 等，以及 Codex 的 `agents/openai.yaml` 文件。
这样一份由 Claude Code / Codex 生态产出的技能文件，能无改动地被 `resolve-tui` 加载。

### 3.4 正文（body）与约束

- 缺 frontmatter：整体视为正文，`name` 取文件名 stem（兼容纯正文技能）。
- body 为空：该技能跳过，不加载。
- 单文件解析失败：记录告警并跳过，不影响其它技能。
- 目录不存在：loader 返回空列表（不报错）。

### 3.5 最小示例（Agent Skills 兼容）

```markdown
---
name: code-review
description: 审查代码文件并输出结构化审查报告。用户要求「审查这段代码」「帮我 review」「看看这个实现有没有问题」时使用。
---

# Code Review 技能

## 步骤
1. 用 read-file 读取目标文件……
2. 逐点检查逻辑错误 / 安全风险 / 错误处理……
```

> `triggers` 为可选：无 `triggers` 的技能（如本仓库种子技能）依赖模型自选激活，
> 在采用「自适应」策略的 harness 下同样可用。

---

## 4. 加载契约（loader 行为，语言无关）

```
load_skills(root_dir: Path) -> Vec<Skill>
```

`Skill`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | frontmatter `name`，缺省回退目录/文件名；**必须等于目录名** |
| `description` | string | frontmatter `description` |
| `triggers` | `Vec<String>` | 本扩展，可为空 |
| `body` | string | 正文 |
| `scripts_dir` | `Option<Path>` | 存在 `scripts/` 时 |
| `references_dir` | `Option<Path>` | 存在 `references/` 时 |
| `assets_dir` | `Option<Path>` | 存在 `assets/` 时 |

约定：递归扫描 `SKILL.md`；解析失败仅告警；目录不存在返回空；结果按 `name` 排序。

---

## 5. 激活语义（对齐 Agent Skills：模型自选为基线）

- **生态标准激活 = 模型自选（model-selected）**：Claude Code / Codex 都靠
  `description` 让模型决定何时加载技能正文。这是跨工具的统一基线。
- **本 harness 自适应（`resolve-tui` 目标策略）**：
  - 有 `triggers` → 关键词预筛（命中才注入正文，省 token）。
  - 无 `triggers` → 回退模型自选：把技能索引（`name` + `description`）常驻系统提示，
    由模型决定启用并读取正文。
  - **同一份技能文件在 `resolve-tui` 与 Claude Code / Codex 下都能工作**。
- **手动-only（可选 passthrough）**：Claude Code `disable-model-invocation: true`、
  Codex `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false` 表示只显式
  调用。loader 可读取该意图（若 harness 实现了显式调用机制），否则忽略。
- 契约不强制激活方式；各 harness 须声明自身策略。

---

## 6. 脚本 / 资源（可选，环境绑定）

- `scripts/` 内脚本由 harness 运行时按需执行；正文中以相对技能目录的路径引用
  （如 `skills/<name>/scripts/xxx` 或 `${SKILL_DIR}/scripts/xxx`）。
- `references/` 文档由 harness 在技能触发后按需读入上下文（渐进式披露）。
- `assets/` 由 harness 自行决定如何消费。
- harness 须自行决定是否提供执行通道（如 shell 工具）及工作目录对齐；**缺运行时
  须跳过该步骤并如实说明，不得臆造执行结果**。`.md` 正文本身不依赖脚本，保证跨语言
  可移植。

---

## 7. 与其它 agent 生态的互操作（核心）

同一份 `harness-skills/skills/*` **零改动**即可被三边消费，差异仅在发现路径：

| 消费者 | 发现路径 | 激活 | 忽略的字段 |
|---|---|---|---|
| `resolve-tui` | `HARNESS_SKILLS_DIR` 指向本仓库 `skills/`（建议 submodule） | 自适应（§5） | `allowed-tools` 等 |
| Claude Code | 软链/复制 `skills/` → `~/.claude/skills/` | 模型自选（`description`） | `triggers` 等 |
| OpenAI Codex | 放 `skills/` → `~/.codex/skills/`，或 `config.toml` 加 `[[skills.config]] { path = "/abs/.../SKILL.md" }` | 模型自选（`description`） | `triggers`/`version` 等 |

- Claude Code / Codex 均**只读取 `name` + `description`** 做路由，正文触发后才加载；
  我们文件里若带了 `triggers` / `version` 等扩展键，它们会忽略——无需改动文件。
- 因此「跨项目迁移」= 把 `skills/` 目录放到对应工具的发现路径下，或让 harness 指向它。

---

## 8. 版本与兼容

- 本契约版本见文首 `spec-version`。
- loader 应声明其支持的 `spec-version`。
- 兼容原则：**只新增可选字段**，不改 `name` / `description` / body 语义；**未知键忽略**。
  旧 loader 遇未知字段须忽略而非报错。

---

## 9. 校验（参考 loader 提供）

- `loaders/<lang>/` 下提供解析器与单测，fixtures 直接取自本仓库 `skills/`。
- **JSON Schema 必须 `additionalProperties: true`**（允许未知键），字段集 = 标准 ∪ 扩展。
  必填：`name`、`description`；`name` 必须等于目录名（CI 校验）。
- 建议 CI 对所有 `skills/*/SKILL.md` 跑解析校验，保证集合始终符合契约。

---

## 10. 本仓库内容

- `SKILL_SPEC.md` —— 本契约。
- `skills/` —— 种子技能集合（已符合本规范，且 `name` == 目录名）：
  - `code-review/`
  - `post-comment/`
  - `weekly-investment-review/`
- `loaders/` —— 各语言薄 loader（待契约定稿后实现）：
  - `loaders/rust/`（供 `resolve-tui`）
  - `loaders/python/`（供 `resolve-harness`）
- `schema/skill.schema.json` —— 可选 frontmatter 校验（须 `additionalProperties: true`）。
