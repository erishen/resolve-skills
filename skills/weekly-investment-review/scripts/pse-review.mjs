// pse-review 工具：MCP stdio 桥。
// 包装 autogen-pse 完整 PSE 管线：prepare.py（重算快照）→ run.py（
// Planner/Specialist/Evaluator 团队 + 个人知识库检索）→ 返回已保存的完整周报。
// 耗时长（2-6 分钟）且会调用模型（provider 决定模型来源，见 skkill 与 README）。
// 数据源可用 AUTOGEN_PSE_DIR 覆盖；默认 provider 见 PSE_REVIEW_PROVIDER。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'

import { runServer, truncate } from './lib-mcp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function findAutogenPse() {
  if (process.env.AUTOGEN_PSE_DIR) return process.env.AUTOGEN_PSE_DIR
  let dir = HERE
  for (let i = 0; i < 14; i++) {
    const cand = join(dir, 'frameworks', 'autogen-pse')
    if (fs.existsSync(join(cand, 'tasks', 'portfolio-review', 'run.py'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return join(HERE, 'frameworks', 'autogen-pse')
}

const AUTOGEN_PSE = findAutogenPse()
// Resolve the resolve-studio root (override via RESOLVE_STUDIO_DIR) so we can
// drop a relative-path copy of the report under <studio>/sandbox/... that the
// web UI can preview (within fsRoots).
const STUDIO_ROOT =
  process.env.RESOLVE_STUDIO_DIR ?? resolve(AUTOGEN_PSE, '../../', 'work', 'harness', 'resolve-studio')
async function copyReviewToSandbox(srcPath, content) {
  const destDir = join(STUDIO_ROOT, 'sandbox', 'weekly-investment-review')
  await mkdir(destDir, { recursive: true })
  await writeFile(join(destDir, basename(srcPath)), content, 'utf8')
  return `sandbox/weekly-investment-review/${basename(srcPath)}`
}
const PREPARE_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 480_000
const MAX_OUTPUT = 48 * 1024
// run.py 结束时打印的产物路径标记。
const REVIEW_SAVED_RE = /Review 已保存 →\s*(\S+)/

const execFileAsync = promisify(execFile)

// 模型来源显式化（对应 autogen-pse 的 make review-agnes / review-deepseek）：
//  - agnes：免费、非流式；沿用当前进程 env 里的 agnes 凭据。
//  - deepseek：付费（DeepSeek）；覆盖 model/base_url，并删掉 OPENAI_API_KEY，
//    让 run.py 回退读 autogen-pse/.env 的 deepseek key（cwd=AUTOGEN_PSE）。
function buildRunEnv(provider) {
  const env = { ...process.env }
  if (provider === 'deepseek') {
    env.OPENAI_MODEL = 'deepseek-v4-flash'
    env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
    delete env.OPENAI_API_KEY
    env.PSE_MODEL_STREAM = 'true'
  } else {
    env.PSE_MODEL_STREAM = 'false'
  }
  return env
}

async function pseReview(provider) {
  const runEnv = buildRunEnv(provider)
  const isPaid = provider === 'deepseek'
  const notice = isPaid
    ? '\n⚠️ 注意：本次使用 DeepSeek（付费模型）运行 PSE 深度分析，将产生 API 费用（约 ¥0.1–1/次）。如需免费可选 agnes，但 agnes 在当前多 Agent 流水线无法生成报告。\n'
    : ''
  if (isPaid) console.error(notice.trim())
  // 1) 重算快照 / 生成 prompt 文件（也刷新 asset-lens 收益）。
  try {
    await execFileAsync('uv', ['run', 'python', 'tasks/portfolio-review/prepare.py'], {
      cwd: AUTOGEN_PSE,
      timeout: PREPARE_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      env: runEnv,
    })
  } catch (e) {
    const detail = (e.stderr ?? e.message ?? String(e)) || ''
      return `${notice}error: pse-review prepare step failed — ${truncate(detail, 600)}`
  }
  // 2) 跑完整 PSE 团队。
  let stdout = ''
  try {
    const run = await execFileAsync('uv', ['run', 'python', 'tasks/portfolio-review/run.py'], {
      cwd: AUTOGEN_PSE,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 4 << 20,
      env: runEnv,
    })
    stdout = run.stdout ?? ''
  } catch (e) {
    const tail = ((e.stdout ?? e.stderr ?? e.message ?? String(e)) || '').slice(-800)
      return `${notice}error: pse-review run step failed — ${truncate(tail, 800)}`
  }
  // 3) 优先返回已保存的周报全文，并落一份相对路径副本供 web 预览。
  const m = REVIEW_SAVED_RE.exec(stdout)
  if (m?.[1]) {
    try {
      const review = await readFile(m[1], { encoding: 'utf8' })
      const rel = await copyReviewToSandbox(m[1], review)
        return truncate(
          `${notice}> PSE review 已保存（预览副本）：${rel}\n> 原始路径：${m[1]}\n\n${review}`,
          MAX_OUTPUT,
        )
    } catch {
      // fall through：返回 run 的 stdout
    }
  }
    return truncate(`${notice}${stdout || '(no output)'}`, MAX_OUTPUT)
}

runServer({
  name: 'pse-review',
  version: '1.0.0',
  tools: [
    {
      name: 'pse-review',
      description:
        '运行完整 PSE 投资回顾（autogen-pse 管线）：重算快照后，Planner/Specialist/Evaluator ' +
        '团队 + 个人知识库检索，产出高质量周报全文（Markdown）。耗时 2-6 分钟且会调用模型。' +
        '可选 provider："deepseek"（付费，默认，能生成完整深度报告）或 "agnes"（免费，但在当前多 Agent 流水线无法生成报告）。' +
        '⚠️ 注意：deepseek 为付费模型，运行将产生 API 费用。',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['agnes', 'deepseek'],
            description: "模型来源：deepseek（付费，默认，能生成完整深度报告）或 agnes（免费，但在当前多 Agent 流水线无法生成报告）。默认按 PSE_REVIEW_PROVIDER 环境变量，缺省 'deepseek'（付费）。",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async run(args) {
        const raw = args.provider || process.env.PSE_REVIEW_PROVIDER || 'deepseek'
        return pseReview(raw === 'deepseek' ? 'deepseek' : 'agnes')
      },
    },
  ],
})