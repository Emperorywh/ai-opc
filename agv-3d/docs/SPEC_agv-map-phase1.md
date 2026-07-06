# AGV 地图 3D 渲染 · Phase 1 规格说明

> 项目：`C:\code\ai-opc\agv-3d`
> 阶段：Phase 1（仅地图渲染，无业务交互）
> 技术栈：Vite 8 · React 19 · TypeScript 6 · @react-three/fiber 9 · three 0.185 · @react-three/drei · oxlint · pnpm
> 文档状态：规格已定稿，待用户提供真实样例 JSON 后即可进入实现

---

## 1. 目标与非目标

### 1.1 目标
用 react-three/fiber 把一张 AGV 地图渲染为 3D 场景。地图由**节点（Node）**与**路径（Edge）**构成，路径支持**直线（LINE）**与**三次贝塞尔曲线（BEZIER）**。Phase 1 只做静态渲染与基础相机操控。

### 1.2 非目标（Phase 1 明确不做）
- AGV 车辆实体、移动动画、轨迹回放
- 路径规划 / 寻路 / 最短路径可视化
- hover / click / 选择 / 详情面板等业务交互（仅保留相机操控与 UI 开关）
- 实时数据 / WebSocket 推送
- 地图编辑、节点/边增删改
- 地理投影（proj4）—— AGV 地图是局部笛卡尔坐标系，不需要投影
- 多地图切换 UI（单地图渲染；`mapId` 字段保留供未来扩展）
- 移动端 / 低端设备适配（桌面优先）

---

## 2. 数据模型

### 2.1 顶层结构（loader 解析路径）
真实样例为后端 HTTP 响应，图数据嵌套较深，loader 须按下列路径解包：

```jsonc
{
  "code": 200,
  "message": "success",
  "data": {
    "mapId": "50e6465395bd40f59ebe1a0adb90a679",
    "mapName": "中环大地图",              // ← 地图标题（字段名是 mapName，非 name）
    "floor": 1,
    "mapState": "ENABLED",
    "currentMapInfoVersion": {
      "mapJson": {
        "nodes": [ /* Node[] */ ],       // ← 真正的节点数组
        "edges": [ /* Edge[] */ ]        // ← 真正的边数组
      }
    }
  }
}
```

loader 解析步骤：
1. 图数据根 = `data.currentMapInfoVersion.mapJson`（`nodes` / `edges` 在此取）
2. 地图标题 = `data.mapName`；`mapId` = `data.mapId`
3. 校验 `data.mapState === "ENABLED"`，否则告警但仍渲染
4. 外层 `code/message/timestamp` 为传输包装，loader 不依赖

样例文件现位于 `src/json/getMapInfo.json`；接入前端时复制到 `public/maps/sample.json` 供 fetch，或由 loader 直接 import 该 JSON。

### 2.2 Edge（路径）
| 字段 | 类型 | 说明 / Phase 1 处理 |
| --- | --- | --- |
| `id` / `name` / `mapId` | string | 标识；`name` 可作路径标签 |
| `edgeType` | `"LINE" \| "BEZIER"` | 决定几何 |
| `sx, sy` | number | 起点（地图坐标，米） |
| `ex, ey` | number | 终点 |
| `cx, cy` | number \| null | 贝塞尔第一控制点 P1（仅 BEZIER） |
| `dx, dy` | number \| null | 贝塞尔第二控制点 P2（仅 BEZIER） |
| `isBackEdge` | boolean | **反向边**，仅用于渲染分色；不参与双车道左右偏移计算 |
| `snodeId` / `enodeId` | string | 起/止节点引用（Phase 1 不用于定位，仅留作语义） |
| `sfacing` / `efacing` | number | 进/出节点朝向角（Phase 1 不可视化） |
| `cost` `loadType` `*Security` `max*Speed` `*Acceleration` … | 各类型 | 业务属性，Phase 1 **不渲染** |
| `actions` `userDefinedProperties` `allowVehicleGroups` … | 各类型 | 忽略 |

**关键决策：端点坐标信任边自带值**。绘制一律使用 `(sx,sy)→(ex,ey)`（贝塞尔含控制点），**不**从 `snodeId/enodeId` 反查节点 `x,y`。理由：边坐标才是几何真值，节点坐标可能与边端点存在微小漂移。

### 2.3 Node（节点）
| 字段 | 类型 | 说明 / Phase 1 处理 |
| --- | --- | --- |
| `id` / `name` / `mapId` | string | `name`（如 `"130"`）可作节点标签 |
| `type` | `"node" \| "warehouse" \| "park" \| "charge" \| "work"` | **5 种类型，按颜色区分** |
| `x, y` | number | 位置（地图坐标，米） |
| `angle` | number \| null | 朝向角（弧度）；非空时显示朝向小三角 |
| `enterChargeStationId` `enableVirtual*` … | 各类型 | 忽略 |
| `actions` `userDefinedProperties` `allowVehicleGroups` `addDis` | 各类型 | 忽略 |

---

## 3. 坐标系与场景骨架

| 决策项 | 方案 |
| --- | --- |
| **轴映射** | 地图 `(x, y)` → 场景 `(x, z)`，平铺到 `y=0` 水平面 |
| **Y 翻转开关** | `config` 中预留全局常量 `isFlipY`（默认 `false`）。渲染后若发现上下镜像，置 `true` 翻转 Z。无需现在确定源数据 Y 朝向 |
| **单位比例** | 1 场景单位 = 1 米（数据已是米级，1:1 直用） |
| **相机投影** | 正交（默认，纯俯视）↔ 透视（斜视）可一键切换 |
| **初始取景** | 加载数据后自动计算地图包围盒 `Box3` 并 fit 到视图 |
| **地面/网格** | **不画**。背景为纯深色 |
| **z-fighting 处理** | 无地面层。贴片图元按底面 y 单调分层避免共面闪烁：路径 `y=0`、方向箭头 `y=0.02`、朝向三角 `y=0.05`。节点为不透明实心圆柱（底面 `y=0`、高 `nodeHeight=0.04`、顶面 `y=0.04`），自然遮挡穿过的路径；朝向三角 `y=0.05` 严格高于节点顶面 `0.04`，俯视不被圆盘遮挡 |
| **背景色** | 深色工业风，如 `#0a0e1a` |

**相机实现**：drei `<OrthographicCamera>` / `<PerspectiveCamera>`（`makeDefault`）按模式切换 + `<OrbitControls>`（平移/缩放/旋转）+ 手动包围盒 fit。正交模式下 fit 通过调整 `zoom`，透视模式下通过调整相机距离。Phase 1 不使用 `<Bounds>`，避免正交相机 fit 行为依赖组件内部实现。

---

## 4. 路径（Edge）渲染

### 4.1 线宽技术
采用 **drei `<Line>`**（底层 `Line2` + `LineMaterial`，mesh 粗线、抗锯齿、可设像素宽度）。理由：原生 `glLineWidth` 在 WebGL2/Windows 上几乎锁死 1px，无法满足粗线需求。

### 4.2 几何
- **LINE**：直线段 `(sx,sy)→(ex,ey)`
- **BEZIER**：**三次贝塞尔**，`P0=(sx,sy)`、`P1=(cx,cy)`、`P2=(dx,dy)`、`P3=(ex,ey)`。CPU 端按弧长自适应 tessellate（短边少分段、大曲率多分段，封顶最大段数）成折线点。

### 4.3 颜色编码
按 `isBackEdge` 二分色：
- 正向（`isBackEdge=false`）：青绿荧光 `#00e5a8`
- 反向（`isBackEdge=true`）：暖橙红 `#ff6b6b`

### 4.4 双向边「双车道」偏移
正向/反向成对边**沿法线偏移**呈双车道，避免完全重叠。

**配对判定（必须用节点 id，不用坐标）**：
- 边 A `(snodeId=u, enodeId=v)` 与边 B `(snodeId=v, enodeId=u)` 互为配对（A 的终点是 B 的起点、A 的起点是 B 的终点）。
- 配对**仅依赖 `snodeId/enodeId` 的精确反向语义匹配**；几何定位仍信任边自带 `(sx,sy)/(ex,ey)`（§2.2 关键决策不变）。两者职责分离，互不冲突。
- 预建索引：`Map<key, Edge[]>`，`key = min(u,v) + "-" + max(u,v)`（归一化无向键）。只有同 key 下**恰好 2 条且方向互逆**时才视为 paired；1 条为孤儿；同向重复或超过 2 条为数据歧义，Phase 1 不做配对偏移。

**偏移规则**：
- `isBackEdge` **只用于颜色语义，不参与左右偏移计算**。真实样例中存在双向配对但两条边 `isBackEdge` 均为 `false` 的情况，因此不能把它当作配对左右依据。
- 每条边按自身行驶方向计算平面内切线 `T`，统一约定法线 `N = perpendicular(T)`（顺时针 90°，即行驶方向右侧）。paired 边一律向自身 `+N` 偏移 `laneOffset/2`。由于反向边的切线天然相反，两条互逆边会自动落在中心线两侧。
- 直线边：两端点常量偏移。
- 贝塞尔边：逐 tessellate 采样点沿局部法线偏移（曲线上法线方向连续变化）。

**孤儿边（无配对）**：**不做双车道偏移**，画在几何中心线上。理由：孤边没有重叠对象，偏移反而偏离真实路径、与地图语义不符。仍按自身 `isBackEdge` 上色。

**节点处连续性（已知局限，Phase 1 接受）**：相邻边切线不同，各自法线偏移方向不同，在公共节点处两条偏移车道会错位形成视觉裂缝。Phase 1 **不做法线对齐/车道缝合**，接受裂缝。若后续观感不可接受，Phase 2 再评估节点处车道收敛。

### 4.5 方向箭头
沿每条边标注 `snode→enode` 走向的小箭头：
- 默认每条边中点 1 个箭头；长边（弧长 > 阈值）按等弧长间隔多个
- 箭头朝向 = 该参数点的切线方向
- 贝塞尔边箭头按曲线参数采样定位与朝向
- 颜色随所属边的 `isBackEdge` 色（略亮一档）

### 4.6 性能架构（面向 1k–10k 边）
**禁止**每条边一个 `<Line>` 实例（= 每条一次 draw call，10k 不可接受）。

**决策：所有边（直线 + 贝塞尔）统一 CPU tessellate 成折线，合并进单个 `Line2`**（`LineGeometry` 多段折线 + `vertexColors` 按 `isBackEdge` 上色，双车道偏移在采样点算入），全部图边 **1 次 draw call**。

理由：
- 真实数据贝塞尔占比仅 ~3.5%（108/3101），为 3.5% 的边单独维护直线 ribbon `InstancedMesh` 管线不划算；
- 统一 `Line2` 与 §4.1 线宽技术自洽——全部屏幕空间像素宽度 `lineWidthPx`，缩放下视觉一致（避免「直线世界宽度 / 贝塞尔像素宽度」两套粗细在缩放时表现不一）；
- 直线 tessellate 退化为 1 段（2 端点），开销可忽略。

构建流程：
1. 遍历所有边：LINE 取首尾 2 点；BEZIER 按弧长自适应 tessellate（封顶 `bezierMaxSegments`）；
2. 每个采样点叠加双车道法线偏移（§4.4）；
3. 全部折线点拼接到单一 `LineGeometry`，每段顶点附带颜色（按 `isBackEdge`）；
4. 同步产出 `edgeSamplePaths` 元数据（`edgeId` / `edgeName` / `isBackEdge` / 偏移后的采样点 / 切线 / 弧长），供箭头与路径标签复用，避免重复 tessellate；
5. 数据变更时整建 buffer（Phase 1 静态，基本不发生）。

**方向箭头**：单独 1 个 `InstancedMesh`（cone）。实例总数 = Σ(每条边箭头数)，基于 `edgeSamplePaths` 预先统计（每条边按 §4.5 规则算出箭头数：短边 1 个、长边按等弧长间隔多个），统计完成后再分配实例池，`instanceColor` 按 `isBackEdge`。

---

## 5. 节点（Node）渲染

### 5.1 形状与性能
圆柱体（俯视即圆点）。**1 个 `InstancedMesh`** 承载全部节点，`instanceColor` 按 `type` 上色。半径见 §7 常量。

### 5.2 类型配色（深色工业风）
| type | 颜色（建议，可调） | 语义 |
| --- | --- | --- |
| `work` | `#4dabf7`（亮蓝） | 作业点 |
| `charge` | `#ffd43b`（能量黄） | 充电 |
| `park` | `#868e96`（中性灰） | 停放 |
| `warehouse` | `#b197fc`（仓储紫） | 仓储 |
| `node` | `#ced4da`（浅灰） | 普通节点 |

### 5.3 朝向指示（angle）
`angle` 非 `null` 的节点（真实数据约 460/1806），在圆点上叠加一个朝向小三角（wedge）。用单独的小 `InstancedMesh`，仅对有 `angle` 的节点设置实例；`angle=null` 的节点不渲染三角。**三角底面 `y=0.05`，严格高于节点圆柱顶面 `0.04`（见 §3 分层），确保俯视不被圆盘遮挡。**

### 5.4 标签
- 节点 `name` 与路径 `name` **各自独立的显隐开关**（`showNodeLabels` / `showEdgeLabels`），默认**关闭**，UI 可切换
- 文字用 drei `<Text>`（底层 troika-three-text）
- **1k–10k 标签不能全量渲染**，开启时强制执行：
  - 视口剔除：只生成相机视锥内可见节点的文字
  - 缩放阈值：缩太远（屏幕密度过低）时不显示
  - 数量上限：同一帧最多渲染 N 个（如 200），超出按优先级丢弃
- 简单碰撞剔除（屏幕空间重叠标签互斥）为后续增强，Phase 1 不作为硬验收
- 标签状态用 React Context / `useState` 管理（不引入 zustand）

---

## 6. 调色板（深色工业风，集中配置）

```
背景      #0a0e1a
正向边    #00e5a8      反向边    #ff6b6b
箭头(正)  #38ffc1      箭头(反)  #ff8e8e
work      #4dabf7      charge    #ffd43b
park      #868e96      warehouse #b197fc
node      #ced4da
标签文字  #e9ecef      标签描边  rgba(0,0,0,0.6)
```
全部集中在 `src/config/palette.ts`，便于整体换肤。

---

## 7. 关键常量（`src/config/constants.ts`）

| 常量 | 建议值 | 说明 |
| --- | --- | --- |
| `isFlipY` | `false` | Y 翻转全局开关 |
| `unitScale` | `1.0` | 1 单位 = 1 米 |
| `lineWidthPx` | `3` | Line2 像素宽度 |
| `laneOffset` | `0.15` | 双车道偏移量（米） |
| `nodeRadius` | `0.18` | 节点圆点半径（米） |
| `nodeHeight` | `0.04` | 圆柱厚度 |
| `bezierMaxSegments` | `64` | 贝塞尔 tessellate 段数上限 |
| `arrowSize` | `0.12` | 方向箭头尺寸 |
| `longEdgeThreshold` | `3.0` | 长边阈值（米），超过则多箭头 |
| `labelMaxVisible` | `200` | 标签同帧渲染上限 |

---

## 8. 架构与目录分层（轻量预留）

数据层与渲染层解耦，便于未来加入 AGV 车辆实体 / 实时数据而不伤筋动骨。

```
src/
  data/
    types.ts          # Edge / Node / MapData 类型（与 JSON 字段对齐）
    loader.ts         # 读取 + 校验 + 包围盒计算 + 退化数据处理
  config/
    palette.ts        # 调色板
    constants.ts      # 上述常量
  state/
    MapConfig.tsx     # React Context: isFlipY/cameraMode/showNodeLabels/showEdgeLabels/palette
  render/             # 纯几何工具（无 React）
    coordinates.ts    # 地图坐标与场景坐标的唯一映射入口（含 isFlipY）
    bezier.ts         # 三次贝塞尔采样
    laneOffset.ts     # 双车道法线偏移 + 配对判定（§4.4）
    geometry.ts       # 构建统一 Line2 折线 buffer
  scene/
    MapView.tsx       # <Canvas> + 相机 + OrbitControls + 手动 fit
    EdgesLayer.tsx    # 单一 Line2（直线 + 贝塞尔合并）
    ArrowsLayer.tsx   # 方向箭头 InstancedMesh
    NodesLayer.tsx    # 节点 InstancedMesh + 朝向三角
    LabelsLayer.tsx   # troika 文字（带剔除/上限）
  ui/
    Controls.tsx      # 极简控制条：相机模式切换 / 标签开关（phase 1 仅此）
  App.tsx
  main.tsx
```

---

## 9. 边界情况与数据校验（loader 内处理）

| 情况 | 处理 |
| --- | --- |
| `edgeType=BEZIER` 但 `cx/cy/dx/dy` 任一为 null | 退化为直线（用 sx,sy→ex,ey），记录告警 |
| `edgeType=LINE` 但控制点非 null | 忽略控制点，按直线绘制 |
| 零长度边（`sx==ex && sy==ey`） | 跳过，不绘制 |
| 自环边（`snodeId==enodeId`） | 跳过并告警 |
| `angle` 为 null | 不渲染朝向三角 |
| 节点 `name` 为空或重复 | 空名不显示标签；重复名照常（按 id 区分） |
| 边端点与所连节点坐标漂移 | **信任边坐标**，不修正 |
| `type` 不在 5 种枚举内 | 归入 `node` 默认色，告警 |
| 空地图 / 加载失败 / JSON 解析错误 | 显示空场景 + 控制台错误 + UI 提示 |
| WebGL2 不可用 | 显示降级提示文案（Phase 1 不做软渲染兜底） |

---

## 10. 交互与控制（Phase 1 全集）

- **相机**：OrbitControls 拖拽平移、滚轮缩放、右键旋转；手动包围盒 fit；正交/透视切换按钮
- **UI 开关**（极简控制条）：
  - 相机模式：正交 / 透视
  - 节点标签：开 / 关
  - 路径标签：开 / 关
  - （可选）Y 翻转：开 / 关 —— 便于运行时核对方向
- **无 hover / click / 选择**（纯渲染）

---

## 11. 性能预算

- 目标：现代桌面浏览器、WebGL2、60fps
- 规模上限：单图 1k–10k 节点 + 1k–10k 边
- 策略：全部边统一合并为单个 `Line2`，节点/箭头使用 `InstancedMesh`，标签视口剔除 + 上限，draw call 控制在个位数到低两位数
- 变更数据时（Phase 1 静态，基本不发生）按需重建 buffer，避免每帧重算

---

## 12. 验收标准

1. 加载样例 JSON 后，地图在深色背景上正确居中显示，自动 fit 到视野
2. 直线边与贝塞尔曲线边均正确绘制，贝塞尔形状符合三次贝塞尔定义
3. 正向/反向边颜色区分清晰，成对双向边呈双车道偏移、不重叠
4. 每条边中点可见方向箭头，朝向与 `snode→enode` 一致
5. 5 类节点按配色区分，有 `angle` 的节点显示朝向三角
6. 正交/透视相机可切换，OrbitControls 平移/缩放/旋转正常
7. 节点/路径标签开关有效，开启后无性能崩溃（剔除生效）
8. 真实样例（约 1.8k 节点 / 3.1k 边）下保持接近 60fps；10k 合成压测作为性能预算记录，不作为 Phase 1 硬验收
9. 退化数据（零长度边、null 控制点、空 angle 等）不报错、不崩溃

---

## 13. 未来阶段预留（Phase 2+，本期不实现）

- AGV 车辆实体：在 `scene/` 下新增 `VehiclesLayer.tsx`，复用 loader/geometry 工具
- 实时位置：`data/` 下预留实时数据管道接入点（WebSocket），与静态 loader 并列
- 路径规划可视化：高亮子图，复用 EdgesLayer 的 instanceColor 动态更新
- 多地图：`mapId` 已保留，未来加地图切换 UI
- 交互：hover/click/详情面板、选择高亮
- 架构上数据层（`data/`）与渲染层（`scene/` `render/`）已分离，上述扩展不需重构既有结构

---

## 14. 开放问题 / 待确认

1. ~~真实样例 JSON 顶层结构~~ → **已确认**（2026-07-06，对照 `src/json/getMapInfo.json`）：真实数据为 HTTP 响应包装，图数据在 `data.currentMapInfoVersion.mapJson`，地图名为 `mapName`。详见 §2.1。
2. **Y 轴朝向**：`isFlipY` 默认 `false`，渲染后据实翻转。
3. **双车道偏移量 / 节点半径等常量**：§7 为建议值，首版渲染后按观感微调。
4. **配色**：§6 为深色工业风建议值，可整体替换为品牌色。
