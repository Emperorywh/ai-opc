---
id: TASK-003
title: 形成稳定的单双向车道分组
dependsOn:
  - TASK-002
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
manualAcceptance: []
---

# TASK-003 — 形成稳定的单双向车道分组

## 需求

所有有向边必须依据反向拓扑关系和几何等价性形成确定性的双向车道组或单向车道组。双向车道分居共享中心线两侧，单向车道保持在自身中心线上，原始审计标记不得改变布局结果。

## 验收标准

- 反向候选按相反的源节点和目标节点唯一匹配，并用 33 个等参数点比较统一方向后的中心线。
- 最大对应点偏差不超过 0.02 m 的反向边组成双向组；双向组方向稳定地从较小节点 ID 指向较大节点 ID。
- 双向组两条车道分别偏移 `+0.18 m` 和 `-0.18 m`，中心间距为 0.36 m，并保留两条有向边各自的 ID 与流动方向。
- 无法配对的边形成偏移量为 0 的单向组，不产生无意义侧移。
- V76 数据产生 998 个双向组和 1049 条未配对单向边，共保留 3045 条有向车道记录。
- 任意修改 `isBackEdge` 后，车道分组、规范方向和偏移结果保持不变。
