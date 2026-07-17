# agv-map-3d — Overlook 地图 3D 复刻（clean-room R3F 工程）

独立、可验证的 React Three Fiber 地图查看器工程基线。本仓库不复用旧系统代码，也不兼容旧类型、旧字段或旧行为。当前为 TASK-001 交付的**空业务基线**：依赖、lockfile、分层目录与验证命令已就绪，尚未实现任何地图业务能力。

## 环境要求

- **Node.js `24.16.0`（精确）**，由 SPEC 3.2 固定。建议用 nvm-windows 管理：
  ```bash
  nvm install 24.16.0
  nvm use 24.16.0
  ```
- 包管理器固定为 **npm**（提交 `package-lock.json`，CI 使用 `npm ci`）。
  - 工程通过 `.nvmrc`、`package.json#engines.node` 与 `preinstall` 脚本三层门禁强制 Node 版本；不符合时 `npm ci` 立即失败。

## 常用命令

```bash
npm ci                 # 依据 lockfile 安装（会先跑 Node 版本门禁）
npm ls --depth=0       # 检查依赖树
npm ls troika-three-text   # 确认 troika 解析统一为 0.52.4
npm run lint           # oxlint 静态检查
npm test -- --run      # vitest 单次运行（不启动浏览器）
npm run build          # tsc -b && vite build
npm run check:layers   # 分层依赖方向验证（SPEC 3.3 自动化证据）
```

`npm test` 仅运行 `tests/unit` 下的纯函数与架构断言，使用 node 环境，不依赖 DOM、WebGL 或浏览器。

## 分层结构（SPEC 3.3）

依赖方向固定为：

```
domain ← adapters / geometry / labels ← application / workers
       ← rendering ← scene / camera / ui
```

- `src/domain` 不依赖 React、R3F、Three 或浏览器 API。
- `src/workers` 不创建任何 Three 资源，只输出可转移的 typed array。
- `src/rendering` 是 typed array → Three 资源的唯一适配层。
- `src/scene/layers` 只消费 `SceneModel`，不解析数据、不拼几何。
- 视觉与性能常量统一由 `src/config` 提供，禁止组件内魔法数字。

分层约束由 `scripts/check-layering.mjs` 与 `tests/unit/architecture.test.ts` 自动校验。

## 版本基线

所有依赖使用精确版本（无 `^`/`~`），`troika-three-text` 通过 `overrides` 强制应用与 drei 解析到同一 `0.52.4`。固定依赖清单见 `package.json` 与 SPEC 3.2。

## 后续

地图数据管线、几何、渲染、相机、标签、字体、视觉与性能基线由后续 TASK 按 `orchestration/SPEC.md` 逐步装配。
