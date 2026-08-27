// portfolio-summary 工具：MCP stdio 桥。
// 包装 autogen-pse 的 `uv run python tasks/portfolio-review/prepare.py --print`，
// 读取本地真实持仓快照，产出结构化组合摘要 Markdown。
// 注册方法见同目录 README.md。数据源可用 AUTOGEN_PSE_DIR 覆盖。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import { runServer, truncate } from './lib-mcp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 从本文件逐级向上找含 frameworks/autogen-pse 的仓库根，避免写死层级。
// 也可用环境变量 AUTOGEN_PSE_DIR 显式指定。
function findAutogenPse() {
  if (process.env.AUTOGEN_PSE_DIR) return process.env.AUTOGEN_PSE_DIR
  let dir = HERE
  for (let i = 0; i < 14; i++) {
    const cand = join(dir, 'frameworks', 'autogen-pse')
    if (fs.existsSync(join(cand, 'tasks', 'portfolio-review', 'prepare.py'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return join(HERE, 'frameworks', 'autogen-pse')
}

const AUTOGEN_PSE = findAutogenPse()
// 内部会重跑 asset-lens `make calculate`（≤120s），留足余量。
const RUN_TIMEOUT_MS = 150_000
const MAX_OUTPUT = 32 * 1024

const execFileAsync = promisify(execFile)

async function portfolioSummary() {
  try {
    const { stdout, stderr } = await execFileAsync(
      'uv',
      ['run', 'python', 'tasks/portfolio-review/prepare.py', '--print'],
      {
        cwd: AUTOGEN_PSE,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env: process.env,
      },
    )
    if (!stdout.trim()) {
      return `error: portfolio-summary produced empty output${stderr ? ` — stderr: ${truncate(stderr, 500)}` : ''}`
    }
    return truncate(stdout, MAX_OUTPUT)
  } catch (e) {
    const detail = (e.stderr ?? e.message ?? String(e)) || ''
    return `error: portfolio-summary failed — ${truncate(detail, 600)}`
  }
}

runServer({
  name: 'portfolio-summary',
  version: '1.0.0',
  tools: [
    {
      name: 'portfolio-summary',
      description:
        '生成本地投资组合摘要（Markdown）：总资产 / 已实现与未实现收益 / 收益率 / 资产配置 / ' +
        '黄金与房产快照 / 汇率 / 定投审查 / 自动检测问题 / 市场行情 / 投资效率。数据来自 ' +
        'autogen-pse 本地真实持仓快照，内部会重算收益（首选耗时 1-2 分钟）。' +
        '配合 weekly-investment-review 技能输出周报。只读、无审批。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return portfolioSummary()
      },
    },
  ],
})