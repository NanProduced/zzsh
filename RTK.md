# RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands.

## Rule

优先对 RTK 支持的外部 CLI 使用 `rtk`；PowerShell cmdlet、变量赋值和控制流正常执行，不机械加前缀。

需要完整错误、精确源码、JSON、哈希或机器解析输出时，使用 `rtk proxy <cmd>` 或原命令，避免过滤丢失证据。RTK 不改变命令授权范围，也不是敏感信息脱敏工具。

本文件由官方 `rtk init --codex` 生成后适配本项目。Codex 使用 AGENTS.md 引用；没有安装全局自动改写 hook，不要因提示缺少 hook 就修改用户全局设置。

Examples:

```bash
rtk git status
rtk cargo test
rtk npm run build
rtk pytest -q
```

## Meta Commands

```bash
rtk gain            # Token savings analytics
rtk gain --history  # Recent command savings history
rtk proxy <cmd>     # Run raw command without filtering
```

## Verification

```bash
rtk --version
rtk gain
Get-Command rtk  # PowerShell
```

官方来源：https://github.com/rtk-ai/rtk 。本机初始化时 RTK 版本为 0.45.0；其他机器先验证安装，不强制同版本。
