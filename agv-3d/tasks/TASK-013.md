---
id: TASK-013
title: 完成色彩输出与后处理
dependsOn:
  - TASK-009
  - TASK-010
  - TASK-012
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
  - 在本地浏览器中确认色彩、Bloom、SMAA 与基础拓扑清晰度
---

# TASK-013 — 完成色彩输出与后处理

## 需求

最终画面必须以统一的标准色彩输出、电影化色调映射和单一后处理链呈现，使关键节点与流光获得可控辉光，同时保持基础路径和背景清晰、不整体发糊。

## 验收标准

- 输出使用标准 sRGB 色彩空间、电影化色调映射和 1.0 初始曝光，四类节点及路径颜色与既定调色板一致。
- 后处理顺序固定为 Bloom 后接 SMAA，主画布和后处理不叠加额外多重采样或第二套抗锯齿。
- Bloom 的亮度阈值为 1.0、平滑度为 0.2、强度为 1.1，并启用多级纹理模糊。
- 充电和停车节点明确产生辉光，工作节点接近阈值，普通节点与基础路径低于阈值，流动高亮明确高于阈值。
- 背景和基础路径不会整体发亮或发糊，反射、网格、雾和节点轮廓在后处理后仍清晰可辨。
