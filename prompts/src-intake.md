---
description: 新 SRC 目标 intake / 范围闸门
argument-hint: "<target> [scope-notes]"
model: gpt-5.4
thinking: medium
restore: true
---
你现在只做 SRC intake，不做验证、不做攻击。

请基于以下目标建立一个简洁的授权测试简报：
$@

必须输出：
- 目标与资产类型
- 已知授权前提 / 未知前提
- 是否涉及登录态 / 邀测账号 / 白名单 / 速率限制
- 明确禁止动作与高风险动作
- 适合先走的侦察路线
- 为下一步 `/src-recon` 需要补充的资料
