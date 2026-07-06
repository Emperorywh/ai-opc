---
id: TASK_002
title: 数据层 types + loader
status: draft
phase: 1
depends_on: [TASK_001]
files:
  - src/data/types.ts
  - src/data/loader.ts
  - src/data/loader.test.ts
---

# TASK_002 · 数据层 types + loader

## 目标
定义与真实 JSON 字段对齐的 `Edge` / `Node` / `MapData` 类型，实现**纯函数** loader：按 SPEC §2.1 解包 `data.currentMapInfoVersion.mapJson`，做数据校验与退化处理（§9），计算包围盒，产出告警列表。为所有几何/渲染 task 提供可信数据源。

## 前置依赖
TASK_001（vitest 就绪）。

## 涉及文件
- `src/data/types.ts`（新建）
- `src/data/loader.ts`（新建）
- `src/data/loader.test.ts`（新建）

## 实现要点
1. **types.ts**（字面量联合，禁 enum）：
   - `EdgeType = "LINE" | "BEZIER"`；`NodeType = "node" | "warehouse" | "park" | "charge" | "work"`。
   - `Edge`：`id/name/mapId/edgeType/sx/sy/ex/ey/cx/cy/dx/dy(isBackEdge)/snodeId/enodeId` 等；`cx/cy/dx/dy` 为 `number | null`。
   - `Node`：`id/name/mapId/type/x/y/angle(number|null)`。
   - `MapWarning`：`{ kind: "ZERO_LENGTH" | "SELF_LOOP" | "BEZIER_MISSING_CTRL" | "LINE_IGNORE_CTRL" | "NODE_TYPE_UNKNOWN" | "MAP_STATE_DISABLED" | "PARSE_ERROR"; id?: string; detail?: string }`。
   - `Box2XY`：`{ minX, maxX, minY, maxY }`（地图坐标，米）。
   - `MapData`：`{ mapId: string; mapName: string; nodes: Node[]; edges: Edge[]; bbox: Box2XY; warnings: MapWarning[] }`。
2. **loader.ts**：`export function loadMapData(raw: unknown): MapData`（纯函数，接收**已获取的顶层 JSON 对象**，不做 fetch）。
   - 解包：图数据根 = `raw.data.currentMapInfoVersion.mapJson`；标题 = `raw.data.mapName`；`mapId` = `raw.data.mapId`（SPEC §2.1）。
   - `mapState !== "ENABLED"` → 推 `MAP_STATE_DISABLED` 告警但仍继续。
   - 退化（§9）：零长度边跳过 + 告警；自环边跳过 + 告警；`BEZIER` 控制点任一 null → 退化为 LINE + 告警；`LINE` 控制点非 null → 忽略 + 告警；`type` 不在 5 种 → 归 `node` + 告警。
   - 包围盒：遍历**所有边端点与节点坐标**取 min/max（信任边坐标，§2.2）。空地图返回退化 bbox（如 `{minX:0,maxX:0,minY:0,maxY:0}`）。
   - 解析异常（结构缺失/类型错）→ 抛 `PARSE_ERROR` 或返回带该告警的空 MapData（二选一，在测试中固定行为）。
3. **loader.test.ts**：`import sample from "../../src/json/getMapInfo.json"` 喂入，断言：
   - `nodes.length === 1806`、`edges.length`（去零长度/自环后）与原始 3101 接近（记录实际值）。
   - `mapName === "中环大地图"`、`mapId === "50e6465395bd40f59ebe1a0adb90a679"`。
   - `bbox` 为有限数值且覆盖预期范围（真实值 `minX≈-165.7, maxX≈2.1, minY≈-25.1, maxY≈50.2`，以首次运行实测为准）。
   - 构造零长度边、自环边、null 控制点贝塞尔、未知 type 各一例，断言对应告警出现且被正确处理。

## 约束
- 纯函数，无 `fetch`/`fs`/DOM；可被 node 环境单测。
- 不做坐标映射（保持地图原始 xy）；映射留 render 层。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/data/loader.test.ts` 全绿。
2. `pnpm build`（tsc）通过：`verbatimModuleSyntax`/`erasableSyntaxOnly` 无违规。
3. `pnpm lint` 通过。

## 完成定义 (DoD)
- loader 对真实样例产出正确计数/标题/包围盒，退化用例均有对应告警。
- 单测稳定可复跑。

## 风险/备注
- 真实样例的 `bbox` 与去退化后的边数以测试首次运行的实际值为准写回断言（不要凭空猜）。
- loader 不依赖 `isFlipY`（翻转在 render 层）。
