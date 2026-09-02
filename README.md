# resolve-skills

Language-agnostic **Skills (prompt packs)** monorepo. Defines a programming-language-independent contract (see [`SKILL_SPEC.md`](./SKILL_SPEC.md)) aligned with the **Agent Skills** open standard (adopted by Claude Code and OpenAI Codex), so the same `skills/` collection can be consumed by multiple runtimes with zero changes.

## Supported Consumers

| Consumer | Discovery Path | Activation |
|---|---|---|
| `resolve-studio` (TypeScript / Cordis) | `HARNESS_SKILLS_DIR` → this repo's `skills/` | Auto (keyword prefilter / model self-select) |
| `resolve-tui` (Rust) | Same env var | Auto (keyword prefilter / model self-select) |
| `resolve-harness` (Python) | Same env var | Model self-select |
| **Claude Code** | Symlink/copy `skills/` → `~/.claude/skills/` | Model self-select (`description`) |
| **OpenAI Codex** | `skills/` → `~/.codex/skills/`, or `[[skills.config]]` in `config.toml` | Model self-select (`description`) |

## Skills

| Skill | Description | Has Scripts |
|---|---|---|
| [`code-review`](./skills/code-review/SKILL.md) | Review code files and output a structured review report (issue list + severity + suggestions) | ✅ `stats.py` |
| [`post-comment`](./skills/post-comment/SKILL.md) | Pick a random published article on a WordPress site and submit a comment (for testing blog comment/interaction features). Site URL configured via `ERISHEN_BASE` env var. | ✅ `random-comment.mjs` |
| [`rust-review`](./skills/rust-review/SKILL.md) | Review code quality following Rust team conventions | — |
| [`weekly-investment-review`](./skills/weekly-investment-review/SKILL.md) | Generate a local portfolio weekly report. First calls `portfolio-summary` to get a real holdings snapshot (Markdown), then outputs a structured weekly report (portfolio overview / return commentary / risk alerts / rebalancing suggestions) | ✅ `portfolio-summary.mjs`, `pse-review.mjs`, `lib-mcp.mjs` |

## Souls (PSE Tri-Role Personas)

The `souls/` directory contains persona definitions for the **Planner–Specialist–Evaluator (PSE)** three-role mode, aligned with the Agent Skills `SOUL.md` convention:

| Soul | Role |
|---|---|
| [`planner`](./souls/planner/SOUL.md) | Task decomposition, planning, and step orchestration |
| [`specialist`](./souls/specialist/SOUL.md) | Domain-specific execution and deep work |
| [`evaluator`](./souls/evaluator/SOUL.md) | Independent verification, quality gate, and evidence-driven evaluation |

When `PSE_SOULS_DIR` is set (defaults to `HARNESS_SKILLS_DIR/../souls`), the PSE plugin loads these personas to drive the three-role loop.

## Quick Start

### 1. Clone or add as submodule

```bash
git clone https://github.com/your-org/resolve-skills.git
# or, in your harness project:
git submodule add https://github.com/your-org/resolve-skills.git
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
# edit .env with your actual values
```

See [`.env.example`](./.env.example) for all available variables. Key variables:

| Variable | Purpose |
|---|---|
| `HARNESS_SKILLS_DIR` | Path to this repo's `skills/` directory (consumed by all harnesses) |
| `HARNESS_SKILLS_ENV` | Optional: path to a `.env` file to load (overrides cwd `.env`) |
| `PSE_SOULS_DIR` | Optional: path to `souls/` directory (defaults to `HARNESS_SKILLS_DIR/../souls`) |
| `PROD_WORDPRESS_USERNAME` | WordPress username (for `post-comment` skill) |
| `PROD_WORDPRESS_APP_PASSWORD` | WordPress application password (for `post-comment` skill) |
| `ERISHEN_BASE` | Optional: override blog base URL (default `https://example.com` — set to your WordPress site) |
| `AUTOGEN_PSE_DIR` | Optional: override path to autogen-pse (for `weekly-investment-review` skill) |
| `PSE_REVIEW_PROVIDER` | Optional: free default model (OpenAI-compatible gateway) or `deepseek` (paid) for PSE review |

> **Privacy**: `.env` is gitignored. Never commit real credentials. `.env.example` contains only placeholders.

### 3. Use with resolve-studio

Set `HARNESS_SKILLS_DIR` in resolve-studio's `.env`:

```env
HARNESS_SKILLS_DIR=/path/to/resolve-skills/skills
```

Restart resolve-studio. The skill index is injected into the system prompt automatically; the model calls `skill-run` to load a skill's full instructions.

### 4. Use with Claude Code

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/resolve-skills/skills/* ~/.claude/skills/
```

Restart Claude Code. Skills appear in the skill list based on their `description`.

## Adding a New Skill

1. Create a directory under `skills/`:
   ```
   skills/my-skill/
   ├── SKILL.md          # required: frontmatter + instructions
   ├── scripts/          # optional: helper scripts
   ├── references/       # optional: reference docs
   └── assets/           # optional: static assets
   ```

2. Write `SKILL.md` with required frontmatter:
   ```markdown
   ---
   name: my-skill
   description: One-line description of when to use this skill
   ---

   # My Skill

   Step-by-step instructions...
   ```

3. (Optional) Add helper scripts under `scripts/`. Scripts can be any language; the skill instructions tell the model how to invoke them.

4. Test with your harness of choice.

See [`SKILL_SPEC.md`](./SKILL_SPEC.md) for the full contract specification.

## Directory Structure

```
resolve-skills/
├── SKILL_SPEC.md              # Language-agnostic contract (aligned with Agent Skills standard)
├── README.md                  # This file
├── README.zh.md               # Chinese documentation
├── .env.example               # Environment variable template (copy to .env)
├── skills/                    # Skill collection
│   ├── code-review/           # Code review skill
│   │   ├── SKILL.md
│   │   └── scripts/stats.py
│   ├── post-comment/          # Blog comment skill
│   │   ├── SKILL.md
│   │   └── scripts/random-comment.mjs
│   ├── rust-review/           # Rust code review skill
│   │   └── SKILL.md
│   └── weekly-investment-review/  # Portfolio weekly report skill
│       ├── SKILL.md
│       └── scripts/
│           ├── lib-mcp.mjs         # Zero-dep MCP stdio server skeleton
│           ├── portfolio-summary.mjs # MCP bridge: portfolio summary
│           └── pse-review.mjs       # MCP bridge: full PSE review
└── souls/                     # PSE tri-role personas
    ├── planner/SOUL.md
    ├── specialist/SOUL.md
    └── evaluator/SOUL.md
```

## License

MIT
