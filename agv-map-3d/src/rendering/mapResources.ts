/*
 * 场景模型 → Three 资源唯一适配层（rendering 层，SPEC 3.3 / 4.3 / 5.2 / 7.3 / 7.4 / 8 / 9 / 10 / 13 / 15.3 / 16）。
 *
 * 定位（TASK-014）：
 *   - 本模块是 typed array → Three BufferGeometry / 实例属性 / 材质资源的唯一边界：
 *     把一个已自校验的 SceneModel 一次性适配为数量固定、参数正确、所有权明确的资源集合。
 *   - 只消费 SceneModel 的最终 typed array 与统一 config 参数；不解析原始 JSON、不访问领域边 / 节点、
 *     不重算坐标 / 轨迹 / 矩阵 / 颜色 / 业务 bounds（SPEC 4.1 / 任务约束）。
 *   - 不创建 Canvas / R3F 图层 / Ground / 相机 / 灯光 / 事件监听器 / 文字对象；静态场景装配属于后续 TASK。
 *
 * 资源集合契约（SPEC 7.4 / 8 / 9 / 10 / 13 / 15.3 / 任务输出）：
 *   - 恰好产出四个 Three 对象：一个 ribbon Mesh、一个节点 InstancedMesh、一个节点箭头 InstancedMesh、
 *     一个边箭头 InstancedMesh。不得按实体或类型继续拆分资源。
 *   - 节点共享一个 CylinderGeometry(1,1,0.05,24)；节点箭头与边箭头分别共享各自单位三角形。
 *   - 实例矩阵与线性 sRGB 颜色直接消费 SceneModel，不做第二次坐标或颜色变换。
 *
 * 材质参数不变量（SPEC 7.3 / 任务约束）：
 *   - ribbon：MeshBasicMaterial + vertexColors，toneMapped=false，保留 polygonOffset（factor/units=-1）。
 *   - 两类箭头：白色基色 MeshBasicMaterial 乘 instanceColor，toneMapped=false。
 *   - 节点：白色基色 MeshStandardMaterial 乘 instanceColor，roughness=0.8、metalness=0。
 *   - 所有实体 depthTest=true（默认）；节点箭头 depthWrite=false。
 *   - renderOrder 与上述参数全部来自 config，不在适配器与场景层各定义一份。
 *
 * 创建原子性与幂等释放不变量（SPEC 4.3 / 任务约束）：
 *   - 任一资源创建步骤失败时，工厂 catch 分支释放本次已登记资源，禁止提交部分集合或转嫁清理责任。
 *   - 所有 Geometry / Material / 实例属性由 ResourceRegistry 登记并成对释放；
 *     资源集合 dispose() 在 StrictMode 风格重复调用下幂等，不抛异常、登记数量不增长。
 *
 * 渲染边界预检不变量（SPEC 16 / 任务异常路径）：
 *   - 创建资源前对 SceneModel 做上传就绪预检：缓冲区存在且为 Float32Array、长度与诊断计数一致、
 *     全部矩阵 / 顶点 / 颜色为有限数、颜色在线性 sRGB [0,1]。
 *   - 任何不一致（含 postMessage 转移后长度归零的不可用缓冲区）立即整体拒绝，
 *     不创建部分资源、不补默认值。
 *
 * 依赖方向（SPEC 3.3）：允许 domain（MapDataError / 错误码）、workers（SceneModel 契约类型）、
 *   config（视觉与资源参数）、本层自身；外部仅 three。不依赖 geometry / labels / application / scene。
 */
import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three'
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { SceneModel } from '../workers/buildSceneModel'
import {
  ARROW_MATERIAL_PARAMS,
  DEPTH_POLICY,
  LAYER_Y,
  NODE_BASE_CYLINDER,
  NODE_MATERIAL_PARAMS,
  RENDER_ORDER,
  RIBBON_MATERIAL_PARAMS,
} from '../config/mapVisualConfig'
import { EDGE_ARROW_VERTICES, NODE_ARROW_VERTICES } from './baseGeometry'
import { ResourceRegistry } from './resourceRegistry'

/*
 * 渲染边界逻辑路径前缀：资源适配错误发生在 SceneModel typed array 上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败集合，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const RENDER_RESOURCE_LOGICAL_PATH = 'sceneModel.render'

/*
 * 线性 sRGB 颜色 [0, 1] 边界容差（Float32 末位保护，与 buildSceneModel 同源策略）。
 */
const COLOR_RANGE_EPSILON = 1e-6

/*
 * 构造渲染资源适配错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分资源；message 含可读中文，便于 overlay 与测试匹配。
 */
function renderError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: RENDER_RESOURCE_LOGICAL_PATH,
    context,
  })
}

/*
 * 断言一个值是非负整数（SPEC 5.2 诊断计数）。
 * 用于校验资源数量来源（nodeCount / arrowCount / ribbonVertexCount）。
 */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw renderError(`诊断计数 ${name} = ${value} 不是非负整数，无法据此创建资源。`, {
      name,
      value,
    })
  }
}

/*
 * 断言 typed array 存在、为 Float32Array、且长度等于 count × unit。
 *
 * 该断言同时覆盖三类异常路径（任务约束）：
 *   - 缺失缓冲区：字段不是 Float32Array（undefined / null / 其它类型）→ 拒绝。
 *   - 长度与诊断不一致：实际长度 ≠ count × unit → 拒绝。
 *   - 已不可用缓冲区：postMessage 转移后底层 ArrayBuffer 被分离，typed array 长度归零；
 *     当 count > 0 时 0 ≠ 期望长度 → 拒绝。
 */
function assertTypedArray(
  name: string,
  arr: unknown,
  count: number,
  unit: number,
): asserts arr is Float32Array {
  if (!(arr instanceof Float32Array)) {
    throw renderError(`${name} 缺失或不是 Float32Array，无法上传到 GPU。`, {
      name,
      actualType: arr === null ? 'null' : typeof arr,
    })
  }
  const expected = count * unit
  if (arr.length !== expected) {
    throw renderError(
      `${name} 长度 ${arr.length} 与期望 ${count} × ${unit} = ${expected} 不一致（可能为已转移的不可用缓冲区）。`,
      { name, actual: arr.length, count, unit, expected },
    )
  }
}

/*
 * 断言 typed array 全部元素为有限数（SPEC 16）。
 * 非有限值在上传前整体拒绝，杜绝 NaN / Infinity 进入 GPU。
 */
function assertFiniteArray(arr: Float32Array, name: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw renderError(`${name} 第 ${i} 个元素 ${arr[i]} 非有限，拒绝创建资源。`, {
        name,
        index: i,
        value: arr[i],
      })
    }
  }
}

/*
 * 断言颜色 typed array 全部元素为有限数且位于线性 sRGB [0, 1]（SPEC 5.2 / 7.3）。
 * 使用容差吸收 Float32 末位抖动，同时拒绝 NaN / Infinity / 超范围颜色。
 */
function assertColorArray(arr: Float32Array, name: string): void {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (!Number.isFinite(v)) {
      throw renderError(`${name} 第 ${i} 个颜色分量 ${v} 非有限，拒绝创建资源。`, {
        name,
        index: i,
        value: v,
      })
    }
    if (v < -COLOR_RANGE_EPSILON || v > 1 + COLOR_RANGE_EPSILON) {
      throw renderError(`${name} 第 ${i} 个颜色分量 ${v} 超出线性 sRGB [0, 1]。`, {
        name,
        index: i,
        value: v,
      })
    }
  }
}

/*
 * 渲染边界上传就绪预检（SPEC 16 / 任务异常路径）。
 *
 * 这是渲染层自身的边界契约检查，区别于 workers 层的 validateSceneModel：
 *   - workers 的自校验发生在 worker 线程、交付前；本检查发生在主线程、消费前，
 *     覆盖 postMessage 转移后缓冲区被分离这一新增失败模式与“绕过 worker 直传未校验模型”的兜底。
 *   - 范围只覆盖本层将要上传到 GPU 的矩阵 / 顶点 / 颜色与对应诊断计数，
 *     不重复校验标签描述符或 contentBounds（那不是渲染资源创建的输入）。
 *   - 任一不一致立即整体拒绝，不创建部分资源、不补默认值。
 */
function preflightSceneModel(model: SceneModel): void {
  const d = model.diagnostics
  assertNonNegativeInteger('nodeCount', d.nodeCount)
  assertNonNegativeInteger('nodeArrowCount', d.nodeArrowCount)
  assertNonNegativeInteger('edgeArrowCount', d.edgeArrowCount)
  assertNonNegativeInteger('ribbonVertexCount', d.ribbonVertexCount)

  // —— 存在性与长度（含已转移缓冲区的长度归零探测）——
  assertTypedArray('nodeMatrices', model.nodeMatrices, d.nodeCount, 16)
  assertTypedArray('nodeColors', model.nodeColors, d.nodeCount, 3)
  assertTypedArray('nodeArrowMatrices', model.nodeArrowMatrices, d.nodeArrowCount, 16)
  assertTypedArray('nodeArrowColors', model.nodeArrowColors, d.nodeArrowCount, 3)
  assertTypedArray('edgeArrowMatrices', model.edgeArrowMatrices, d.edgeArrowCount, 16)
  assertTypedArray('edgeArrowColors', model.edgeArrowColors, d.edgeArrowCount, 3)
  assertTypedArray('ribbonPositions', model.ribbonPositions, d.ribbonVertexCount, 3)
  assertTypedArray('ribbonColors', model.ribbonColors, d.ribbonVertexCount, 3)

  // —— 有限性（矩阵 / 顶点）——
  assertFiniteArray(model.nodeMatrices, 'nodeMatrices')
  assertFiniteArray(model.nodeArrowMatrices, 'nodeArrowMatrices')
  assertFiniteArray(model.edgeArrowMatrices, 'edgeArrowMatrices')
  assertFiniteArray(model.ribbonPositions, 'ribbonPositions')

  // —— 颜色有限性 + 线性 sRGB [0, 1] ——
  assertColorArray(model.nodeColors, 'nodeColors')
  assertColorArray(model.nodeArrowColors, 'nodeArrowColors')
  assertColorArray(model.edgeArrowColors, 'edgeArrowColors')
  assertColorArray(model.ribbonColors, 'ribbonColors')
}

/*
 * 构造节点共享基准圆柱几何（SPEC 8.1 / config NODE_BASE_CYLINDER）。
 * CylinderGeometry(1, 1, 0.05, 24)：Y 轴对齐、原点居中；实例矩阵按节点半径缩放 X/Z 并平移。
 * 几何由 registry 登记，资源释放时成对 dispose。
 */
function createNodeCylinderGeometry(registry: ResourceRegistry): CylinderGeometry {
  return registry.register(
    new CylinderGeometry(
      NODE_BASE_CYLINDER.radiusTop,
      NODE_BASE_CYLINDER.radiusBottom,
      NODE_BASE_CYLINDER.height,
      NODE_BASE_CYLINDER.radialSegments,
    ),
  )
}

/*
 * 构造一个位于 XZ 平面、局部朝 +X 的单位三角形非索引几何（SPEC 8.2 / 10.1）。
 * 顶点数据来自 baseGeometry；position 属性 itemSize = 3。由 registry 登记。
 */
function createTriangleGeometry(
  vertices: readonly number[],
  registry: ResourceRegistry,
): BufferGeometry {
  const geometry = registry.register(new BufferGeometry())
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  return geometry
}

/*
 * 把实例矩阵 typed array 批量填入 InstancedMesh.instanceMatrix。
 *
 * SceneModel 的矩阵已是 Three Matrix4.toArray 兼容的列主序布局（平移位于索引 12/13/14），
 * 与 InstancedMesh 内部分配的 instanceMatrix.array 布局一致；故直接 .set() 批量拷贝，
 * 不经 setMatrixAt 逐实例构造 Matrix4，避免数千次 Matrix4 分配。
 * 拷贝长度由预检保证与 instanceMatrix.array.length 严格一致。
 */
function fillInstanceMatrices(
  mesh: InstancedMesh,
  matrices: Float32Array,
): void {
  mesh.instanceMatrix.array.set(matrices)
  mesh.instanceMatrix.needsUpdate = true
}

/*
 * 把实例颜色 typed array 以零拷贝方式挂为 InstancedMesh.instanceColor。
 *
 * SceneModel 颜色已是线性 sRGB [0,1] 浮点（SPEC 5.2 / 7.3），与 Three instanceColor
 * 线性工作色空间一致；直接以 InstancedBufferAttribute 引用同一 Float32Array，不做第二次转换、
 * 不分配新缓冲区。引用安全：SceneModel 在主线程不可变且生命周期不早于资源集合。
 */
function attachInstanceColor(
  mesh: InstancedMesh,
  colors: Float32Array,
): void {
  mesh.instanceColor = new InstancedBufferAttribute(colors, 3)
  mesh.instanceColor.needsUpdate = true
}

/*
 * 构造 ribbon Mesh（SPEC 7.3 / 7.4 / 9.4 / 15.3）。
 *
 * - 非索引 BufferGeometry：position / color 直接引用 SceneModel 的 ribbonPositions / ribbonColors，
 *   不做第二次坐标或颜色转换。属性长度由预检保证 = ribbonVertexCount × 3。
 * - 共享 ribbonMaterial 由调用方登记并传入；Mesh 平移到 Ribbon Y（SPEC 7.1），
 *   使 ribbon 几何（y 恒为 0）落到地面之上的固定层高。
 * - 显式计算 boundingBox / boundingSphere，保证 ribbon 资源具备与纯数值结果一致的空间范围，
 *   供视锥剔除与诊断交叉比对（任务约束）。
 * - renderOrder 来自 config RENDER_ORDER.ribbon。
 *
 * 资源所有权：geometry 由 registry 登记；material 由调用方登记；Mesh 本身无 GPU 资源
 * （不含 dispose），随 geometry / material 释放后由 GC 回收。
 */
function createRibbonMesh(
  model: SceneModel,
  material: MeshBasicMaterial,
  registry: ResourceRegistry,
): Mesh {
  const geometry = registry.register(new BufferGeometry())
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(model.ribbonPositions, 3),
  )
  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(model.ribbonColors, 3),
  )
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const mesh = new Mesh(geometry, material)
  mesh.position.y = LAYER_Y.ribbon
  mesh.renderOrder = RENDER_ORDER.ribbon
  return mesh
}

/*
 * 构造一个实例集合（SPEC 7.3 / 7.4 / 8 / 10）。
 *
 * 通用化节点 / 节点箭头 / 边箭头三类 InstancedMesh 的共同装配步骤：
 *   - 共享 geometry / material（各自由调用方传入并已登记、含已配置的 depthWrite）。
 *   - 实例矩阵批量填入；实例色零拷贝挂载；count 来自诊断计数。
 *   - renderOrder 由调用方按 config 传入。
 *
 * frustumCulled 置 false：实例级剔除不由 Three 自动处理，全场景实例集合始终提交一次 draw call，
 * 避免基于单实例几何 bounds 误剔除导致地图实体消失；实体 draw call 仍 <= 5（SPEC 15.3）。
 */
function createInstancedLayer(params: {
  readonly geometry: BufferGeometry
  readonly material: MeshBasicMaterial | MeshStandardMaterial
  readonly instanceCount: number
  readonly matrices: Float32Array
  readonly colors: Float32Array
  readonly renderOrder: number
  readonly registry: ResourceRegistry
}): InstancedMesh {
  const {
    geometry,
    material,
    instanceCount,
    matrices,
    colors,
    renderOrder,
    registry,
  } = params

  // count = 0 时 InstancedMesh 仍可构造（绘制零实例）；真实样本三类实例均非零。
  const mesh = registry.register(
    new InstancedMesh(geometry, material, instanceCount),
  )
  if (instanceCount > 0) {
    fillInstanceMatrices(mesh, matrices)
    attachInstanceColor(mesh, colors)
  }
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

/*
 * 适配后的 Three 资源集合（SPEC 13 / 15.3 / 任务输出）。
 *
 * 字段语义：
 *   - ribbon：合并后唯一 ribbon Mesh（SPEC 15.3 Ribbon Mesh = 1）。
 *   - nodes：唯一节点 InstancedMesh（SPEC 8.1，全部节点共享一个 mesh）。
 *   - nodeArrows：唯一节点箭头 InstancedMesh（SPEC 8.2，不按类型拆 mesh）。
 *   - edgeArrows：唯一边箭头 InstancedMesh（SPEC 10.1，LINE 与 BEZIER 共用一个 mesh）。
 *   - dispose / isDisposed：幂等释放契约。
 *
 * 所有权不变量：四个对象都已就绪可被场景层 <primitive> 直接装配，无需回读领域实体；
 * 全部 GPU 资源（geometry / material / 实例属性）由内部 registry 成对登记并释放。
 */
export interface MapResources {
  readonly ribbon: Mesh
  readonly nodes: InstancedMesh
  readonly nodeArrows: InstancedMesh
  readonly edgeArrows: InstancedMesh
  /** 幂等释放全部已登记资源；StrictMode 风格重复调用安全。 */
  dispose(): void
  /** 是否已完成首次释放。 */
  readonly isDisposed: boolean
}

/*
 * 场景模型 → Three 资源唯一适配入口（SPEC 4.1 / 4.3 / 任务可验证结果）。
 *
 * 调用方契约：
 *   - 输入是已自校验的 SceneModel（worker 交付或测试构造）。
 *   - 成功返回 MapResources：四个就绪 Three 对象 + 幂等 dispose()。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：预检不一致或资源构造异常均整体拒绝，
 *     且本次已创建资源全部释放，不暴露不完整集合。
 *
 * 创建原子性：预检在任何 Three 对象创建之前完成；构造期任一步骤抛错时 catch 调用
 * registry.dispose() 释放本次已登记资源并重新抛出，保证调用方要么拿到完整集合、要么拿到零资源。
 */
export function createMapResources(model: SceneModel): MapResources {
  // 预检在任何 Three 对象创建之前完成，杜绝“先创建部分资源再发现模型非法”。
  preflightSceneModel(model)

  const registry = new ResourceRegistry()
  try {
    // —— 共享基准几何：节点圆柱 + 两类箭头三角形（SPEC 8.1 / 8.2 / 10.1）——
    const nodeGeometry = createNodeCylinderGeometry(registry)
    const nodeArrowGeometry = createTriangleGeometry(NODE_ARROW_VERTICES, registry)
    const edgeArrowGeometry = createTriangleGeometry(EDGE_ARROW_VERTICES, registry)

    // —— 材质（SPEC 7.3，参数来自 config；每类材质独立实例，depthWrite 按层固定）——
    const ribbonMaterial = registry.register(
      new MeshBasicMaterial({
        vertexColors: true,
        toneMapped: RIBBON_MATERIAL_PARAMS.toneMapped,
        polygonOffset: RIBBON_MATERIAL_PARAMS.polygonOffset,
        polygonOffsetFactor: RIBBON_MATERIAL_PARAMS.polygonOffsetFactor,
        polygonOffsetUnits: RIBBON_MATERIAL_PARAMS.polygonOffsetUnits,
      }),
    )
    const nodeMaterial = registry.register(
      new MeshStandardMaterial({
        color: 0xffffff,
        roughness: NODE_MATERIAL_PARAMS.roughness,
        metalness: NODE_MATERIAL_PARAMS.metalness,
      }),
    )
    // 节点箭头关闭 depthWrite（SPEC 7.3 / config DEPTH_POLICY），避免与圆柱顶面争夺深度；
    // depthTest 保持默认 true。两类箭头材质 toneMapped=false（config ARROW_MATERIAL_PARAMS）。
    const nodeArrowMaterial = registry.register(
      new MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: ARROW_MATERIAL_PARAMS.toneMapped,
      }),
    )
    nodeArrowMaterial.depthWrite = DEPTH_POLICY.nodeArrowDepthWrite
    const edgeArrowMaterial = registry.register(
      new MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: ARROW_MATERIAL_PARAMS.toneMapped,
      }),
    )

    // —— 四个资源对象（SPEC 7.4 renderOrder / 7.3 深度策略，全部来自 config）——
    const ribbon = createRibbonMesh(model, ribbonMaterial, registry)
    const nodes = createInstancedLayer({
      geometry: nodeGeometry,
      material: nodeMaterial,
      instanceCount: model.diagnostics.nodeCount,
      matrices: model.nodeMatrices,
      colors: model.nodeColors,
      renderOrder: RENDER_ORDER.node,
      registry,
    })
    const nodeArrows = createInstancedLayer({
      geometry: nodeArrowGeometry,
      material: nodeArrowMaterial,
      instanceCount: model.diagnostics.nodeArrowCount,
      matrices: model.nodeArrowMatrices,
      colors: model.nodeArrowColors,
      renderOrder: RENDER_ORDER.nodeArrow,
      registry,
    })
    const edgeArrows = createInstancedLayer({
      geometry: edgeArrowGeometry,
      material: edgeArrowMaterial,
      instanceCount: model.diagnostics.edgeArrowCount,
      matrices: model.edgeArrowMatrices,
      colors: model.edgeArrowColors,
      renderOrder: RENDER_ORDER.edgeArrow,
      registry,
    })

    let disposed = false
    return {
      ribbon,
      nodes,
      nodeArrows,
      edgeArrows,
      get isDisposed(): boolean {
        return disposed
      },
      dispose(): void {
        if (disposed) {
          return
        }
        disposed = true
        registry.dispose()
      },
    }
  } catch (error) {
    // 创建中途失败：释放本次已登记的全部资源，禁止提交部分集合或转嫁清理责任。
    registry.dispose()
    if (error instanceof MapDataError) {
      throw error
    }
    // 非 MapDataError 的构造异常（理论不存在：Three 构造不读模型数据）包装为稳定错误码。
    throw renderError('创建 Three 资源时发生未预期错误。', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
