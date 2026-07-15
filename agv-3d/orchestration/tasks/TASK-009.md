---
id: TASK-009
title: 展示四类节点
dependsOn:
  - TASK-005
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
  - 在本地浏览器中确认四类节点的形状、颜色、朝向和批次数量
---

# TASK-009 — 展示四类节点

## 需求

地图必须完整展示四类节点，并通过低面数形状、颜色和朝向让用户在沙盘视角中快速区分节点用途与方向。

## 验收标准

- 1768 个节点全部可见且无重复：普通节点为蓝色低面数立方体，工作节点为青色楔形，充电节点为黄色单侧尖端六棱柱，停车节点为绿色切角长方体。
- 四类节点分别使用 `hsl(210, 90%, 60%)`、`hsl(180, 90%, 55%)`、`hsl(48, 100%, 60%)`、`hsl(140, 80%, 55%)` 的基础色。
- 工作、充电和停车节点的模型尖端在 `0、π/2、-π/2、π` 四个基准角下方向正确，普通节点不表达方向。
- 所有节点底部均位于地面上方，不穿透地面，并保持约 0.5 m 的基准宽度和真实比例。
- 节点展示固定为四批，静态运行期间不因相机距离重新分组，也不出现名称、图例、悬停或点击交互。
