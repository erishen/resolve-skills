// 零依赖 MCP stdio server 骨架：JSON-RPC 2.0，按行走 stdin/stdout。
// 实现 resolve-tui / Claude Code / Codex 的 MCP 客户端共用的最小子集：
//   initialize · notifications/initialized（忽略）· ping · tools/list · tools/call
// 不依赖 node_modules，任何 node>=18 均可直接运行。

import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

/**
 * 启动一个 stdio MCP server。
 * @param {object} spec
 * @param {string} spec.name              server 名
 * @param {string} spec.version           server 版本
 * @param {Array<{name:string,description?:string,inputSchema?:object,run:(args:object,report?:(msg:string)=>void)=>Promise<string>}>} spec.tools
 *   run 返回要下发给模型的文本；失败时以 `error: ...` 前缀返回即可（与工具惯例一致）。
 *   run 可选用 `report(msg)` 在长任务执行中发送 `notifications/progress`，让 UI 实时展示进度
 *   （仅当调用方在 _meta.progressToken 里携带 token 时才会真正发送，无 token 则为 no-op）。
 */
export async function runServer(spec) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const listView = spec.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }))

  for await (const raw of rl) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      continue
    }
    // 通知类消息没有 id（initialized / cancelled …），一律忽略。
    if (msg === null || typeof msg !== 'object' || msg.id === undefined) continue
    const id = msg.id
    const method = msg.method
    const params = msg.params ?? {}

    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
    const err = (code, message) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')

    try {
      switch (method) {
        case 'initialize':
          reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: spec.name, version: spec.version },
          })
          break
        case 'ping':
          reply({})
          break
        case 'tools/list':
          reply({ tools: listView })
          break
        case 'tools/call': {
          const tool = spec.tools.find((t) => t.name === params.name)
          if (!tool) {
            err(-32602, `unknown tool: ${params.name}`)
            break
          }
          // 客户端若在 _meta.progressToken 里给了 token，就给 run 提供一个
          // report(msg) 用于发送进度通知（无 token 时为空操作，保持向后兼容）。
          // 注意：MCP SDK 的 ProgressNotificationParamsSchema 要求 progress（number）
          // 必填，因此必须带上自增的 progress，否则客户端按 schema 校验会丢弃该通知。
          const token = params?._meta?.progressToken
          let progressSeq = 0
          const report =
            token !== undefined
              ? (message) =>
                  process.stdout.write(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'notifications/progress',
                      params: {
                        progressToken: token,
                        progress: ++progressSeq,
                        message: String(message),
                      },
                    }) + '\n',
                  )
              : () => {}
          const text = await tool.run(params.arguments ?? {}, report)
          reply({ content: [{ type: 'text', text }], isError: false })
          break
        }
        default:
          err(-32601, `method not found: ${method}`)
      }
    } catch (e) {
      err(-32603, String((e && e.message) || e))
    }
  }
}

/** 截断超长输出，保留 20 字符说明（与 resolve-studio 工具风格一致）。 */
export function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}