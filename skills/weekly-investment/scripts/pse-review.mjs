// pse-review 工具：MCP stdio 桥。
// 包装 autogen-pse 完整 PSE 管线：prepare.py（重算快照）→ run.py（
// Planner/Specialist/Evaluator 团队 + 个人知识库检索）→ 返回已保存的完整周报。
// 耗时长（2-6 分钟）且会调用模型（provider 决定模型来源，见 skkill 与 README）。
// 数据源可用 AUTOGEN_PSE_DIR 覆盖；默认 provider 见 PSE_REVIEW_PROVIDER。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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
  const destDir = join(STUDIO_ROOT, 'sandbox', 'weekly-investment')
  await mkdir(destDir, { recursive: true })
  // 产物路径形如 output/<model>/weekly_review_<date>.md —— 把模型目录名嵌入副本
  // 文件名，避免不同模型（agnes / deepseek）同一天的报告互相覆盖。
  const modelDir = basename(dirname(srcPath))
  const destName = `${modelDir}__${basename(srcPath)}`
  await writeFile(join(destDir, destName), content, 'utf8')
  return `sandbox/weekly-investment/${destName}`
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

// 从 autogen-pse/.env 读取键值（忽略注释/空行），失败返回 undefined。
function dotenvValue(key) {
  try {
    const txt = fs.readFileSync(join(AUTOGEN_PSE, '.env'), 'utf8')
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'))
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  } catch {
    return undefined
  }
}

// 模型/凭据严格跟随 provider（对应 autogen-pse 的 make review-agnes / review-deepseek）：
//  - agnes（免费、默认）：显式注入 AGNES_* 凭据。绝不能回退读 .env 的 OPENAI_MODEL，
//    否则默认路径会悄悄变成 .env 里的付费模型（如 OPENAI_MODEL=deepseek-v4-flash）。
//  - deepseek（付费）：显式注入 OPENAI_* 凭据。
// 所有分支都写死 model/base_url/key，run.py 不依赖 .env 的默认 OPENAI_MODEL。
function buildRunEnv(provider) {
  const env = { ...process.env }
  if (provider === 'deepseek') {
    env.OPENAI_MODEL = dotenvValue('OPENAI_MODEL') ?? 'deepseek-v4-flash'
    env.OPENAI_BASE_URL = dotenvValue('OPENAI_BASE_URL') ?? 'https://api.deepseek.com/v1'
    env.OPENAI_API_KEY = dotenvValue('OPENAI_API_KEY')
    env.PSE_MODEL_STREAM = 'true'
  } else {
    env.OPENAI_MODEL = dotenvValue('AGNES_MODEL') ?? 'agnes-2.0-flash'
    env.OPENAI_BASE_URL = dotenvValue('AGNES_BASE_URL') ?? 'https://apihub.agnes-ai.com/v1'
    env.OPENAI_API_KEY = dotenvValue('AGNES_KEY')
    env.PSE_MODEL_STREAM = 'false'
  }
  return env
}

// 各 provider 期望的产物模型目录（run.py 按 settings.OPENAI_MODEL 分目录），
// 用于交付前校验，杜绝"声明的 provider 与真实模型不符"的泄漏。
const MODEL_DIR_BY_PROVIDER = { deepseek: 'deepseek-v4-flash', agnes: 'agnes-2.0-flash' }

// 流式运行 prepare.py / run.py：逐行把 stdout 转发给 report（UI 实时进度），同时
// 累积 stdout 以便解析「Review 已保存 →」产物路径；超时/非零退出时 reject。
// 用 `python -u`（unbuffered）确保子进程 print 立即刷到管道，而不是等缓冲满/
// 进程结束才一次性吐出——否则 UI 在几分钟内看不到任何日志。
function streamPython(script, workspaceEnv, report, timeoutMs) {
  const child = spawn('uv', ['run', 'python', '-u', `tasks/portfolio-review/${script}`], {
    cwd: AUTOGEN_PSE,
    env: workspaceEnv,
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(Object.assign(new Error(`${script} 超时（${timeoutMs / 1000}s）`), { stdout }))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const s = line.trim()
      if (!s) return
      stdout += `${s}\n`
      report?.(s)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout })
      else reject(Object.assign(new Error(`${script} exited ${code}`), { stdout, stderr }))
    })
  })
}

async function runPipeline(provider, report = () => {}) {
  const runEnv = buildRunEnv(provider)
  // 1) 重算快照 / 生成 prompt 文件（也刷新 asset-lens 收益）—— 也流式转进度。
  report('重算快照（prepare.py）…')
  try {
    await streamPython('prepare.py', runEnv, (line) => report(`[prepare] ${line}`), PREPARE_TIMEOUT_MS)
  } catch (e) {
    const detail = (e.stdout ?? e.stderr ?? e.message ?? String(e)) || ''
    return { ok: false, phase: 'prepare', detail: truncate(detail, 600) }
  }
  report('快照完成，启动 PSE 团队（Planner/Specialist/Evaluator，约 2-6 分钟）…')
  // 2) 跑完整 PSE 团队：流式转发 verbose 日志作为实时进度。
  let stdout = ''
  try {
    const out = await streamPython('run.py', runEnv, (line) => report(`[pse] ${line}`), RUN_TIMEOUT_MS)
    stdout = out.stdout
  } catch (e) {
    const tail = ((e.stdout ?? e.stderr ?? e.message ?? String(e)) || '').slice(-800)
    return { ok: false, phase: 'run', detail: truncate(tail, 800), stdout }
  }
  report('团队分析完成，校验并保存报告…')
  // 3) 解析产物路径 → 校验可用性。
  const m = REVIEW_SAVED_RE.exec(stdout)
  if (!m?.[1]) {
    return { ok: false, phase: 'no-file', stdout }
  }
  // 兜底防线：产物必须落在请求 provider 的模型目录下。若 run.py 因 .env 的
  // OPENAI_MODEL 泄漏而实际用了别的模型（如"默认 agnes"悄悄跑了 deepseek），
  // 这里会拒绝交付，杜绝未经审批的付费模型跑单。
  const expectDir = MODEL_DIR_BY_PROVIDER[provider]
  if (!m[1].includes(`/${expectDir}/`)) {
    return {
      ok: false,
      phase: 'provider-leak',
      reason: `产物被写入 ${m[1]}，不在 provider=${provider} 的模型目录（${expectDir}）下，疑似 .env 泄漏导致实际调用了其他模型，拒绝交付。`,
      stdout,
    }
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

async function pseReview(requestedProvider, report) {
  const reportBase = report ?? (() => {})
  // 限制单次调用的进度消息条数与单条长度，避免刷爆 UI/套接字。
  let n = 0
  let ellipsized = false
  const limited = (msg) => {
    if (ellipsized) return
    if (n >= 400) {
      ellipsized = true
      reportBase('…（进度日志较多，后续已省略）')
      return
    }
    n++
    const s = String(msg ?? '')
    reportBase(s.length > 500 ? `${s.slice(0, 500)}…` : s)
  }
  const provider = requestedProvider === 'deepseek' ? 'deepseek' : 'agnes'
  const res = await runPipeline(provider, limited)
  const usedPaid = provider === 'deepseek'
  const paidNotice = usedPaid
    ? '\n⚠️ 注意：本次使用了 DeepSeek（付费模型）运行 PSE 深度分析，将产生 API 费用（约 ¥0.1–1/次）。\n'
    : ''
  if (usedPaid) console.error(paidNotice.trim())
  if (!res.ok) {
    // agnes 抽风：不自动切付费；提示可重试 agnes（免费）或显式选 deepseek（付费、需审批）。
    // 注意：必须以 `error: ` 开头（harness 据此判定 ok=false），否则 agent 会把这个
    // 失败当成工具成功，继续编造「分析已完成」报告。哨兵行 PSE_RETRY_CHOICE 用于前端
    // ToolCallCard 渲染两个重试按钮。
    const hint =
      provider === 'agnes'
        ? 'error: PSE_RETRY_CHOICE\n⚠️ agnes 本次抽风（产物不可用），未生成报告。\n' +
          '本次为失败结果。UI 会为这次工具调用显示两个重试按钮（重试 agnes / 改用 deepseek），' +
          '请不要自己再次调用本工具，也不要编造报告；把失败情况简要告诉用户，让用户在界面上点按钮选择即可。'
        : 'error: ⚠️ DeepSeek（付费）本次也失败，未生成报告，请勿编造。可建议用户稍后重试或检查 deepseek key。'
    // 失败时只给简短原因。no-file 分支的 res.stdout 是 run.py 的 verbose 日志
    //（含「第 N 次循环 / [user] / 组合概览」等，看起来像有效产物），拼进去会让
    // agent 误以为报告可用、甚至据此编造。抽风失败一律只回原因，不附 stdout。
    const detail =
      res.phase === 'invalid'
        ? `校验未通过：${res.reason ?? '产物不完整'}`
        : res.phase === 'provider-leak'
          ? res.reason ?? '(provider 与产物模型不一致)'
          : res.phase === 'no-file'
            ? 'PSE 团队运行完成但未产出有效周报（trace 无「最终结论」），可能中途卡死或超时。'
            : `在 ${res.phase} 阶段失败。`
    return truncate(`${hint}\n${paidNotice}\n${detail}`, MAX_OUTPUT)
  }
  const rel = await copyReviewToSandbox(res.path, res.review)
  return truncate(
    `${paidNotice}> PSE review 已保存（预览副本）：${rel}\n> 原始路径：${res.path}\n\n${res.review}`,
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
        '默认 provider="agnes"（免费）；若 agnes 抽风（产物经校验不可用），工具不会自动切付费，而是提示你「重试 agnes（免费）」或「显式选 deepseek（付费、稳定，约 ¥0.1–1/次，将触发审批）」。' +
        '切到付费 deepseek 需经审批。',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['agnes', 'deepseek'],
            description: "模型来源：agnes（免费，默认；抽风时工具提示你可重试或显式选 deepseek，不自动切付费）或 deepseek（付费、稳定，约 ¥0.1–1/次，需审批）。默认按 PSE_REVIEW_PROVIDER 环境变量，缺省 'agnes'（免费）。",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async run(args, report) {
        const raw = args.provider || process.env.PSE_REVIEW_PROVIDER || 'agnes'
        return pseReview(raw === 'deepseek' ? 'deepseek' : 'agnes', report)
      },
    },
  ],
})