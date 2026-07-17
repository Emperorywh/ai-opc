# AGV 3D 地图展示 — 规格说明

> 版本：1.1
> 日期：2026-07-13
> 数据基线：中环大地图 V76
> 状态：可实施

---

## 1. 文档目的与约束

本规格定义 AGV 静态拓扑地图从原始数据加载、校验、几何编译到 3D 呈现的完整实现边界。实现必须以本规格中的确定性决策为准，不保留其他实现分支、旧数据兼容、运行时 fallback 或静默降级逻辑。

文档中的关键词含义如下：

- **必须**：验收所需的强制要求。
- **应**：默认实现要求，只有规格修订后才能改变。
- **可**：不影响架构边界的局部视觉参数微调。

## 2. 目标与范围

### 2.1 产品目标

将 AGV 地图拓扑以高质量 3D 沙盘形式呈现于调度大屏，用于静态展示与态势认知。核心目标是：

- 拓扑完整、方向清晰。
- 视觉风格统一，适合长时间观看。
- 1080p～4K 目标大屏稳定运行。
- 架构可推导、可测试，后续图层扩展不侵入当前模块。

### 2.2 本期范围

- 渲染 1768 个节点与 3045 条有向边。
- 支持直线和三次贝塞尔路径。
- 节点通过形状、颜色和朝向表达类型。
- 成对反向边渲染为双车道，单向边保持在自身中心线上。
- 路径通过流动高亮表达有向性。
- 提供倾斜沙盘视角、旋转、缩放、平移和初始自动框选。
- 提供真实阶段驱动的加载进度、错误状态和场景淡入。
- 提供深色科技风格、反射地面、网格、雾效和 Bloom。

### 2.3 本期非目标

- 不实现点击详情、悬停提示、筛选、搜索、定位或连通性高亮。
- 不渲染节点名称、路径名称、图例、比例尺、指北针或标题水印。
- 不接入 AGV 实时位置、任务、路径规划或设备状态。
- 不实现地图编辑、导出或量测。
- 不实现 `zones`、`nodeEdgeGroups` 的空模块或占位组件。
- 不实现多地图、旧地图格式或后端协议兼容。

未来能力通过稳定的图层组合边界接入，不通过当前版本的空实现预留。

---

## 3. 核心技术决策

| 维度 | 确定性决策 |
|---|---|
| 数据资源 | `map.json` 作为本地构建资产，通过资源 URL 在应用启动后立即加载 |
| 数据处理 | Worker 内完成解析、严格校验、规范化和几何编译 |
| 错误策略 | 任一必需字段或拓扑约束错误均终止加载并进入显式错误状态 |
| 节点渲染 | 4 个低面数 `InstancedMesh`，本期不实现 LOD |
| 路径渲染 | LINE/BEZIER 在编译层统一为采样路径，最终合并为一个路径 Mesh |
| 双车道 | 根据互为反向且几何等价的边建立 `LaneGroup`，不依赖 `isBackEdge` 分配车道 |
| 单向边 | 沿原始中心线渲染，不做侧向偏移 |
| 朝向约定 | 节点几何模型前向轴统一为 `+X`，世界旋转使用 `rotationY = angle` |
| 后处理 | `@react-three/postprocessing`：Bloom + SMAA + ToneMapping（ACES），不启用重复的 MSAA 管线 |
| 反射 | 使用单一平面反射方案，反射 RenderTarget 固定为 1024×1024 |
| 帧循环 | 仅更新有界流光相位和相机阻尼，不产生逐帧临时对象 |
| 资源管理 | Worker、Geometry、Material、Texture、RenderTarget 都必须具备确定性释放路径 |

---

## 4. 数据基线与契约

### 4.1 数据资产

- 源文件：项目根目录 `map.json`。
- 文件大小：6,516,343 bytes，约 6.2 MiB。
- SHA-256：`DE2B1158FEFDC274673FB7F1813D8F193961359926B238B0CC334350A87FC567`。
- 取数路径：`data.currentMapInfoVersion.mapJson`。
- 资产随构建产物自托管，不使用 CDN。
- 应用外壳首次渲染后立即加载资产，这属于启动流程，不属于功能懒加载。

资产内容发生有意变更时，必须同步更新本节指纹、审计统计和数据契约测试。

### 4.2 真实数据审计

| 项目 | 当前结果 |
|---|---:|
| `nodes` | 1768 |
| `edges` | 3045 |
| `zones` | 0 |
| `nodeEdgeGroups` | 0 |
| `node` / `work` / `charge` / `park` | 1304 / 389 / 11 / 64 |
| `LINE` / `BEZIER` | 2936 / 109 |
| `isBackEdge = true` | 879 |
| 完全反向且几何完全一致的边对 | 979 对 |
| 反向拓扑存在且中心线偏差不超过 0.02 m 的额外边对 | 19 对 |
| 规范化后的双向车道组 | 998 组 |
| 未组成双向车道组的单向边 | 1049 条 |
| 边端点与引用节点坐标不完全一致 | 483 条，最大差异 0.03 m |
| 缺失节点引用 / 非法坐标 / 重复 ID | 0 / 0 / 0 |

`isBackEdge` 与真实反向几何并不完全一致：部分反向边未设置该标记，部分已设置标记的边没有反向边。因此它只保留在原始 DTO 审计信息中，不进入车道布局决策。

边几何以边自身的 `sx/sy/ex/ey/cx/cy/dx/dy` 为权威数据；节点 ID 只表达拓扑关系。不得把边端点强制吸附到节点坐标。

### 4.3 原始 DTO

```ts
type RawNodeType = 'node' | 'work' | 'charge' | 'park'
type RawEdgeType = 'LINE' | 'BEZIER'

interface RawMapNode {
  id: string
  type: RawNodeType
  x: number
  y: number
  angle: number | null
}

interface RawMapEdge {
  id: string
  edgeType: RawEdgeType
  sx: number
  sy: number
  ex: number
  ey: number
  cx: number | null
  cy: number | null
  dx: number | null
  dy: number | null
  snodeId: string
  enodeId: string
  isBackEdge: boolean
}

interface RawMapPayload {
  nodes: RawMapNode[]
  edges: RawMapEdge[]
  zones: unknown[]
  nodeEdgeGroups: unknown[]
}

interface RawMapAsset {
  data: {
    currentMapInfoVersion: {
      mapJson: RawMapPayload
    }
  }
}
```

原始数据中的其他字段不属于渲染契约，在边界转换时显式丢弃。此行为不是旧数据兼容逻辑。

### 4.4 严格校验规则

加载流程必须一次性收集校验问题并进入 `error` 状态，不得跳过坏记录继续显示不完整地图。

- `id` 必须非空且在各自集合内唯一。
- 每个有向节点对最多存在一条边，保证反向候选唯一。
- `type`、`edgeType` 必须属于已声明的封闭联合类型。
- 所有参与渲染的坐标和角度必须为有限数值。
- `snodeId`、`enodeId` 必须引用存在的节点。
- `LINE` 的起终点不得重合。
- `BEZIER` 的两个控制点必须完整且为有限数值，不允许退化为 LINE。
- 当前数据契约要求 `node.angle = null`，其他三类节点的 `angle` 为有限数值。
- 当前数据契约要求 `zones`、`nodeEdgeGroups` 为空数组。
- 边端点与节点坐标允许不同，不属于校验错误。
- `isBackEdge` 不参与正确性校验和渲染分支。

### 4.5 规范化领域模型

```ts
interface Point2 {
  x: number
  y: number
}

interface MapNode {
  id: string
  type: RawNodeType
  position: Point2
  angle: number | null
}

type DirectedPath =
  | {
      kind: 'line'
      start: Point2
      end: Point2
    }
  | {
      kind: 'cubic-bezier'
      start: Point2
      control1: Point2
      control2: Point2
      end: Point2
    }

interface DirectedEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  path: DirectedPath
}
```

领域模型不得依赖 React、R3F、Three.js、Worker API 或浏览器对象。

---

## 5. 架构、模块边界与状态流

### 5.1 分层结构

```text
src/features/agv-map/
├─ domain/          原始 DTO、领域模型、校验规则、规范化规则
├─ geometry/        路径采样、车道分组、扁带编译、节点实例编译
├─ application/     加载用例、显式状态机、取消与生命周期协调
├─ infrastructure/  地图资产读取、Worker 通信适配
├─ worker/          调用纯校验与几何编译能力
├─ presentation/    页面、加载状态、错误状态、R3F 场景和图层
└─ config/          几何、主题、相机和性能配置
```

依赖方向必须保持单向：

```text
presentation → application → domain
infrastructure → application/domain
worker → domain/geometry
geometry → domain
```

禁止事项：

- R3F 组件不得读取或解析原始 JSON。
- 领域层和几何层不得创建 Three.js 场景对象。
- Worker 不得持有 React 状态。
- 展示层不得实现贝塞尔、反向边配对或车道偏移算法。
- 不通过全局可变对象、隐式缓存或模块级单例传递加载结果。
- 复杂算法必须使用多行简体中文注释说明不变量、坐标约定和边界条件，不写只复述语句含义的注释。

### 5.2 数据流

```text
map.json 资产 URL
→ Worker 下载与解析
→ 严格校验
→ 规范化 MapModel
→ 节点与路径几何编译
→ Transferable RenderPacket
→ 主线程创建 GPU 资源
→ R3F 图层只读渲染
```

`RenderPacket` 只包含可转移的 `ArrayBuffer`、TypedArray、边界和统计信息，不包含 Three.js 类实例：

```ts
interface NodeInstancePacket {
  count: number
  matrices: Float32Array
}

interface PathGeometryPacket {
  positions: Float32Array
  normals: Float32Array
  pathU: Float32Array
  flowDirections: Float32Array
  indices: Uint32Array
  edgeVertexRanges: Uint32Array
}

interface CompilationReport {
  nodeCount: number
  edgeLaneCount: number
  bidirectionalGroupCount: number
  unpairedEdgeCount: number
}

interface Bounds3Data {
  min: [number, number, number]
  max: [number, number, number]
}

interface RenderPacket {
  nodeInstances: Record<RawNodeType, NodeInstancePacket>
  pathGeometry: PathGeometryPacket
  renderBounds: Bounds3Data
  report: CompilationReport
}
```

### 5.3 显式加载状态

```ts
type MapSceneState =
  | { status: 'loading'; stage: 'downloading'; progress: number }
  | { status: 'loading'; stage: 'parsing'; progress: number }
  | { status: 'loading'; stage: 'validating'; progress: number }
  | { status: 'loading'; stage: 'compiling-nodes'; progress: number }
  | { status: 'loading'; stage: 'compiling-paths'; progress: number }
  | {
      status: 'preparing'
      stage: 'creating-scene' | 'fading'
      progress: number
      packet: RenderPacket
    }
  | { status: 'ready'; packet: RenderPacket }
  | { status: 'error'; error: MapLoadError }
```

- `progress` 始终为 0～1 的单调值。
- JSON.parse 不伪造连续进度，只报告开始和完成。
- 节点、路径编译进度由已处理记录数计算。
- 状态转换只能由应用层用例驱动。
- 同一时间只允许一个有效加载会话。

### 5.4 生命周期

- 每个加载会话拥有唯一 `requestId`，旧会话结果不得覆盖新状态。
- 组件卸载时必须中止下载并终止 Worker。
- Worker 返回 TypedArray 后转移其 `ArrayBuffer` 所有权，不复制大数组。
- 创建失败时必须释放已经创建的 GPU 资源。
- 正常卸载时必须显式释放 Geometry、Material、Texture、PMREM 和反射 RenderTarget。
- React StrictMode 的开发期重复挂载不得产生重复 Worker、重复事件监听或资源泄漏。

---

## 6. 坐标系、朝向与场景边界

### 6.1 2D 到 3D 映射

地图使用 XY 平面，Three.js 使用 XZ 地面：

```text
map(x, y) → world(x - centerX, height, -(y - centerY))
```

- 世界 Y 轴仅表达高度。
- 真实尺度保持 1 world unit = 1 m。
- 不对地图数据做整体缩放。

### 6.2 朝向约定

- 原始 `angle` 使用地图 XY 平面弧度。
- 角度 0 指向地图 `+X`。
- 角度正方向从 `+X` 指向 `+Y`。
- 所有方向性节点几何在模型空间默认指向 `+X`。
- 由于世界映射采用 `z = -y`，节点绕世界 Y 轴旋转时使用 `rotationY = angle`。

必须通过 `0、π/2、-π/2、π` 四个基准角测试形状尖端的世界方向。

### 6.3 地图中心与渲染边界

- 地图中心由所有节点位置和完整路径采样点的联合 AABB 计算。
- 几何编译完成后，必须重新计算包含节点尺寸、扁带宽度和车道偏移的 `renderBounds`。
- 相机 framing 只能依赖 `renderBounds`，不能只依赖节点 AABB。
- 雾效、阴影和反射地面范围由 `renderBounds` 加统一环境边距推导。

---

## 7. 几何编译

### 7.1 纯函数边界

几何模块必须由可测试的纯函数组成：

```text
normalizeMap(raw) → MapModel
samplePath(path, samplingConfig) → SampledPath
groupLanes(edges, groupingConfig) → LaneGroup[]
compilePathGeometry(groups, pathConfig) → PathRenderPacket
compileNodeInstances(nodes, nodeConfig) → NodeRenderPacket
```

输入相同必须产生字节级稳定的输出；不得读取场景状态、相机或系统时间。

### 7.2 节点实例

| 类型 | 几何 | 模型前向 | 颜色 |
|---|---|---|---|
| `node` | 低面数立方体 | 无方向性 | 蓝 |
| `work` | 楔形 | `+X` | 青 |
| `charge` | 带单侧尖端的六棱柱 | `+X` | 黄 |
| `park` | 带切角长方体 | `+X` | 绿 |

- 每种类型一个 `InstancedMesh`，共 4 个节点 DrawCall。
- 实例矩阵在加载完成时构建一次。
- 节点基准宽度为 0.5 m，可在集中配置中按类型微调。
- 节点底部位于地面上方，中心 Y 等于自身几何半高。
- 本期不实现 LOD、Billboard 或按相机距离重新分组。

### 7.3 LINE 与 BEZIER 采样

- LINE 直接生成起点和终点。
- BEZIER 使用三次贝塞尔公式并采用确定性的递归细分。
- 细分同时受最大弦长和曲线平坦度约束。
- 初始配置：最大弦长 0.25 m、最大平坦度误差 0.01 m、最大递归深度 12。
- 采样结果必须以源边方向从 `sourceNodeId` 指向 `targetNodeId`。
- 相邻采样点距离不得为 0；出现零长度段属于编译错误。
- `cost` 不参与几何采样。

LINE 与 BEZIER 的差异只存在于采样器内部；采样之后统一进入车道布局和扁带编译流程。

### 7.4 车道分组

车道分组不得使用 `isBackEdge` 决定偏移方向。

1. 先根据 `sourceNodeId/targetNodeId` 查找唯一的反向拓扑候选。
2. 将候选路径统一到相同起终方向，以 33 个等参数点比较中心线；该比较采样与渲染自适应采样相互独立。
3. 最大对应点偏差不超过 `LANE_GROUP_TOLERANCE_M = 0.02` 时组成双向 `LaneGroup`。
4. 双向组的规范方向由较小节点 ID 指向较大节点 ID，保证结果稳定。
5. 规范方向对应车道使用 `+LANE_CENTER_OFFSET_M`，反方向车道使用 `-LANE_CENTER_OFFSET_M`。
6. 不能组成双向组的边作为独立单向组，偏移量必须为 0。

双向组只使用规范方向边的中心线作为共享中心线，消除原始反向几何的小量坐标差异。两个有向边 ID 和各自流动方向仍完整保留。

初始几何参数：

| 参数 | 值 |
|---|---:|
| `LANE_GROUP_TOLERANCE_M` | 0.02 m |
| `LANE_PAIR_SAMPLE_COUNT` | 33 |
| `LANE_CENTER_OFFSET_M` | 0.18 m |
| `RIBBON_WIDTH_M` | 0.22 m |
| 扁带离地高度 | 0.015 m |

### 7.5 扁带生成

- 在地图 XY 平面完成中心线偏移和扁带展开，之后统一映射到世界 XZ 平面。
- 每个采样点通过相邻点计算稳定切线和法线。
- 折角使用 miter join，miter 长度上限为半带宽的 2 倍。
- 超过 miter 上限的折角按确定性规则生成 bevel join。
- 输出必须校验全部位置、法线、UV 和索引均为有限值且索引不越界。

所有路径最终合并为一个 `BufferGeometry`，并携带：

- `position`：世界空间位置。
- `normal`：地面法线。
- `aPathU`：每条车道独立、按米累计的弧长。
- `aFlowDirection`：相对规范中心线的 `+1` 或 `-1`。

即使最终只有一个 Mesh，编译报告中仍必须保留 3045 条有向边对应的车道记录和顶点区间。

### 7.6 流动方向

- 着色器统一使用 `aPathU` 计算周期性高亮。
- 双向组共享规范弧长坐标，通过 `aFlowDirection` 表达相反方向。
- 单向边按自身源节点到目标节点方向构建弧长，`aFlowDirection = +1`。
- 不再根据 `isBackEdge` 二次翻转流向。
- 相位采用有界周期：`phase = (elapsedSeconds % FLOW_PERIOD_SECONDS) / FLOW_PERIOD_SECONDS`。
- 每帧只更新一个 uniform，不创建临时 Vector、数组或材质。

初始流光参数：

| 参数 | 值 |
|---|---:|
| `FLOW_REPEAT_M` | 2.0 m |
| `FLOW_SPEED_MPS` | 0.4 m/s |
| `FLOW_PERIOD_SECONDS` | 5 s |

---

## 8. 场景与视觉设计

### 8.1 场景层级

```text
Scene
├─ EnvironmentLayer  反射地面、网格、雾、环境光
├─ PathLayer         单个合并路径 Mesh
├─ NodeLayer         4 个节点 InstancedMesh
├─ CameraRig         PerspectiveCamera + OrbitControls
└─ PostEffects       Bloom + SMAA + ToneMapping
```

图层之间不得互相查询或修改内部 Three.js 对象。

### 8.2 调色板

| 元素 | 基础色 | Emissive 目标 |
|---|---|---|
| `node` | `hsl(210, 90%, 60%)` | 低于 Bloom 阈值 |
| `work` | `hsl(180, 90%, 55%)` | 接近 Bloom 阈值 |
| `charge` | `hsl(48, 100%, 60%)` | 高于 Bloom 阈值 |
| `park` | `hsl(140, 80%, 55%)` | 高于 Bloom 阈值 |
| 路径扁带 | `hsl(200, 85%, 55%)` | 低于 Bloom 阈值 |
| 流动高亮 | `hsl(185, 100%, 75%)` | 明确高于 Bloom 阈值 |
| 背景 | `#05080F` | 不发光 |

颜色、Emissive、曝光和 Bloom 参数必须集中定义，禁止组件内散落色值。

### 8.3 材质与光照

- 节点固定使用 `MeshStandardMaterial`。
- 路径固定使用一个自定义 `ShaderMaterial`，通过统一 attribute 实现基础扁带、流光、雾和 Bloom 亮度，不创建逐边材质。
- 使用一个带阴影的 `DirectionalLight` 和一个低强度 `AmbientLight`。
- 阴影贴图固定为 2048×2048，仅节点投射阴影。
- 使用本地程序化环境生成 PMREM，不请求远程 HDR 资源。
- 所有材质参数由主题配置统一提供。

### 8.4 地面、网格与雾

- 地面使用 `@react-three/drei` 的 `MeshReflectorMaterial` 构建深色不透明平面反射，不使用“低粗糙度普通材质假装场景倒影”。
- 反射 RenderTarget 固定为 1024×1024，并进行一次粗糙模糊，避免随主画布分辨率膨胀。
- 网格为独立图层，透明度随距地图中心的距离衰减。
- 雾使用线性 `Fog`，密度必须保证初始 framing 下所有拓扑仍可辨识。
- 地面和网格尺寸由 `renderBounds` 加环境边距推导，不写死世界坐标。

### 8.5 色彩与后处理

- 输出颜色空间：`SRGBColorSpace`。
- Tone Mapping：`ACESFilmicToneMapping`。`@react-three/postprocessing` 的 EffectComposer 挂载期无条件把 `renderer.toneMapping` 置为 `NoToneMapping`（卸载时恢复），故 ACES 不经 renderer 作用于任何可见帧；ACES 必须由后处理链末端的 `ToneMappingEffect`（`mode = ACES_FILMIC`）补回唯一一次。renderer 侧 NoToneMapping 加管线内一次 ToneMapping，全管线恰一次色调映射，不重复。
- 初始曝光：1.0。
- Canvas 原生抗锯齿关闭。
- EffectComposer 的 multisampling 设为 0。
- 后处理链固定为 Bloom → SMAA → ToneMapping，不叠加第二套抗锯齿。
- Bloom 只通过亮度阈值触发；基础路径和背景不得进入 Bloom。
- Bloom 初始参数为 `luminanceThreshold = 1.0`、`luminanceSmoothing = 0.2`、`intensity = 1.1`，并启用 mipmap blur。

---

## 9. 相机与控制

### 9.1 相机

- 使用透视相机，固定 FOV；framing 通过计算相机距离完成，不同时动态修改 FOV 和距离。
- FOV 固定为 45°，near 固定为 0.1 m，far 取 `max(1000 m, renderBounds 包围球半径 × 10)`。
- 初始 OrbitControls polar angle 为 45°。
- 初始 target 为 `renderBounds` 中心在地面的投影。
- framing 必须计算包围盒八个角点在相机空间中的水平和垂直需求，并保留 5% 安全边距。
- 16:9 和 21:9 均必须完整容纳 `renderBounds`。

### 9.2 OrbitControls

- 启用旋转、缩放、平移和阻尼。
- polar angle 限制为 25°～70°，禁止完全俯视、接近水平视角或进入地面以下。
- `minDistance = max(2 m, 包围球半径 × 0.05)`。
- `maxDistance = 包围球半径 × 4`。
- 平移 target 限制在 `renderBounds` 水平范围向外扩展 20% 的区域内。
- 控件只负责相机行为，不承载业务点击或悬停状态。
- 相机或控件卸载时必须移除监听器。

### 9.3 Resize

- 画布跟随容器尺寸。
- resize 时更新 aspect、渲染尺寸和有效 DPR。
- resize 不重新解析地图，也不重新编译静态几何。
- 极端窄屏允许 letterbox，但不得裁掉整个场景或产生 NaN 相机参数。

---

## 10. 加载体验与错误呈现

### 10.1 真实进度映射

| 阶段 | 总进度区间 | 数据来源 |
|---|---:|---|
| 下载资产 | 0%～30% | 已读取字节 / 6,516,343 |
| JSON 解析 | 30% | 离散开始/完成状态 |
| 严格校验与规范化 | 30%～40% | 已处理节点和边数量 |
| 节点编译 | 40%～55% | 已处理节点数量 / 1768 |
| 路径编译 | 55%～90% | 已处理边数量 / 3045 |
| 场景资源创建 | 90%～98% | 确定性创建步骤 |
| 场景淡入 | 98%～100% | 固定时长动画 |

- UI 只显示阶段名称和整数百分比，不实现复杂业务叠层。
- Worker 必须在解析前校验资产字节数和 SHA-256，指纹不一致直接进入错误状态。
- 主 Canvas 可在 `opacity: 0` 时挂载已准备的场景资源；首帧成功渲染后才能开始淡入。
- 场景淡入固定为 500 ms，并尊重系统减少动态效果设置。

### 10.2 错误状态

- 下载、解析、校验、编译和 GPU 创建错误都进入统一 `error` 状态。
- 错误状态显示稳定的错误码、阶段和简短中文说明。
- 详细字段路径保留在结构化错误对象和开发日志中。
- 不显示半张地图，不跳过坏记录，不自动切换实现，不自动重试。

稳定错误码包括：

- `ASSET_DOWNLOAD_FAILED`
- `ASSET_INTEGRITY_FAILED`
- `JSON_PARSE_FAILED`
- `SCHEMA_VALIDATION_FAILED`
- `GEOMETRY_COMPILE_FAILED`
- `WEBGL_RESOURCE_FAILED`

---

## 11. 性能与长期运行

### 11.1 固定预算

| 项目 | 预算 |
|---|---|
| 节点 DrawCall | 4 |
| 路径 DrawCall | 1 |
| 路径材质 | 1 |
| 反射 RenderTarget | 1024×1024 |
| 阴影贴图 | 2048×2048 |
| 主画布最大物理像素 | 3840×2160 |
| 静态几何更新 | 运行期 0 次 |
| 每帧业务更新 | 1 个有界流光 uniform |

有效 DPR 根据 CSS 尺寸和最大物理像素预算计算：

```text
effectiveDpr = min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)))
```

不得因为操作系统缩放使 4K 目标画布实际渲染为 6K 或 8K。

### 11.2 帧率验收

性能以实际部署目标机为唯一硬件基线，验收报告必须记录 GPU、显存、驱动、浏览器版本、操作系统缩放和实际物理渲染尺寸。

- 预热 30 秒后连续采样 5 分钟。
- 3840×2160：P95 帧时间不高于 33.3 ms。
- 1920×1080：P95 帧时间不高于 16.7 ms。
- 测试期间必须保持流光、Bloom、反射、阴影和 OrbitControls 阻尼开启。
- 不允许通过运行时关闭效果或降低节点/路径数量达标。

### 11.3 稳定性

- 页面可见时持续渲染；页面不可见时暂停流光帧循环。
- 恢复可见时使用绝对有界相位，不累计超大 delta。
- 连续交互和 resize 不得创建新几何或材质。
- 发布前执行至少 24 小时目标机浸泡测试。
- 浸泡期间 JS Heap、`renderer.info.memory` 和 Worker 数量不得呈单调增长趋势。
- 卸载场景后，Worker 数量归零，GPU 资源计数回到加载前基线。

---

## 12. 集中配置

配置按职责拆分，不建立万能常量文件：

```text
config/
├─ geometryConfig.ts     采样、偏移、带宽、节点尺寸
├─ visualTheme.ts        颜色、材质、灯光、Bloom
├─ cameraConfig.ts       FOV、俯角、控制范围、framing 边距
└─ performanceConfig.ts  像素预算、阴影和反射分辨率
```

- 配置必须具备明确单位后缀，如 `_M`、`_SECONDS`、`_PIXELS`。
- 不允许通过散落数字隐式表达业务规则。
- 视觉参数可以在统一配置中微调，几何和数据契约参数变更必须同步更新测试。

---

## 13. 测试策略

### 13.1 单元测试

使用 Vitest 在 Node 环境执行，不依赖浏览器：

- 原始 DTO 严格校验和错误路径。
- V76 数据指纹、数量、类型分布和引用完整性。
- `(x,y) → (x,0,-y)` 坐标转换。
- 四个基准角的世界朝向。
- LINE 和 BEZIER 的端点、顺序、误差与最大段长。
- 998 个双向车道组和 1049 条单向边的分组结果。
- 双向车道中心间距为 `2 × LANE_CENTER_OFFSET_M`。
- 单向边偏移为 0。
- `isBackEdge` 的变化不影响车道分组结果。
- 扁带顶点、法线、UV、索引全部有效。
- 相机 framing 在 16:9 和 21:9 下包含完整 `renderBounds`。
- 状态机合法转换、取消和过期 Worker 消息隔离。

### 13.2 集成检查

- `pnpm build` 必须通过 TypeScript 和 Vite 构建。
- 编译报告必须为 1768 个节点实例和 3045 条有向车道记录。
- 加载完成后不得存在校验警告、被跳过记录或未处理 Promise rejection。
- 资源卸载测试必须确认 Worker 终止和所有显式 GPU 资源执行 dispose。

### 13.3 人工界面验收

视觉与浏览器交互由人工在目标机执行，不纳入自动浏览器测试：

- 类型、朝向和流向辨识。
- Bloom、反射、阴影、网格和雾的整体质量。
- 初始 framing、旋转、缩放、平移和 resize。
- 加载、淡入和错误界面。
- 4K 性能与 24 小时浸泡测试。

---

## 14. 技术栈与依赖

### 14.1 已有基线

- React 19.2.7
- TypeScript 6.0.2
- Vite 8.1.1
- `@react-three/fiber` 9.6.1
- Three.js 0.185.1

### 14.2 新增依赖决策

- `@react-three/drei` 10.7.7：OrbitControls、平面反射和受控场景辅助能力。
- `@react-three/postprocessing` 3.0.4：EffectComposer、Bloom、SMAA。
- Vitest 4.1.10：纯算法、状态机和数据契约测试。

依赖安装后由 `pnpm-lock.yaml` 固定完整依赖图。实现中不保留 three examples、自研后处理或其他库的替代分支。

---

## 15. 交付物

- 完整可运行的 AGV 3D 地图展示页面。
- 分层源码和独立 Worker 入口。
- 严格原始数据校验与规范化模块。
- 纯函数几何编译模块。
- 节点、路径、环境、相机和后处理图层。
- 集中且按职责拆分的配置。
- 单元测试、数据契约测试和构建脚本。
- 编译统计、性能记录和目标机浸泡测试记录。

---

## 16. 验收标准

### 16.1 数据与拓扑

1. 数据指纹与本规格一致。
2. 校验结果为 1768 个节点、3045 条有向边，跳过数量为 0。
3. 编译结果为 998 个双向车道组、1049 条单向边、3045 条有向车道记录。
4. 单向边位于自身中心线，双向边中心间距为 0.36 m。
5. 路径端点使用边自身坐标，不被节点坐标覆盖。

### 16.2 视觉与方向

1. 四类节点通过形状和颜色明确区分。
2. 所有方向性节点通过四个基准角测试，人工观察方向正确。
3. 所有路径流光从 `sourceNodeId` 指向 `targetNodeId`。
4. 双向车道无 Z-fighting，单向边无无意义侧移。
5. 初始视角下完整 `renderBounds` 位于画面 5% 安全区内。
6. Bloom 不使基础路径和背景整体发糊。
7. 反射、网格、雾和阴影存在且不遮蔽拓扑。

### 16.3 体验、性能与稳定性

1. 加载进度来自真实阶段和处理数量，始终单调。
2. 任一加载错误进入明确错误状态，不显示不完整场景。
3. OrbitControls 行为平滑，极角、距离和地面边界受控。
4. 4K 和 1080p 的 P95 帧时间达到 §11.2 指标。
5. 24 小时目标机浸泡测试无持续内存增长。
6. 卸载后 Worker、事件监听和 GPU 资源全部释放。

---

## 17. 未来迭代边界

后续能力必须以新增独立图层和应用用例的方式接入：

- AGV 实时位置和状态图层。
- 路径规划与高亮图层。
- `zones` 和 `nodeEdgeGroups` 图层。
- 搜索、筛选、详情等业务交互。
- 多地图资产和后端数据网关。

当前版本不创建这些能力的空组件、空 Store、兼容接口或 feature flag。新增需求进入实施前，必须先修订领域模型、状态流和验收标准。
