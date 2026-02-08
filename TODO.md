# PR #6 修复清单

- [x] 修复 `wemp_draft list` 返回字段映射错误（`src/tools.ts`）
- [x] 修复配置 Schema 与现有配置项不兼容问题（`src/config-schema.ts`）
- [x] 修复工具配置检查逻辑（避免 `resolveWechatMpAccount` 恒真导致误判）
- [x] 修正 Agent 工具注册日志文案（5 -> 7）
- [x] 运行验证并记录结果（`npm install` 两次均因 `ECONNRESET` 失败，未能完成本地构建验证）
