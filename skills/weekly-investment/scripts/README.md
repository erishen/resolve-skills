# weekly-investment 工具桥（MCP stdio）

本技能依赖两个**本地私有数据**工具：`portfolio-check`（投资前数据体检）与
`pse-review`（深度 PSE 周报）。为了让任意 harness（resolve-tui / Claude Code /
Codex）都能拿到这组工具，这里用**零依赖 Node MCP stdio server** 把它们桥接出来——
共用同一个数据源 autogen-pse / asset-lens，与 resolve-studio 插件的取数逻辑一致。

> 注：原 `portfolio-summary`（快速摘要）已并入 `pse-review`——`pse-review` 内部
> 会先重算快照（prepare.py）再跑 PSE 三角色，摘要数据包含在周报里，无需单独取数工具。

## 文件

| 文件 | 作用 |
|---|---|
| `lib-mcp.mjs` | 零依赖 MCP stdio 协议骨架（JSON-RPC 2.0，支持 progress 通知） |
| `portfolio-check.mjs` | 工具 `portfolio-check`：在 asset-lens 跑 `make calculate / analyze / compare` 刷新快照并扫描异常（只读，耗时 1-3 分钟） |
| `pse-review.mjs` | 工具 `pse-review`：`prepare.py` + `run.py` 出完整 PSE 周报（2-6 分钟，会调模型；免费默认模型偶发抽风时返回 `error: PSE_RETRY_CHOICE` 供 UI 渲染重试选项） |

依赖：`node >= 18`、`uv`、autogen-pse 项目（含 `tasks/portfolio-review/`）。

数据源定位：默认从脚本位置向上找 `frameworks/autogen-pse`；可用 `AUTOGEN_PSE_DIR`
环境变量显式指定。

## 注册到各 harness

### resolve-tui

在 resolve-tui 的 config.toml（`$HARNESS_CONFIG` 或 `<配置目录>/resolve-tui/config.toml`）
加两段（脚本路径换成你机器上的实际路径）：

```toml
[mcp_servers.portfolio-check]
command = "node"
args = ["/你的路径/work/harness/resolve-skills/skills/weekly-investment/scripts/portfolio-check.mjs"]

[mcp_servers.pse-review]
command = "node"
args = ["/你的路径/work/harness/resolve-skills/skills/weekly-investment/scripts/pse-review.mjs"]
env = { PSE_REVIEW_PROVIDER = "default" }   # 可选：省略或填 "default" 走免费默认 OpenAI 兼容网关；"deepseek" 走付费模型
```

启动后 `resolve-tui` 会连上这两个 server，工具以 `mcp_<server>_<tool>` 暴露给模型。

### Claude Code

项目 `.mcp.json`（`mcpServers`）加：

```json
{
  "mcpServers": {
    "portfolio-check": {
      "command": "node",
      "args": ["/你的路径/.../scripts/portfolio-check.mjs"]
    },
    "pse-review": {
      "command": "node",
      "args": ["/你的路径/.../scripts/pse-review.mjs"]
    }
  }
}
```

### Codex / 其它支持 MCP stdio 的工具

同样注册一个 stdio server，command = `node`，args = 上述 `.mjs` 绝对路径。

## 隐私红线

`portfolio-check` / `pse-review` 的输出含**真实持仓、金额、收益率**。仅供本地私有
使用：不要把摘要/周报原样外发、写入公开仓库。周报生成过程对 `deepseek` 提供商会产生
模型费用（读取 autogen-pse/.env 的 key）；默认由免费默认 OpenAI 兼容网关提供，无费用。

## 直接调试

```bash
# 单次调用：给 server 发一条 tools/call
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pse-review","arguments":{}}}' \
  | node scripts/pse-review.mjs
```
