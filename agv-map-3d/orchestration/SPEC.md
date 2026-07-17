# Overlook 地图 3D 复刻规格（R3F，真实样本校准版）

> 文档版本：2.0
>
> 产品里程碑：v1（只读地图浏览）
>
> 唯一数据基准：`C:\code\ai-opc\agv-map-3d\data`

本文定义一个全新、独立的 React Three Fiber 地图查看器。实现只复刻节点、路径、方向箭头、标签、地面、光照和相机浏览，不复用旧系统代码，也不兼容旧类型、旧字段或旧行为。

文中的“必须”“禁止”为验收条件；“应”为强建议，偏离时必须在实现记录中给出可验证理由。真实样本与文字描述冲突时，以本节指定哈希的样本和本文明确的数据边界为准，不允许自行猜测或静默降级。

---

## 1. 目标、范围与非目标

### 1.1 目标

- 在浏览器中准确展示真实样本的 1,767 个节点和 3,043 条有向边。
- 保留一米对应一个 Three.js 世界单位的几何尺度，同时通过场景重心平移改善浮点精度。
- 用合并几何、实例化和按需标签挂载满足当前样本与八倍压力样本的性能目标。
- 把数据解析、领域模型、几何生成、渲染资源和 R3F 展示分层，任何 R3F 组件都不得直接读取原始 JSON。
- 所有关键规则均由纯函数表达，并可通过固定样本、数学断言和视觉基线验收。

### 1.2 v1 包含

- 四类节点：`node`、`work`、`park`、`charge`。
- 两类边：`LINE`、`BEZIER`。
- 节点朝向箭头和每条边的行驶方向箭头。
- 节点名和边名标签；标签始终朝向相机并按视锥、投影尺寸和数量上限懒挂载。
- 深色有限地面、基础光照、透视相机、轨道浏览、键盘浏览和一键复位。
- 加载中、数据错误、字体错误、WebGL 不可用和 WebGL 上下文丢失的明确状态。

### 1.3 v1 明确排除

- 车辆、交通管制、设备、动作角标、网格、热力图、选区和地图编辑。
- 点击、选择、hover、右键菜单、tooltip、拖拽节点或控制点等对象交互。
- API、WebSocket、鉴权、权限、i18n、主题切换和业务弹窗。
- `zones` 与 `nodeEdgeGroups` 的渲染；样本中二者必须为空，非空时整体拒绝加载。
- 任何旧节点类型、旧缩放机制、旧优化开关、旧数据迁移、兼容层、deprecated 分支或 fallback 展示。

“无对象交互”不等于“无相机交互”。Orbit、pan、zoom、键盘导航和 Home 复位均属于 v1 的只读浏览能力。

---

## 2. 真实样本基线

### 2.1 文件身份与提取路径

| 项目 | 固定值 |
|---|---:|
| 文件 | `data/sampleMap.json` |
| 字节数 | 6,597,038 |
| 行数 | 138,411 |
| SHA-256 | `DCE8427D3516E2F8F571AB66CF97D4A645939EE13CC62C7EB1A04846B376B813` |
| 响应状态 | `code = 200`、`message = "success"` |
| 地图 ID | `eca3f1d5803247148085688b971c54fb` |
| 地图名 | `中环大地图` |
| 楼层 | `1` |
| 地图状态 | `ENABLED` |
| 地图版本 ID | `109` |
| 版本 | `V1784091415507` |

样本不是裸 `MapJson`，唯一合法提取路径是：

```text
response.data.currentMapInfoVersion.mapJson
```

`mapJson` 只有 `nodes`、`edges`、`zones`、`nodeEdgeGroups` 四个顶层字段。实现不得从根对象直接读取 `nodes` 或 `edges`，也不得把 `mapJson` 当作 JSON 字符串再次解析。

### 2.2 数量与类型

| 项目 | 数量 |
|---|---:|
| 节点总数 | 1,767 |
| `node` | 1,303 |
| `work` | 389 |
| `park` | 64 |
| `charge` | 11 |
| 边总数 | 3,043 |
| `LINE` | 2,934 |
| `BEZIER` | 109 |
| `isBackEdge = false` | 2,165 |
| `isBackEdge = true` | 878 |
| 节点朝向箭头 | 464 |
| 边方向箭头 | 3,043 |
| 标签候选总数 | 4,810 |
| `zones` | 0 |
| `nodeEdgeGroups` | 0 |

样本没有 `warehouse`、`shelf`、`warehouse_back` 或 `warehouse_font`。这些值不属于本系统的类型联合，遇到时必须报错，禁止给默认样式。

### 2.3 几何与数据质量

- 节点坐标包围盒：地图 `x ∈ [-165.74, 2.10]`、地图 `y ∈ [-25.12, 50.20]`。
- 基准宽度 `167.84m`，深度 `75.32m`，地图中心 `(-81.82, 12.54)`。
- 最短直线边弦长 `0.04m`；共有 517 条边的弦长小于 `0.30m`，固定 0.30m 箭头不可用。
- 109 条贝塞尔边的控制点均为有限数；2,934 条直线边的四个控制点字段均为 `null`。
- 无重复节点 ID、无重复边 ID、无悬空引用、无自环、无零长度边、无非有限坐标。
- 272 个边起点、297 个边终点与所引用节点坐标不完全相同，共涉及 482 条边记录；最大起点偏差 `0.013m`，最大终点偏差 `0.030m`。
- 坐标最多包含约 16 至 17 位小数。解析、转换和几何计算禁止人为取整。

边自身的 `sx/sy/ex/ey/cx/cy/dx/dy` 是显示几何的唯一事实来源；`snodeId/enodeId` 只表示拓扑关系。不得用节点坐标覆盖边端点。

### 2.4 重合轨迹事实

- 共有 2,064 条唯一物理轨迹。
- 979 个轨迹组精确反向重合，共涉及 1,958 条边；每组恰好两条、方向相反。
- 其中 977 组为直线，2 组为贝塞尔。
- 868 组的样式组合为 `false/true`，111 组为 `false/false`，没有 `true/true`。
- 另有 997 对反向拓扑边，其中 18 对几何并不精确反序；这 18 对不得误判为重合轨迹。

因此，`isBackEdge` 只能决定颜色，不能用来推断几何是否重合、是否反向，也不能反转箭头。

### 2.5 角度、名称与字体

- 1,303 个 `node` 的 `angle` 全部为 `null`。
- 464 个非 `node` 节点的 `angle` 全部为有限弧度值，约位于 `[-π, π]`，存在近似值而非精确的 `π/2`。
- 节点箭头的判定规则固定为 `type !== "node"`，不得读取不存在的 `showArrow` 字段。
- 66 个节点名称包含中文，边名均为数字字符串，最长名称为 6 个 Unicode code point。
- 样本使用到的中文字符集合为 `丝充制口抛桩点电碱站绒网门`。

角度比较必须使用数值计算或容差，禁止与 `Math.PI / 2` 等常量做字符串比较或精确相等判断。

### 2.6 固定回归样例

| 用途 | ID / 值 |
|---|---|
| 普通节点 | `d0f03a8cbbda4c0db552804327a3eca0`，地图坐标 `(0.16, -21.29)`，名称 `2` |
| 中文充电节点 | `178744a47a574902aa2a9a2f0b589bdf`，地图坐标 `(-139.35, 13.6)`，名称 `门口充电桩1` |
| 直线边 | `d59c4b420b78410db1d6634b999a7d7e`，`(-1.82,-21.3) → (-1.82,-22.32)` |
| 贝塞尔边 | `7d85a192ccc7465d95944c62ed0ea0e5`，`S(-85.07,2.94)`、`C1(-85.07,2.44)`、`C2(-84.57,1.94)`、`E(-84.07,1.94)` |
| 最大端点偏差示例 | `a1ff1b1cc1e54f368a63219402130e58`，边终点 `(-120.32,-1.35)`，节点 `(-120.35,-1.35)` |
| 最短反向边对 | `fd4326119a754ccca73cfac11791b4e3`、`291261571e3e41db924d47b7f0452de3`，弦长均为 `0.04m` |
| `false/false` 重合对 | `7a9e751a83bf462bad3beec0a359e532`、`be0a26966b784dccb33717918c22cc81` |
| `false/true` 重合对 | `0729d7e682d74e18bf35d1d070ea7095`、`4e9045b85995454a9953b0dc21c88645` |

回归测试必须同时按上述完整 ID 和数据特征交叉查询，不得依赖数组下标。若实体 ID 存在但几何特征不符，样本身份测试必须失败。

---

## 3. 工程边界与技术基线

### 3.1 独立工程

目标工程固定在 `C:\code\dd\overlook-3d-r3f-replica`，拥有独立的 `package.json`、`package-lock.json`、TypeScript 配置、构建配置和测试配置。禁止导入或修改现有 Umi、Konva、G6、Ant Design 或旧地图模块。

`data/sampleMap.json` 是唯一可编辑样本。`predev` 与 `prebuild` 脚本把它按原始字节复制到被 `.gitignore` 排除的 `public/generated/sampleMap.json`，复制前必须校验 SHA-256。生成副本不是第二事实来源，不得手工修改或提交。

浏览器运行时只请求 `/generated/sampleMap.json`。没有远程 API、备用 URL、内嵌小样本或请求失败后的降级地图。

### 3.2 固定依赖

| 依赖 | 精确版本 |
|---|---:|
| Node.js | `24.16.0` |
| Vite | `8.1.3` |
| TypeScript | `7.0.2` |
| React | `19.2.7` |
| React DOM | `19.2.7` |
| three | `0.185.1` |
| `@react-three/fiber` | `9.6.1` |
| `@react-three/drei` | `10.7.7` |
| `troika-three-text` | `0.52.4` |
| Vitest（dev） | `4.1.10` |
| `@playwright/test`（dev） | `1.60.0` |

必须提交 lockfile，CI 使用 `npm ci`。`troika-three-text` 作为直接依赖安装，并通过 npm `overrides` 保证 drei 与应用解析到同一个 `0.52.4`，避免重复 worker 与字体缓存。实现和验收期间不得使用 `latest`、范围版本或自动升级；若升级，先更新本表并重新跑完整验收。

### 3.3 固定目录与依赖方向

```text
overlook-3d-r3f-replica/
├─ public/
│  ├─ generated/                     # 构建前生成，不提交
│  └─ fonts/                         # 字体子集、许可证、字形清单
├─ scripts/                          # 样本同步与哈希校验
├─ src/
│  ├─ domain/                        # 领域类型、错误、纯数学
│  ├─ adapters/                      # 原始响应到领域模型的唯一入口
│  ├─ application/                   # 加载状态机与 SceneModel 编排
│  ├─ workers/                       # JSON 解析、验证、几何预计算
│  ├─ geometry/                      # ribbon、箭头、bounds 纯函数
│  ├─ labels/                        # 标签描述符、空间索引、可见集
│  ├─ rendering/                     # Three 资源创建与释放
│  ├─ scene/layers/                  # 只消费 SceneModel 的 R3F 图层
│  ├─ camera/                        # fit、裁剪面、controls、键盘
│  ├─ ui/                            # loading/error/legend/a11y
│  └─ config/                        # 唯一视觉与性能常量表
└─ tests/
   ├─ unit/
   ├─ fixture/
   ├─ integration/
   ├─ visual/
   └─ performance/
```

依赖方向固定为：

```text
domain ← adapters / geometry / labels ← application / workers
       ← rendering ← scene / camera / ui
```

- `domain` 不依赖 React、R3F、Three 或浏览器 API。
- worker 不创建 `THREE.Object3D`、Geometry、Material 或 React 状态，只输出可转移的 typed array 与不可变描述符。
- `rendering` 是 typed array 到 Three 资源的唯一适配层，并拥有资源释放职责。
- `scene/layers` 不解析数据、不拼几何、不决定业务规则，只装配资源。
- 禁止跨层回读原始 JSON、全局可变单例、隐藏缓存和组件内重复坐标转换。

---

## 4. 数据流、状态流与资源所有权

### 4.1 数据流

```text
data/sampleMap.json
  → 构建前哈希校验与字节复制
  → scene-build.worker 请求并 JSON.parse
  → parseSampleEnvelope 严格校验
  → normalizeSceneMap 一次性坐标转换与重心平移
  → buildSceneModel 生成几何数组、实例矩阵、标签描述符、bounds
  → postMessage 转移 ArrayBuffer
  → rendering 创建 Three 资源
  → R3F 图层只读展示
```

任何箭头、标签或 camera fit 都必须消费同一个 `SceneModel`，不得分别从原始边或节点重复推导一套坐标。

### 4.2 显式状态机

```text
idle → loading → preparing → ready
                ↘ error
```

| 状态 | 含义 | 可见 UI |
|---|---|---|
| `idle` | 尚未开始 | 空容器 |
| `loading` | worker 正在请求样本 | 加载提示与文件名 |
| `preparing` | 解析、校验、几何构建中 | 加载提示与阶段名 |
| `ready` | SceneModel、GPU 资源、本地字体和字形清单均成功 | 地图与图例 |
| `error` | 任一步骤失败 | 稳定错误码、中文原因、上下文字段；不显示部分地图 |

每次加载分配单调递增的 `requestId`。只有当前 `requestId` 的 worker 结果可以提交；过期结果必须释放其 ArrayBuffer 引用。状态转换只能由 application 层 reducer 完成，禁止多个组件分别维护“是否加载完成”。

### 4.3 生命周期

- 组件卸载、HMR 或重新加载时必须终止旧 worker。
- 所有 Geometry、Material、Texture、Troika 文本对象和事件监听器必须由创建它们的模块成对释放。
- React StrictMode 下初始化与清理必须幂等，禁止重复注册 controls 事件或泄漏 GPU 资源。
- WebGL context lost 时暂停提交并显示错误；context restored 后从不可变 `SceneModel` 重建资源，不重新解释一套规则。
- 字体加载失败、缺字、样本哈希失败、JSON 解析失败和 WebGL 不可用均进入 `error`，禁止切换系统字体或画简化地图。

---

## 5. 数据契约与严格校验

### 5.1 只声明被消费字段

```ts
/*
 * 原始 DTO 只描述渲染管线实际消费的字段。
 * 样本中的业务元数据允许存在，但适配器不会把它们带入领域层。
 */
type NodeType = "node" | "work" | "park" | "charge";
type EdgeType = "LINE" | "BEZIER";

interface RawNode {
  id: string;
  name: string;
  type: NodeType;
  mapId: string;
  x: number;
  y: number;
  angle: number | null;
}

interface RawEdgeBase {
  id: string;
  name: string;
  mapId: string;
  snodeId: string;
  enodeId: string;
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  isBackEdge: boolean;
}

interface RawLineEdge extends RawEdgeBase {
  edgeType: "LINE";
  cx: null;
  cy: null;
  dx: null;
  dy: null;
}

interface RawBezierEdge extends RawEdgeBase {
  edgeType: "BEZIER";
  cx: number;
  cy: number;
  dx: number;
  dy: number;
}

type RawEdge = RawLineEdge | RawBezierEdge;
```

`parseSampleEnvelope(input: unknown)` 是唯一 `unknown → RawMap` 边界。它必须逐字段验证，不能使用未经校验的类型断言，也不能把任意字符串强转为联合类型。

### 5.2 领域模型

```ts
/*
 * 领域模型已经完成坐标转换和场景重心平移。
 * 字段名使用 x/z，后续模块禁止再把 z 当成原始地图 y。
 */
interface ScenePoint {
  readonly x: number;
  readonly z: number;
}

interface SceneNode {
  readonly id: string;
  readonly name: string;
  readonly type: NodeType;
  readonly position: ScenePoint;
  readonly angle: number | null;
}

interface SceneLineEdge {
  readonly kind: "line";
  readonly id: string;
  readonly name: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly start: ScenePoint;
  readonly end: ScenePoint;
  readonly isBackEdge: boolean;
}

interface SceneBezierEdge {
  readonly kind: "cubic";
  readonly id: string;
  readonly name: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly start: ScenePoint;
  readonly control1: ScenePoint;
  readonly control2: ScenePoint;
  readonly end: ScenePoint;
  readonly isBackEdge: boolean;
}

type SceneEdge = SceneLineEdge | SceneBezierEdge;
```

不得在领域模型中保留未使用的 `actions`、速度、载荷、车辆组、facing 或 user-defined 字段。需要新能力时先扩充领域用例和校验，再扩充 DTO；不得为“以后可能有用”搬运整个原始对象。

`SceneMap` 是适配后的不可变领域数据；`SceneModel` 是 worker 交付给渲染层的唯一结果：

```ts
/*
 * SceneModel 只保存渲染所需的最终数组、标签描述符和数值 bounds。
 * worker 不跨线程传递 Three 对象，主线程也不回读原始 JSON 重新推导几何。
 */
interface SceneModel {
  readonly metadata: {
    readonly mapId: string;
    readonly mapName: string;
    readonly version: string;
  };
  readonly transform: {
    readonly absoluteWorldOriginX: number;
    readonly absoluteWorldOriginZ: number;
  };
  readonly nodeMatrices: Float32Array;
  readonly nodeColors: Float32Array;
  readonly nodeArrowMatrices: Float32Array;
  readonly nodeArrowColors: Float32Array;
  readonly edgeArrowMatrices: Float32Array;
  readonly edgeArrowColors: Float32Array;
  readonly ribbonPositions: Float32Array;
  readonly ribbonColors: Float32Array;
  readonly labels: readonly LabelDescriptor[];
  readonly contentBounds: NumericBox3;
  readonly diagnostics: SceneDiagnostics;
}

interface NumericBox3 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

interface LabelDescriptor {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "operational-node" | "node" | "edge";
  readonly text: string;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly anchorZ: number;
  readonly localOffsetX: number;
  readonly localOffsetY: number;
}

interface SceneDiagnostics {
  readonly nodeCount: number;
  readonly nodeArrowCount: number;
  readonly edgeArrowCount: number;
  readonly ribbonVertexCount: number;
  readonly labelCandidateCount: number;
  readonly pairedTrackCount: number;
}
```

typed array 的长度必须由诊断计数交叉校验，例如矩阵为 `count × 16`、RGB 为 `count × 3`、非索引 position 为 `vertexCount × 3`。ArrayBuffer 通过 transfer list 移交后，worker 不得再次访问。

实例矩阵固定采用 Three.js `Matrix4.toArray` 兼容的列主序，组合顺序为 `T × R × S`，平移位于索引 12、13、14。所有 color typed array 保存线性 sRGB 的 `[0,1]` 浮点值；worker 必须使用标准 sRGB transfer function 把本文 hex 输入转为线性值，禁止把 8-bit sRGB 直接除以 255 后当作线性颜色。

### 5.3 必须通过的校验

1. 根对象存在且 `code === 200`、`message === "success"`。
2. 提取路径存在，`mapJson` 是对象，四个集合字段均为数组。
3. `zones` 和 `nodeEdgeGroups` 为空。
4. `mapId`、版本中的 `mapId`、每个节点和每条边的 `mapId` 一致。
5. 节点与边 ID 分别非空且唯一；名称是非空字符串。
6. 节点类型只允许四个固定值；边类型只允许两个固定值。
7. 所有参与几何的数值均为有限数，禁止 `NaN`、`Infinity` 和数字字符串。
8. `LINE` 的四个控制字段全部为 `null`；`BEZIER` 的四个控制字段全部为有限数。部分为空属于错误。
9. 每条边的 `snodeId`、`enodeId` 必须引用存在的节点，且二者不同。
10. 边的弦长大于 `1e-9m`；用于箭头的切线长度大于 `1e-9m`。
11. 普通 `node` 的 `angle` 必须为 `null`；其余三类的 `angle` 必须为有限数。
12. 边端点到引用节点的距离分别不得超过 `0.05m`，但通过校验后仍使用边端点绘图。
13. 精确轨迹组最多两条；两条时必须方向相反。出现三重轨迹或同向重复属于数据错误。

失败时抛出结构化 `MapDataError`，至少包含 `code`、JSON path、实体 ID 和可读消息。禁止跳过坏实体、补零、猜测控制点、给未知类型默认颜色或只画通过校验的部分数据。

---

## 6. 坐标、精度与统一转换

### 6.1 唯一坐标规则

地图二维坐标先映射到 Three 绝对世界：

```text
absoluteWorld = (mapX, 0, -mapY)
```

适配器先用全部节点坐标及边的端点、贝塞尔控制点计算二维 source bounds，再以其中心作为场景原点。真实样本的 source bounds 与节点 bounds 相同，所以绝对世界原点为 `(-81.82, 0, -12.54)`。所有几何统一减去该原点：

```text
sceneX = mapX + 81.82
sceneZ = 12.54 - mapY
worldY = 各渲染层固定高度
```

转换后的节点基准范围约为 `sceneX ∈ [-83.92, 83.92]`、`sceneZ ∈ [-37.66, 37.66]`，中心接近原点。

### 6.2 实现约束

- `toScenePoint(mapX, mapY, origin)` 是适配层唯一转换函数。
- `origin` 必须由已验证的 source bounds 计算并作为显式 `MapTransform` 传递，禁止把 `81.82/12.54` 散落为样本专用魔法数。
- 节点、边端点、贝塞尔控制点和以后可能加入的平面坐标都必须走此函数。
- 几何层、标签层和 R3F 层只能接收 `ScenePoint{x,z}`，禁止再次取负、交换轴或平移。
- 高度始终使用单独的 `worldY`，禁止把地图 y 与 Three y 混用。
- 内部全程使用 JavaScript `number`；写入 GPU typed array 时才转换为 `Float32`。
- 显示格式可以舍入，几何数据和测试断言不得舍入。

固定例子：

| 原始点 | 场景点 |
|---|---|
| 普通节点 `(0.16, -21.29)` | `(81.98, 33.83)` |
| 中文充电节点 `(-139.35, 13.60)` | `(-57.53, -1.06)` |
| 直线起点 `(-1.82, -21.30)` | `(80.00, 33.84)` |

---

## 7. 视觉常量、材质与渲染层

### 7.1 唯一常量表

| 常量 | 值 |
|---|---:|
| 世界单位 | `1 unit = 1m` |
| 普通节点半径 | `0.10m` |
| `work/park/charge` 半径 | `0.15m` |
| 节点高度 | `0.05m` |
| 节点圆柱分段 | `24` |
| 单条边宽度 | `0.05m` |
| 成对边单侧中心偏移 | `0.03m` |
| 贝塞尔分段数 | `32`（即 33 个点） |
| 边箭头最大长度 | `0.30m` |
| 标签字号 | `0.20m` |
| Ground Y | `0.000` |
| Ribbon Y | `0.006` |
| Edge Arrow Y | `0.014` |
| Node Bottom Y | `0.010` |
| Node Top Y | `0.060` |
| Node Arrow Y | `0.066` |
| Label Anchor Y | `0.250` |

所有常量只定义在 `src/config/mapVisualConfig.ts`。禁止组件内魔法数字或同义配置。

### 7.2 颜色

| 对象 | 颜色 |
|---|---|
| 背景 | `#111318` |
| 地面 | `#1A1A1A` |
| `node` | `#78909C` |
| `work` | `#2196F3` |
| `park` | `#F44336` |
| `charge` | `#8BC34A` |
| `isBackEdge = false` | `#BDBDBD` |
| `isBackEdge = true` | `#E57373` |
| 标签 | `#FFFFFF` |

### 7.3 材质、灯光与色彩空间

- renderer：`outputColorSpace = SRGBColorSpace`、`toneMapping = NoToneMapping`、`antialias = true`、`powerPreference = "high-performance"`。
- Canvas DPR 固定夹在 `[1, 1.5]`，禁止直接使用无限制设备 DPR。
- Ground：`MeshStandardMaterial`，`roughness = 1`、`metalness = 0`。
- Node：一个 `MeshStandardMaterial`，白色 base color 乘 `InstancedMesh.instanceColor`，`roughness = 0.8`、`metalness = 0`。
- Ribbon：`MeshBasicMaterial`，`vertexColors = true`、`toneMapped = false`。
- 两类箭头：白色 base color 的 `MeshBasicMaterial` 乘各自 `InstancedMesh.instanceColor`，`toneMapped = false`；几何本身不重复存颜色。
- Ribbon 开启 `polygonOffset`，`factor = -1`、`units = -1`；所有实体保留 `depthTest = true`。
- Node Arrow 使用 `depthWrite = false`，避免与圆柱顶面争夺深度。
- Text 使用 `depthTest = false`、`depthWrite = false`、`toneMapped = false`，以复刻始终可读的 2D 标签语义。
- 半球光：天空 `#FFFFFF`、地面 `#202020`、强度 `0.8`。
- 方向光：白色、强度 `1.0`、位置 `(80,120,60)`。
- v1 不启用阴影，不创建 shadow map。

颜色表定义材质输入色，不承诺受光节点最终像素与 hex 完全相同。基础材质的边和箭头不受灯光改变。

### 7.4 提交顺序

| 图层 | `renderOrder` | 预计 draw call |
|---|---:|---:|
| Ground | 0 | 1 |
| Ribbons | 10 | 1 |
| Edge Arrows | 20 | 1 |
| Nodes | 30 | 1 |
| Node Arrows | 40 | 1 |
| Labels | 50 | 每个已挂载 Text 至多 1 |

`renderOrder` 只规定提交顺序，不替代实体深度测试。初始总览标签为 0 个，地图实体 draw call 必须不超过 5。

---

## 8. 节点与节点箭头

### 8.1 节点

- 所有 1,767 个节点使用一个 `InstancedMesh`。
- 共享 `CylinderGeometry(1, 1, 0.05, 24)`，实例按节点半径缩放 X/Z，Y 不缩放。
- 实例中心 Y 为 `0.035`，因此底面 `0.010`、顶面 `0.060`。
- 实例矩阵和颜色在 worker 生成；主线程只填入 `InstancedBufferAttribute` 和 instance matrix。
- 普通节点无朝向箭头；其 `angle = null` 不得替换为零。

### 8.2 节点箭头

节点箭头共享一个位于 XZ 平面、局部朝 `+X` 的三角形：

```ts
/*
 * 基准箭头不包含任何节点角度；每个实例只在矩阵中旋转一次。
 * 顶点顺序从 +Y 观察为逆时针，确保正面朝上。
 */
const NODE_ARROW_VERTICES = [
  0.5, 0,  0.0,
  0.0, 0, -0.5,
  0.0, 0,  0.5,
];
```

- 只为 `work/park/charge` 创建实例，样本固定 464 个。
- X/Z 按节点半径等比缩放，位置为节点中心的 X/Z 与 `Y = 0.066`。
- 实例只执行 `rotationY = angle`；禁止先预旋转顶点再旋转实例。
- Three.js 的方向验收：`0 → +X`，`+π/2 → -Z`，`-π/2 → +Z`。
- 箭头色从 `#111111` 与 `#FFFFFF` 中选择。按 WCAG 相对亮度计算其与节点基色的对比度，选较高者；同一节点类型结果必须稳定。
- 箭头使用一个带 instance color 的 `InstancedMesh`，不得按类型拆成多个 mesh。

---

## 9. 边轨迹、双车道与 ribbon

### 9.1 边语义

- 每条边从自身 `start` 指向自身 `end`；边箭头永远表示这个方向。
- `isBackEdge` 只选择灰色或红色，不改变点序、切线、箭头或标签位置。
- LINE 使用 2 个中心线点。
- BEZIER 是标准三次贝塞尔，固定 `BEZIER_SEGMENTS = 32`，按 `t = i / 32` 产生 33 个点、32 段。
- “32 段”和“33 点”在代码、测试和文档中必须保持一致。

### 9.2 精确反向轨迹识别

匹配容差为 `TRACK_MATCH_EPSILON = 1e-6m`。

- LINE 正向序列为 `[S,E]`，反向序列为 `[E,S]`。
- BEZIER 正向序列为 `[S,C1,C2,E]`，反向序列为 `[E,C2,C1,S]`。
- 先按 `1e-6` 量化构建无向候选桶，再用原始双精度坐标逐项确认最大差不超过 `1e-6`。只用字符串取整 key 而不二次确认不合格。
- 拓扑反向但控制点不精确反序的 18 对边保持各自中心线，不进入双车道组。
- 轨迹组大于 2、同向重复或混合边类型时整体报错。

### 9.3 双车道规则

- 单边轨迹中心偏移为 `0`，宽度 `0.05m`。
- 精确反向成对时，两条边仍各自保持 `0.05m` 宽。
- 每条边沿自身行驶方向的左法线偏移 `0.03m`。反向边的左法线天然相反，所以两条中心线相距 `0.06m`，边缘之间保留 `0.01m` 可见间隔。
- ribbon、边箭头和边标签锚点必须共同使用同一个 `laneOffset`；禁止只错开线而让箭头或标签留在原轨迹。
- 两条同为 `isBackEdge = false` 的 111 组也必须错开，因为重合由几何决定而非颜色决定。
- 不去重、不合并业务边、不以后绘制者覆盖前者。

曲线车道按每个采样点的局部左法线偏移。端点用首尾段法线，内部点使用相邻归一化切线之和求稳定法线；相邻切线和长度小于 `1e-9` 时属于不支持的 U 形折返数据并报错。

### 9.4 ribbon 三角化

采用非索引 `BufferGeometry`，不固定假设 `Uint16` 索引容量，也不使用不存在的 `Float32Attribute`。

1. 对偏移后的中心线删除与前一点距离 `< 1e-9m` 的连续重复点；少于 2 点时报错。
2. 每段求单位切线 `(tx,tz)` 和左法线 `(-tz,tx)`，半宽固定 `0.025m`。
3. 每段生成一个独立 quad，使用 6 个非索引顶点。
4. 从 `+Y` 观察，quad 三角形顺序固定为 `[startLeft,endRight,startRight]` 与 `[startLeft,endLeft,endRight]`，正面法线为 `+Y`。
5. 内部点统一使用 bevel join：相邻 quad 的外侧缺口由一个三角形连接“上一段外点、中心点、下一段外点”；根据转向符号交换两个外点，使该三角形从 `+Y` 观察也始终为逆时针。内侧允许同色三角形重叠，不产生裂缝。
6. 首尾使用 butt cap，既不延长中心线，也不添加圆帽或方帽。
7. position 与 color 分别写入 `Float32BufferAttribute`；材质不需要 normal。完成后必须计算 `boundingBox` 和 `boundingSphere`。
8. 所有输出 position、color、bounds 都必须是有限数；任何 NaN 立即使构建失败。

样本上限约为 48,669 个 ribbon 非索引顶点，必须合并为一个 Mesh。不得为每条边创建 Mesh、Line 或 React 组件。

---

## 10. 边方向箭头

### 10.1 单一基准几何

所有 LINE 与 BEZIER 共用一个局部朝 `+X` 的单位三角形和一个 `InstancedMesh`：

```ts
/*
 * tip 位于局部原点，箭身沿 -X 后伸。
 * [tip,right,left] 的顶点顺序保证三角形正面朝 +Y。
 */
const EDGE_ARROW_VERTICES = [
   0, 0,  0,
  -1, 0, -0.55,
  -1, 0,  0.55,
];
```

禁止分别为直线和曲线定义两个形状，禁止把方向预烘焙到顶点。

### 10.2 位置、尺寸与旋转

- 复用 ribbon 中的偏移后折线及累计弧长。
- 箭头 tip 位于总弧长的 `40%` 处，而不是简单假定贝塞尔参数 `t = 0.4` 等于弧长比例。
- 箭头长度 `L = min(0.30m, totalArcLength × 0.32)`；X/Z 实例缩放均为 `L`，所以半宽为 `0.55L`。
- `0.32 < 0.40` 保证最短 `0.04m` 直线的箭身不会越过起点；不得再使用固定 0.30m 长度。
- 箭头位置已经包含双车道偏移，Y 固定为 `0.014`。
- 从箭头所在折线段取得归一化场景切线 `(tx,tz)`，旋转为 `yaw = atan2(-tz, tx)`。
- 实例色直接使用该边颜色；样本实例数固定为 3,043。

对于切线长度不大于 `1e-9` 的数据，构建失败；禁止随便取前一段、后一段或零角度作为降级。

---

## 11. 标签内容、定位与按需挂载

### 11.1 字体与文字语义

- 随项目打包 `public/fonts/NotoSansSC-Bold.sample.woff`、对应开源许可证和 `glyphs.json`。
- 字体子集至少包含 ASCII `U+0020–U+007E` 与样本中文集合 `丝充制口抛桩点电碱站绒网门`。
- 构建脚本必须逐 code point 校验全部 4,810 个名称都在 `glyphs.json` 中；缺字直接失败。
- 进入 `ready` 前调用 Troika `preloadFont`，显式传本地 `.woff` URL 和全部去重名称字符；只有回调成功后才允许挂载标签。
- `.woff` 是 Troika 明确支持的格式，本项目不生成其不支持的 `.woff2`。格式依据见 [Troika Text 官方文档](https://protectwise.github.io/troika/troika-three-text/)。
- 生产响应头必须至少配置 CSP `font-src 'self'` 与 `connect-src 'self'`，从网络层阻止 Troika 默认 Unicode CDN；不得用会阻断 Troika 本地 worker 的 `worker-src` 或 `script-src` 策略。最终 CSP 集成测试必须证明本地字体和两个 worker 均可运行、外部字体请求被拒绝。
- 禁止远程字体、系统字体 fallback、Unicode CDN、运行时字体替换或 Canvas 文本压缩；若预检遗漏字符，必须进入 `FONT_GLYPH_MISSING`，而不是让 Troika 自行补字。
- Troika Text：`fontSize = 0.20`、`sdfGlyphSize = 64`、`gpuAccelerateSDF = false`、`whiteSpace = nowrap`、无 `maxWidth`，颜色白色。关闭实验性 GPU SDF 以保证基线确定性；粗细由 `NotoSansSC-Bold.sample.woff` 文件本身提供，不依赖 Troika 只用于 Unicode fallback 选择的 `fontWeight` 属性。

### 11.2 标签锚点

- 每个节点产生一个轻量 `LabelDescriptor`。Billboard 锚点为节点 `(x,0.250,z)`；Text 局部偏移为 `(radius × 1.5, -radius × 1.5, 0)`，`anchorX = left`、`anchorY = top`，即屏幕右下方。
- 每条 LINE 的标签基点为边几何 `1/3` 处；每条 BEZIER 为参数 `t = 2/3` 处。
- 成对轨迹的边标签先应用同一 `laneOffset`，再在场景平面加 `(x + 0.20, z + 0.20)`；Y 为 `0.250`，`anchorX = center`、`anchorY = top`。
- 标签不参与 camera fit 或地面尺寸计算。

节点标签和边标签的定位公式不同，必须由两个纯函数实现；禁止用一个带隐式分支的巨型函数。

### 11.3 空间索引与可见集

启动时只建立 4,810 个 `LabelDescriptor` 和 4m uniform-grid，不创建任何 Troika Text。

| 常量 | 值 |
|---|---:|
| 网格边长 | `4.0m` |
| cell 视锥外扩 | `1.5m` |
| 进入阈值 | `10px` |
| 退出阈值 | `8px` |
| 最大已挂载标签 | `400` |
| 相机移动中查询频率 | 至多 `10Hz` |

可见集算法固定如下：

1. 用当前 camera view-projection matrix 构造 frustum。
2. 对最多约 331 个占用 cell 的 AABB 做 frustum test；AABB 在 X/Z 各外扩 1.5m。
3. 对命中 cell 内的描述符再做精确 frustum test。
4. 对每个候选点 `p`，把相机局部 `+Y` 用 camera world quaternion 转成 `cameraScreenUp`，再投影 `p` 与 `p + cameraScreenUp × 0.20m`；两者 NDC y 差的绝对值乘 `canvasHeight / 2` 得到 `fontPixels`。不得直接把固定世界 `+Y` 当成屏幕竖直方向。
5. 未挂载标签只有 `fontPixels >= 10` 才进入；已挂载标签直到 `fontPixels <= 8` 才退出。
6. 候选超过 400 时按以下稳定顺序截断：`work/park/charge` 节点标签、普通节点标签、边标签；同级按距视口中心的屏幕距离，再按 ID 字典序。
7. 只对差集创建或销毁 Text，不重建整个列表。
8. controls 移动中最多 10Hz 更新候选，`end` 和 resize 后立即更新一次。

禁止给 4,810 个标签全部挂 `<Text visible={false}>`；隐藏但已挂载不算懒加载。

### 11.4 朝向更新

- 禁止每个标签各自注册 `useFrame` 或嵌套一个 `<Billboard>` 控制器。
- 标签根节点保持 identity transform。标签层只有一个帧协调器；在 controls 导致的实际渲染帧中，把 camera world quaternion 批量复制给当前最多 400 个文本对象。
- 标签集合变化走 React 状态；每帧 quaternion 变化直接写对象，不触发 React setState。
- 初始 fit 后所有标签投影字号必须低于进入阈值，因此首屏已挂载 Text 数为 0。

---

## 12. Camera fit、裁剪面、地面与浏览控制

### 12.1 内容 bounds 与地面

`computeContentBounds` 必须合并最终双车道 ribbon、两类箭头和节点圆柱的真实几何 bounds，排除 Ground 与标签。不得只使用节点坐标，也不得在 lane offset 前计算。

Ground 的 X/Z 范围为内容 bounds 每侧增加：

```text
padding = max(5m, max(contentWidth, contentDepth) × 10%)
```

Ground 是有限平面，不参与 fit。背景色负责视口边缘，不允许用“足量大数”平面或无限 far plane。

### 12.2 初始相机与 fit

| 参数 | 值 |
|---|---:|
| Perspective FOV | `50°` |
| 初始 polar angle | `60°`，从 `+Y` 量起 |
| 初始 azimuth | `45°`，从 `+X` 朝 `+Z` |
| fit margin | `1.10` |
| bounds 额外世界 padding | `0.50m` |

先确定 3/4 方向，再拟合距离。算法固定为：

```text
verticalFov = radians(50)
horizontalFov = 2 × atan(tan(verticalFov / 2) × aspect)
limitedFov = min(verticalFov, horizontalFov)
target = (boundsCenter.x, 0, boundsCenter.z)
R = target 到 expandedContentBounds 八个角的最大距离
distance = 1.10 × R / sin(limitedFov / 2)
direction = (sin(60°)cos(45°), cos(60°), sin(60°)sin(45°))
camera.position = target + direction × distance
```

`R` 明确以 controls target 为球心，不使用 Y 中心略高于地面的默认 bounding sphere，否则 fit 球心与观察目标不一致。禁止先从俯视角 fit 再旋转到 3/4 视角。初始 fit 后，扩张 bounds 的 8 个角投影必须满足 `|NDC.x| <= 0.92` 且 `|NDC.y| <= 0.92`。

### 12.3 动态 near/far

每次 camera 或 controls 变化时，最多每 animation frame 更新一次：

1. 构造 `clipBounds = expanded content bounds ∪ Ground bounds`，把其 8 个角转换到 camera space。Ground 只参与裁剪面推导，仍不参与 fit。
2. 定义正深度 `depth = -cameraSpace.z`。
3. 若任一点 `depth <= 0`，设 `near = 0.02`；否则 `near = max(0.02, minDepth × 0.8)`。
4. `far = max(near + 1, maxDepth × 1.2, distance(camera,target) + 2 × R)`；每一项都由当前场景推导，不允许任意大常量。
5. 断言 `0 < near < far` 后更新 projection matrix。

禁止把 near/far 固定为未经推导的大数。

### 12.4 OrbitControls

| 参数 | 值 |
|---|---:|
| `minDistance` | `0.50m` |
| `maxDistance` | `8 × R` |
| `minPolarAngle` | `15°` |
| `maxPolarAngle` | `85°` |
| `dampingFactor` | `0.08` |
| `zoomSpeed` | `0.8` |
| `rotateSpeed` | `0.6` |
| `panSpeed` | `1.0` |

rotate、pan、zoom 均启用。每次 controls change 后，把 target.x/z 限制在 Ground 范围内，target.y 固定为 0；clamp 产生的修正向量必须同时加到 camera position，保持 camera-target offset 不变。相机始终位于 Ground 上方。

Canvas 第一次得到非零尺寸且数据 ready 时 fit 一次。用显式 `hasUserNavigated` 记录用户是否已浏览：

- 用户尚未浏览时，resize 重新 fit。
- 用户浏览后，resize 只更新 aspect、near/far 和标签可见集，不重置 target、距离或朝向。
- Home 键重新执行本文规定的标准 3/4 fit，并把 `hasUserNavigated` 设为 `false`。

### 12.5 键盘与无障碍

- Canvas 外层可聚焦，`aria-label` 至少包含地图名、节点数、边数和操作提示。
- 方向键沿相机平面的 right/forward 每次平移当前距离的 5%。
- `+/-` 按 0.9/1.1 比例缩放，`Q/E` 每次绕 target 旋转 5°，Home 复位。
- 所有键盘操作复用 controls 的 clamp 与 near/far 更新函数，不维护第二套相机状态。
- 页面提供静态颜色图例和纯文本操作说明。
- `prefers-reduced-motion: reduce` 时关闭 damping；功能与最终视图不变。

---

## 13. R3F 场景装配与帧调度

```text
<Canvas frameloop="demand">
  <SceneEnvironment />
  <GroundLayer />
  <RibbonLayer />
  <EdgeArrowLayer />
  <NodeLayer />
  <NodeArrowLayer />
  <LazyLabelLayer />
  <MapCameraController />
</Canvas>
<MapLegend />
<LoadOrErrorOverlay />
```

- 静止时使用 `frameloop="demand"`，不得常驻 60 FPS 空转。
- controls change、文本同步完成、资源首次提交、resize、context restore 和键盘操作必须显式 `invalidate()`。
- 图层组件只接受已经完成的资源或只读描述符；禁止在 JSX render 中遍历原始边生成顶点。
- Canvas 不得挂对象点击 handler 或 raycaster 业务逻辑。
- React key 只能使用稳定实体 ID，禁止数组下标。

---

## 14. 错误、诊断与可观测性

### 14.1 稳定错误码

至少定义：

| 错误码 | 场景 |
|---|---|
| `SAMPLE_FETCH_FAILED` | 静态文件请求失败 |
| `SAMPLE_HASH_MISMATCH` | 构建前样本哈希不符 |
| `SAMPLE_JSON_INVALID` | JSON 无法解析 |
| `MAP_ENVELOPE_INVALID` | 响应包或提取路径错误 |
| `MAP_ENTITY_INVALID` | 实体字段、ID、类型或引用错误 |
| `MAP_GEOMETRY_INVALID` | 零长度、无切线、非有限几何或轨迹组异常 |
| `FONT_ASSET_FAILED` | 字体请求或解析失败 |
| `FONT_GLYPH_MISSING` | 名称存在未打包 code point |
| `WEBGL_UNAVAILABLE` | 浏览器无可用 WebGL |
| `WEBGL_CONTEXT_LOST` | 上下文丢失 |

错误 overlay 显示错误码、阶段和简体中文消息；开发环境可附 JSON path 和实体 ID。不得只写 `console.error` 后留下空白画布。

### 14.2 诊断指标

ready 后记录一次只读诊断快照：解析耗时、验证耗时、几何构建耗时、GPU 资源创建耗时、实体数量、ribbon 顶点数、已挂载标签数、draw call 和当前 near/far。诊断不得改变渲染逻辑，也不得把 mutable Three 对象暴露为全局状态。

---

## 15. 测试与验收

### 15.1 样本身份测试

测试开始先校验 SHA-256，然后断言第 2 章全部数量、类型、空集合、中文字符集合和基准 bounds。哈希不符时不得继续跑视觉基线并产生误导结果。

### 15.2 纯函数单元测试

必须覆盖：

- 响应包提取路径和判别联合解析。
- 未知节点/边类型、控制点部分为空、非有限数、重复 ID、悬空引用、自环、超过 0.05m 的端点偏差。
- 非空 `zones/nodeEdgeGroups`、零长度边、零切线、同向重复轨迹和三重轨迹。
- `toScenePoint` 三个固定例子，并断言转换只发生一次。
- LINE 与 BEZIER 反向 canonical 比较；18 个非精确反序对不得分组。
- 样本恰有 979 个双车道组、1,958 条成对边和 2,064 条唯一物理轨迹。
- 每条 BEZIER 恰有 33 个点、32 段；所有输出为有限数。
- ribbon 顶点绕序正面为 `+Y`、butt cap 不越过端点、双车道中心间距为 `0.06m`。
- 节点箭头三个基准角度；每个非普通节点恰有一个箭头。
- 所有边箭头 tip 位于 40% 弧长，短边箭长按比例收缩，箭身不越过起点。
- label anchor、字体像素投影、10/8px hysteresis、400 上限和稳定排序。
- fit、resize 分支、target clamp 以及动态 near/far。

### 15.3 集成断言

真实样本 ready 后必须满足：

| 指标 | 期望 |
|---|---:|
| Node instances | 1,767 |
| Node Arrow instances | 464 |
| Edge Arrow instances | 3,043 |
| Ribbon Mesh | 1 |
| 初始 Text | 0 |
| 初始实体 draw call | `<= 5` |
| 任意时刻 Text | `<= 400` |
| 任意实例矩阵 NaN/Infinity | 0 |
| 初始 bounds 角被裁切 | 0 |

反复挂载/卸载场景 20 次后，worker、事件监听器、Geometry、Material 和 GPU memory 计数不得单调增长。

### 15.4 固定视觉基线

环境固定为生产构建、`@playwright/test 1.60.0` 随附的 Chrome for Testing `148.0.7778.96`、`1920×1080`、Canvas DPR 1。至少保存并审核以下截图：

1. 初始 3/4 全图；验证完整 fit、深色地面和标签为 0。
2. 普通节点 `d0f03a8cbbda4c0db552804327a3eca0`；验证无箭头。
3. 中文充电节点 `178744a47a574902aa2a9a2f0b589bdf`；验证字体、标签锚点、角度和对比色箭头。
4. 贝塞尔边 `7d85a192ccc7465d95944c62ed0ea0e5`；验证曲线、lane、箭头切线和标签。
5. 由测试查询得到的 0.04m 最短边；验证箭头没有越过起点。
6. 一组 `false/true` 和一组 `false/false` 的精确反向边；验证两条 0.05m 车道都可见且无闪烁。
7. 窄视口 `1080×1920` 初始图；验证重新 fit 后不裁切。

视觉差异阈值固定后写入测试配置；不得在失败时临时放宽阈值。首次批准的基线图片与规格版本一起提交。

### 15.5 性能基线

固定环境：Windows 11、Google Chrome `150.0.7871.125` 64-bit、生产构建、`1920×1080`、Canvas DPR 1、16GB 内存、RTX 3060 或同级独显。浏览器扩展关闭，冷启动测 5 次取中位数；帧时间连续采样 10 秒。浏览器版本取自 2026-07-14 的 [Chrome Stable 官方发布记录](https://chromereleases.googleblog.com/2026/07/stable-channel-update-for-desktop_0353146366.html)；升级浏览器后必须建立新的独立性能基线，不能与本基线混算。

真实样本目标：

- worker 开始请求到地图实体首次可见 `<= 2.0s`。
- 首次进入标签阈值并挂载 400 个标签 `<= 200ms`。
- 连续 orbit/pan/zoom 的 P95 frame time `<= 16.7ms`，P99 `<= 25ms`。
- 标签空间查询与差量计算 P95 `<= 8ms`。
- steady-state JS heap `<= 150MB`。
- idle 5 秒内除必要的首次字体同步外不持续提交帧。

压力样本由真实样本确定性生成 4×2 平铺：`col = index % 4`、`row = floor(index / 4)`，ID 加 `tile-{index}:` 前缀，场景平移为 `(col × 187.84m, row × 95.32m)`，所有引用同步改写。固定规模：14,136 节点、24,344 边、38,480 标签候选、3,712 节点箭头、24,344 边箭头。

压力目标：实体首次可见 `<= 5s`、标签隐藏时 P95 frame time `<= 22.2ms`、steady-state JS heap `<= 350MB`，实体 draw call 仍 `<= 5`。

若 400 个 Troika Text 达不到真实样本帧预算，v1 不得通过验收；必须在保持标签语义与可见上限的前提下改为批量文字渲染，并更新架构与视觉基线，禁止靠减少地图实体、降低验收帧率或静默隐藏标签规避。

---

## 16. 完成定义

实现只有同时满足以下条件才算完成：

- 工程独立，依赖和 lockfile 固定，无旧系统导入和兼容代码。
- 样本哈希、解析路径、数量、类型和全部严格校验通过。
- 坐标只转换一次，边几何不被节点坐标覆盖。
- 979 组重合轨迹均按双车道显示，18 个非精确反序对不误分组。
- 节点、边、两类箭头和标签的数量、位置、方向、颜色、层高符合本文。
- 最短边箭头、中文字体、标签懒挂载、初始 fit、resize 和 near/far 均通过自动断言。
- 初始实体 draw call、内存、加载时间和帧时间达到第 15 章目标。
- 错误状态可读，StrictMode/HMR/context restore 生命周期无泄漏。
- 单元、fixture、集成、视觉和性能测试全部通过；没有 NaN、共面闪烁或被裁切内容。

---

## 附录 A：审查问题闭环

| 原问题 | 本版处理 |
|---|---|
| 把样本误写成裸 `MapJson` | 固定 `data.currentMapInfoVersion.mapJson`，增加响应包校验 |
| 数据类型包含样本不存在的旧节点 | 联合类型只保留四种真实类型，未知值报错 |
| “不复用旧代码”与“可直接复制旧函数”冲突 | 明确 clean-room 新实现，禁止旧模块导入 |
| 场景树被当作系统架构 | 增加分层目录、依赖方向、数据流、状态机和资源所有权 |
| 地图 y 到 Three z 存在两套变换 | 适配层一次性 `(x,y) → (x,-y)` 并统一重心平移 |
| 边端点可能被引用节点覆盖 | 明确边坐标用于几何、节点 ID 只用于拓扑 |
| 节点箭头预旋转后又实例旋转 | 统一局部 `+X` 基准三角形，只旋转实例一次 |
| 节点箭头与顶面同色、共面 | 使用黑白最佳对比色并提升到 `Y=0.066` |
| 直线和曲线箭头形状不一致 | 一个单位三角形、一个 InstancedMesh、统一弧长定位 |
| 固定 0.30m 箭头破坏短边 | 按 `min(0.30, 0.32×弧长)` 自适应 |
| 反向重合边互相覆盖 | 几何识别 979 组并按自身左法线双车道偏移 |
| 误用 `isBackEdge` 推断方向 | 该字段只决定颜色，方向永远为 start 到 end |
| ribbon 的采样点/段数矛盾 | 固定 32 段、33 点 |
| ribbon join/cap/winding/index 未定义 | 固定非索引 quad、bevel join、butt cap、`+Y` 绕序 |
| 错写 `Float32Attribute` | 固定 `Float32BufferAttribute` |
| 所有 Text 先挂载再隐藏 | uniform-grid、视锥、像素阈值、hysteresis、400 硬上限 |
| `maxWidth` 被误当成文字压缩 | 移除 `maxWidth`，明确 nowrap 和字体资产 |
| 中文字体和许可证缺失 | 固定本地字体子集、字形清单和许可证 |
| 标签来源点和锚点含糊 | 分别定义节点、LINE、BEZIER 的锚点与偏移 |
| fit 只看节点且先 fit 后倾斜 | 使用最终几何 bounds，先定 3/4 方向再算距离 |
| near/far、地面尺寸是“大数” | 从 camera-space bounds 与内容尺寸推导 |
| resize 会无条件打断用户视图 | 显式 `hasUserNavigated`，仅未浏览时自动 refit |
| “无交互”与 OrbitControls 冲突 | 区分对象交互和只读相机浏览 |
| 材质、灯光、DPR、深度关系不确定 | 固定色彩空间、材质参数、层高、灯光、DPR 和 renderOrder |
| 加载错误和 WebGL 生命周期缺失 | 增加错误码、overlay、worker/GPU 释放和 context restore |
| 性能目标没有数据规模和环境 | 固定真实样本、八倍压力样本、硬件环境与量化门槛 |
| 缺少可复现验收 | 增加哈希、数学断言、集成计数、视觉基线和完成定义 |

本文是 v1 的唯一实现规格。任何改变数据入口、坐标、几何、视觉常量、相机、标签上限或性能门槛的提交，都必须先修改本文及对应测试，不允许在组件内部形成第二套隐式规则。
