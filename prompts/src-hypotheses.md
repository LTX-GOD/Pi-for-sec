---
description: 从 recon 结果生成假设并直接深度渗透执行，产出 confirmed findings
argument-hint: "<target-or-recon-summary>"
model: gpt-5.4
thinking: high
subagent: src-hypothesis
inheritContext: true
restore: true
---
请基于当前上下文和以下补充信息，对全部资产生成漏洞假设并直接深度渗透执行：
$@

要求：
- aboutsecurity 先行，查方法/PoC/payload
- 有授权，主动测试：发 payload、跑 Nuclei、测 CVE/未授权/IDOR/SSRF
- 用 Burp MCP 发精确测试请求，用 Collaborator 测 OOB
- 深挖到出证据/复现链，不停在"确认指纹"
- 输出 confirmed findings（带证据+复现步骤），不是纯规划
