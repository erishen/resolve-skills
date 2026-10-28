---
name: article-write
description: 用 crewai-pse 三角色流水线（Planner/Specialist/Evaluator）为 projects.json 里的某一个项目生成中英双语技术文章，并自动落盘到文章目录。当用户说「写一篇技术文章」「生成 XX 项目的文章」「帮我把 alva-e2e 写成文章」时使用；若未指定项目，先列出候选让用户选一个。
---

# article-write 技能

本技能封装 `article-write` 工具：用 crewai-pse 三角色流水线为 **projects.json 里的一个项目** 生成中文技术文章，并自动翻译为英文，落盘到文章目录（中文 `zh/`、英文 `en/`）。

## 使用方式

1. 若用户**未指定项目**，调用 `article-write` 工具**不带 `project` 参数**，工具会返回候选项目列表；把这列表呈现给用户，让其**选一个**。
2. 用户选定后，调用 `article-write` 工具并传入 `project=<项目名>`。可选参数：
   - `publish`（布尔，默认 false）：生成后是否自动发布到 WordPress；
   - `style`（A–F，默认自动轮转）：叙事风格；
   - `provider`（`free` 默认 / `deepseek` 付费）：模型提供方，选 `deepseek` 会触发人工审批。
3. **一次只写一个项目**的文章；不要循环枚举、不要一次给多个项目批量生成。
4. 工具返回中文文章全文与保存路径；把保存路径反馈给用户即可。

## 注意

- 该流水线较长（3–10 分钟，大项目可能到 20–30 分钟，会多次调用 LLM），请耐心等待，不要中途重试或并发调用。
- 不要在调用前自行读取 projects.json 或项目目录——工具内部已处理所有路径与配置，自行读取在容器/沙箱环境下会失败。
- 若工具返回 `unknown project` 或 `exit code 1`，把错误信息原样反馈给用户，让其核对 projects.json 配置即可。
