---
id: TASK-014
title: 保证场景创建与资源释放原子性
dependsOn:
  - TASK-006
  - TASK-007
  - TASK-011
  - TASK-013
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
  - 在本地浏览器中重复挂载和卸载，确认资源计数恢复到基线
---

# TASK-014 — 保证场景创建与资源释放原子性

## 需求

完整编译结果必须以确定步骤创建为可展示场景。创建过程要么全部成功，要么释放所有已创建资源并进入统一错误状态；正常卸载也必须恢复到加载前资源基线。

## 验收标准

- 场景创建按确定步骤将总进度从 90% 推进到 98%，进度与已成功完成的资源步骤对应且不倒退。
- 任一场景资源创建失败都进入 `WEBGL_RESOURCE_FAILED`，不显示半成品场景，并释放本次已经创建的全部资源。
- 正常卸载后，几何、材质、纹理、环境反射资源和平面反射目标全部释放，渲染资源计数回到加载前基线。
- 开发期重复挂载和卸载不会产生重复资源、重复监听或单调增长的资源计数。
- 连续执行多次完整加载与卸载后，每次展示的节点、路径和环境结果均与首次一致，空闲时资源计数也保持在同一基线。
