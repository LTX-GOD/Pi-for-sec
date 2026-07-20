---
name: src-flow
description: |
  SRC 授权目标完整渗透流程：recon -> hypothesis -> report。
  适用于"完整走一遍"的 SRC 长流程目标。
---

> ⚠️ **本 chain 只是骨架，不含派发契约字段**（output / outputMode / acceptance / control / async）。
> 生产 SRC 编排**不要用 `/run-chain src-flow`**，请按 `prompts/SRC.md` 的「编排契约」手动顺序调用 subagent，
> 每步都套用路由 1 的完整契约模板（task 第一位 + output + outputMode + acceptance + async + control）。
> 这个 chain 仅作流程顺序参考。

## src-recon

对目标做信息收集与攻击面梳理，输出候选假设。

目标信息：
{previous}

要求：
- aboutsecurity 先行，查方法论/指纹/PoC
- 低影响、非破坏
- 输出 Surface Map + Candidate Hypotheses

## src-hypothesis

基于上一步 recon 结果，对全部资产生成假设并直接深度渗透执行，产出 confirmed findings。

上一个 step 的结果：
{previous}

要求：
- aboutsecurity 先行，查方法/PoC/payload
- 有授权，主动测试：发 payload、跑 Nuclei、测 CVE/未授权/IDOR/SSRF
- 用 Burp MCP 发精确测试请求，用 Collaborator 测 OOB
- 深挖到出证据/复现链，不停在"确认指纹"
- 输出 confirmed findings（带证据+复现步骤）

## src-report-writer

将 confirmed findings 整理成报告草稿。

上一个 step 的结果：
{previous}
