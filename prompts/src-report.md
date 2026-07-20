---
description: 将当前 SRC 证据整理成报告草稿
argument-hint: "[focus]"
model: gpt-5.4
thinking: high
subagent: src-report-writer
inheritContext: true
restore: true
---
请基于当前上下文中的验证结果与证据，整理一份 SRC 报告草稿。

补充 focus：
$@

如果证据不足，也要明确指出缺口与不确定性。
