---
description: 针对单个 SRC 假设做最小化验证
argument-hint: "<hypothesis-or-endpoint>"
model: gpt-5.4
thinking: high
subagent: src-validator
inheritContext: true
restore: true
---
请只验证一个 SRC 假设，不要扩散到其他点：
$@

要求：
- aboutsecurity 先行
- 最小化、低影响、非破坏
- 给出明确 verdict 和证据
