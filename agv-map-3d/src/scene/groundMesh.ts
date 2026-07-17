/*
 * 有限地面 Mesh 工厂（scene 装配层，SPEC 7.1 / 7.2 / 7.3 / 7.4 / 12.1 / 13 / 15.3 / 任务约束）。
 *
 * 信任边界定位（TASK-018）：
 *   - 本模块把 TASK-017 交付的有限数值地面范围（computeGroundBounds，已排除 fit 与标签）
 *     适配为一个深色有限平面 Mesh，供 GroundLayer 通过 <primitive> 装配。
 *   - 地面是“静态环境”的一部分，与数据派生的 ribbon / 节点 / 箭头资源不同源：
 *     它只读 groundBounds 的六个数值分量与 config 视觉常量，不解析原始 JSON、不重算坐标、
 *     不参与 camera fit（SPEC 12.1 地面只参与裁剪面推导，不参与 fit）。
 *
 * 有限平面不变量（SPEC 12.1 / 任务约束）：
 *   - XZ 范围 = groundBounds 的 XZ 分量；Y 恒为 SPEC 7.1 Ground Y = 0。
 *   - 背景色负责视口边缘，禁止用足量大数平面或无限 far plane；地面尺寸由内容范围 + padding 推导。
 *   - padding 已由 computeGroundBounds 一次性给出（max(5m, max(宽,深) × 10%)），本模块不再扩张或重算。
 *
 * 材质与深度不变量（SPEC 7.3 / 7.4 / 任务约束）：
 *   - MeshStandardMaterial：颜色 GROUND_COLOR、roughness = 1、metalness = 0（config 唯一来源）。
 *   - renderOrder = RENDER_ORDER.ground（0），最先提交；depthTest 保持默认 true，深度关系真实。
 *   - 地面不投射 / 不接收阴影（v1 无阴影资源），castShadow / receiveShadow 恒为 false。
 *
 * 资源所有权不变量（SPEC 4.3 / 任务约束）：
 *   - geometry / material 由 ResourceRegistry 登记并成对释放；dispose 幂等，StrictMode 风格重复调用安全。
 *   - 返回的 Mesh 由 scene 装配层通过 <primitive> 挂载；R3F 不自动释放 primitive（见 fiber 源码
 *     type === 'primitive' 分支），故释放责任唯一归本工厂返回的 dispose，不形成第二套释放逻辑。
 *
 * 依赖方向（SPEC 3.3）：domain（NumericBox3）+ rendering（ResourceRegistry）+ config（视觉常量）+ 本层自身；
 *   外部仅 three。不依赖 application / workers / camera / labels，不回读原始数据。
 */
import { Mesh, MeshStandardMaterial, PlaneGeometry } from 'three'
import type { NumericBox3 } from '../domain/sceneMap'
import { ResourceRegistry } from '../rendering/resourceRegistry'
import {
  GROUND_COLOR,
  GROUND_MATERIAL_PARAMS,
  LAYER_Y,
  RENDER_ORDER,
} from '../config/mapVisualConfig'

/*
 * 有限地面 Mesh 工厂结果。
 *   - mesh：可被 <primitive object={mesh}> 直接装配的有限平面 Mesh。
 *   - dispose：幂等释放本次创建的 geometry / material；StrictMode 风格重复调用安全。
 */
export interface GroundMeshHandle {
  readonly mesh: Mesh
  dispose(): void
}

/*
 * 构造有限地面 Mesh（SPEC 7.1 / 7.2 / 7.3 / 7.4 / 12.1）。
 *
 * 几何装配：
 *   - PlaneGeometry(width, depth) 默认位于 XY 平面、法线 +Z；绕 X 轴旋转 -π/2 后法线变为 +Y，
 *     平面平铺在 XZ 地面、正面朝上，匹配从 3/4 视角俯视的观察方向。
 *   - width = groundBounds X 跨度、depth = groundBounds Z 跨度；平面中心定位到 groundBounds XZ 中心，
 *     Y 固定为 SPEC 7.1 Ground Y = 0（groundBounds.minY = maxY = 0，本模块不读 Y 分量以外的语义）。
 *
 * 无效输入不变量：groundBounds 六分量必须有限且 min ≤ max；否则整体拒绝，禁止产生 NaN / Infinity 平面。
 * 调用方（app-root）已由 computeGroundBounds 保证合法性（非法时返回 null 不渲染地面），此处做兜底断言。
 */
export function createGroundMesh(groundBounds: NumericBox3): GroundMeshHandle {
  // 兜底校验：computeGroundBounds 已保证合法，但本工厂作为 scene 边界做最后断言，杜绝 NaN 平面。
  if (
    !Number.isFinite(groundBounds.minX) ||
    !Number.isFinite(groundBounds.maxX) ||
    !Number.isFinite(groundBounds.minZ) ||
    !Number.isFinite(groundBounds.maxZ) ||
    groundBounds.minX > groundBounds.maxX ||
    groundBounds.minZ > groundBounds.maxZ
  ) {
    // 不补默认值、不画退化平面；抛错使调用方保持“未渲染地面”而非错误地图。
    throw new Error('地面范围非法，拒绝创建有限地面 Mesh。')
  }

  const registry = new ResourceRegistry()
  const width = groundBounds.maxX - groundBounds.minX
  const depth = groundBounds.maxZ - groundBounds.minZ
  const centerX = (groundBounds.minX + groundBounds.maxX) / 2
  const centerZ = (groundBounds.minZ + groundBounds.maxZ) / 2

  // PlaneGeometry 位于 XY 平面；旋转 -π/2 绕 X 轴使其平铺到 XZ 地面、正面朝 +Y。
  const geometry = registry.register(new PlaneGeometry(width, depth))
  geometry.rotateX(-Math.PI / 2)

  // 地面材质：哑光、不反光、不参与阴影（SPEC 7.3 / 任务“不创建阴影资源”）。
  const material = registry.register(
    new MeshStandardMaterial({
      color: GROUND_COLOR,
      roughness: GROUND_MATERIAL_PARAMS.roughness,
      metalness: GROUND_MATERIAL_PARAMS.metalness,
    }),
  )

  const mesh = new Mesh(geometry, material)
  // Y 固定为 SPEC 7.1 Ground Y = 0；XZ 定位到地面范围中心。
  mesh.position.set(centerX, LAYER_Y.ground, centerZ)
  // renderOrder = 0：最先提交；depthTest 默认 true，提交顺序不替代真实深度测试（SPEC 7.4）。
  mesh.renderOrder = RENDER_ORDER.ground
  // v1 无阴影：地面既不投射也不接收 shadow map。
  mesh.castShadow = false
  mesh.receiveShadow = false

  let disposed = false
  return {
    mesh,
    dispose(): void {
      if (disposed) return
      disposed = true
      registry.dispose()
    },
  }
}
