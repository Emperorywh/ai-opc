---
id: TASK_001
title: 项目脚手架与依赖
status: draft
phase: 0
depends_on: []
files:
  - package.json
  - vite.config.ts
  - src/App.tsx
  - src/main.tsx
  - public/maps/sample.json
---

# TASK_001 · 项目脚手架与依赖

## 目标
为 Phase 1 铺设地基：装齐运行时/测试依赖，清掉 Vite 默认模板 UI，让 `pnpm dev` 启动后看到「深色背景 + 一个空 `<Canvas>`」，并把真实样例数据放到 `public/maps/sample.json` 供后续 fetch。

## 前置依赖
无。

## 涉及文件
- `package.json`（改：加 `@react-three/drei`、`vitest`；加 `test` script）
- `vite.config.ts`（改：挂 vitest 的 `test` 配置）
- `src/App.tsx`（改：替换为空 `<Canvas>` + 深色背景）
- `src/main.tsx`（可能微调，去掉无用 import）
- `public/maps/sample.json`（新建：从 `src/json/getMapInfo.json` 复制）
- 可删：`src/App.css`、`src/assets/*`（模板残留）

## 实现要点
1. `pnpm add @react-three/drei`（确保解析到 v10+，与 `@react-three/fiber@9` / `three@0.185` / `react@19` 兼容）；`pnpm add -D vitest`。
2. `vite.config.ts`：引入 `vitest/config`，`defineConfig` 改为接受 `test` 字段（`environment: 'node'` 即可，纯逻辑测试不需 jsdom）。备注：`node` 环境仅覆盖纯逻辑模块（loader / bezier / laneOffset / geometry / arrows）；后续若要单测 React 层组件，再单独引入 `jsdom`，Phase 1 不需要。
3. `package.json` `scripts` 加 `"test": "vitest run --passWithNoTests"`、`"test:watch": "vitest"`，确保 TASK_001 尚无测试文件时测试门禁仍可稳定通过。
4. 复制样例：`src/json/getMapInfo.json` → `public/maps/sample.json`（内容完全一致，后续 fetch 用）。
5. `src/App.tsx` 重写为最小骨架：
   - `<Canvas>` 占满视口；通过 R3F 的 `onCreated` 或 `<color attach="background" args={[palette.bg]} />` 设背景（颜色硬编码 `#0a0e1a` 临时即可，TASK_003 再抽到 palette）。
   - 外层 `#root`/`body` 的 CSS 改为全屏（`width:100vw;height:100vh;margin:0`），避免模板 1126px 居中布局残留。
6. 删除模板资产 `src/App.css`、`src/assets/react.svg`、`src/assets/vite.svg`、`src/assets/hero.png` 及其引用。

## 约束
- 遵守 PLAN §3 全局约束（无 enum、`import type`、无未用变量）。
- 不引入 zustand；本 task 不写 Context（留 TASK_003）。
- 不写业务渲染，仅空 Canvas。

## 验证步骤
1. `pnpm install` 成功，无 peer 警告（或仅有可接受的 minor 警告）。
2. `pnpm dev`：浏览器打开，全屏深色背景（`#0a0e1a`），无报错；Canvas 存在（页面无模板内容）。
3. `pnpm build`：`tsc -b && vite build` 通过。
4. `pnpm lint`：oxlint 通过。
5. `pnpm test`：vitest 可运行；无测试用例时因 `--passWithNoTests` 正常退出，exit 0。

## 完成定义 (DoD)
- 依赖装齐，dev/build/lint/test 四项门禁全绿。
- `public/maps/sample.json` 与源 JSON 一致（可用 `diff` 验证）。
- 页面呈现全屏深色空 Canvas，无模板残留。

## 风险/备注
- 若 drei 安装报 peer 冲突，优先核对 three/fiber/react 版本对齐表，不要随意降 major。
- 此 task 完成后 `main` 即为「可运行的空场景」基线，后续所有渲染 task 在此之上叠加。
