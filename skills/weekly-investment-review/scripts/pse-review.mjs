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

// 校验产物是否可用：agnes 偶发卡死，可能写出空/残缺报告。
// 必须同时满足：非空、含核心章节（最终结论/关键发现/建议操作）。
function validateReview(text) {
  const t = (text || '').trim()
  if (t.length < 800) {
    return { ok: false, reason: `内容过短（${t.length} 字符），agnes 疑似中途卡死未产出完整报告` }
  }
  const required = ['最终结论', '关键发现', '建议操作']
  const missing = required.filter((k) => !t.includes(k))
  if (missing.length) {
    return { ok: false, reason: `缺少必要章节：${missing.join('、')}（agnes 可能中途卡死）` }
  }
  return { ok: true }
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

async function runPipeline(provider) {
  const runEnv = buildRunEnv(provider)
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
    return { ok: false, phase: 'prepare', detail: truncate(detail, 600) }
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
    return { ok: false, phase: 'run', detail: truncate(tail, 800), stdout }
  }
  // 3) 解析产物路径 → 校验可用性。
  const m = REVIEW_SAVED_RE.exec(stdout)
  if (!m?.[1]) {
    return { ok: false, phase: 'no-file', stdout }
  }
  let review = ''
  try {
    review = await readFile(m[1], { encoding: 'utf8' })
  } catch {
    return { ok: false, phase: 'read', path: m[1], stdout }
  }
  const v = validateReview(review)
  if (!v.ok) return { ok: false, phase: 'invalid', reason: v.reason, path: m[1], review, stdout }
  return { ok: true, path: m[1], review }
}

async function pseReview(requestedProvider) {
  const provider = requestedProvider === 'deepseek' ? 'deepseek' : 'agnes'
  let res = await runPipeline(provider)
  let fellBack = false
  // agnes 抽风（产物不可用）→ 自动切 deepseek（付费）兜底，保证出报告。
  if (!res.ok && provider === 'agnes') {
    fellBack = true
    res = await runPipeline('deepseek')
  }
  const usedPaid = provider === 'deepseek' || fellBack
  const paidNotice = usedPaid
    ? '\n⚠️ 注意：本次使用了 DeepSeek（付费模型）运行 PSE 深度分析，将产生 API 费用（约 ¥0.1–1/次）。\n'
    : ''
  if (usedPaid) console.error(paidNotice.trim())
  if (!res.ok) {
    const fb = fellBack
      ? '⚠️ agnes 本次抽风（产物不可用），已自动尝试 DeepSeek（付费）但同样失败。'
      : ''
    const detail = res.phase === 'invalid' ? res.reason : res.stdout || res.detail || '(no output)'
    return truncate(
      `${fb}${paidNotice}⚠️ 本次 PSE 分析失败（agnes 与 deepseek 均不可用）。\n\n${truncate(detail, 1200)}`,
      MAX_OUTPUT,
    )
  }
  const rel = await copyReviewToSandbox(res.path, res.review)
  const fb = fellBack
    ? '⚠️ agnes 本次抽风（产物不可用），已自动切换到 DeepSeek（付费）生成报告。\n'
    : ''
  return truncate(
    `${fb}${paidNotice}> PSE review 已保存（预览副本）：${rel}\n> 原始路径：${res.path}\n\n${res.review}`,
    MAX_OUTPUT,
  )
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
        '默认 provider="agnes"（免费）；若 agnes 抽风（产物经校验不可用），工具会自动切换到 deepseek（付费、稳定，约 ¥0.1–1/次）兜底并明确提示。' +
        '也可显式指定 provider="deepseek" 直接用付费模型。',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['agnes', 'deepseek'],
            description: "模型来源：agnes（免费，默认；抽风时工具自动切 deepseek 兜底）或 deepseek（付费、稳定，约 ¥0.1–1/次）。默认按 PSE_REVIEW_PROVIDER 环境变量，缺省 'agnes'（免费）。",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async run(args) {
        const raw = args.provider || process.env.PSE_REVIEW_PROVIDER || 'agnes'
        return pseReview(raw === 'deepseek' ? 'deepseek' : 'agnes')
      },
    },
  ],
})