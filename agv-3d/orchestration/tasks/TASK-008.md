---
id: TASK-008
title: 呈现加载进度与统一错误界面
dependsOn:
  - TASK-007
scope:
  allow:
    - src/**
    - test/**
    - package.json
    - pnpm-lock.yaml
  deny:
    - .env*
gates:
  - name: build
    command: pnpm
    args:
      - build
    timeoutMinutes: 15
  - name: lint
    command: pnpm
    args:
      - lint
    timeoutMinutes: 10
manualAcceptance:
  - 在本地浏览器中确认加载阶段、进度和错误界面符合验收标准
---

# TASK-008 — 呈现加载进度与统一错误界面

## 需求

用户在地图准备期间必须持续看到真实阶段和整数进度；任一失败必须切换到清晰、一致的错误界面。加载中或失败时不得展示不完整地图，也不得提供自动重试或其他实现分支。

## 验收标准

- 加载界面只显示当前阶段的简体中文名称和整数百分比，显示值与加载状态一致且从不倒退。
- 下载、解析、校验、节点编译、路径编译、场景创建和淡入阶段均有明确可辨识的显示文案。
- 错误界面显示稳定错误码、发生阶段和简短中文说明，详细字段路径可在开发日志中定位。
- 进入错误状态后不显示节点、路径或半成品场景，不跳过坏数据，不自动重试，也不展示兼容或降级入口。
- 正常加载和每一种稳定错误类型都能通过可控输入进行验证。
