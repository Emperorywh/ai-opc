---
id: TASK-004
title: 编译完整路径扁带数据
dependsOn:
  - TASK-003
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

# TASK-004 — 编译完整路径扁带数据

## 需求

车道中心线必须被编译为可统一展示的米制路径扁带数据，正确处理直线、曲线和尖锐折角，并为每条有向边保留独立的弧长、流向和顶点范围信息。

## 验收标准

- 扁带宽度为 0.22 m、离地高度为 0.015 m，双向车道沿共享中心线展开，单向车道沿自身中心线展开。
- 普通折角使用连续的斜接效果；斜接长度超过半带宽 2 倍时稳定切换为斜切效果，不产生尖刺、裂缝或不确定结果。
- 每条车道的弧长从自身起点按米单调累计；双向车道使用相反流向值，单向车道流向值为正向。
- 全部位置、法线、弧长、流向和索引均为有限值，索引不越界，相邻三角形不存在由零长度段导致的非法几何。
- 所有路径能够合并为一份展示数据，同时仍可从 3045 条有向边逐一定位对应的顶点区间。
- 相同输入与配置重复编译时得到字节级稳定的路径结果。
