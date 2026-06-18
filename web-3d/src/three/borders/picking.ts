/**
 * GPU 颜色拾取核心（SPEC §6.3 D9 / §4.4 数据流，Task 22）。
 *
 * 非组件纯逻辑模块（与 boundaryGeometry.ts 同构），R3F 编排（离屏 scene/RT 注册）见 CountryMeshes.tsx。
 *
 * 原理（SPEC §6.3 D9 实现 1-3）：把每个国家渲染成唯一纯色到离屏 RT（「ID 图」），指针读 1×1
 * 像素 → 反查 countryId。命中 O(1)，对「数百国家、每个上千顶点」最稳（§6.3 已评估 BVH / 点在
 * 多边形内，颜色拾取最优）。
 *
 * ─── countryId ↔ pickId ↔ RGB 编码（SPEC §6.3「id = r<<16|g<<8|b」）──────────────────
 *   `country.id` 是 0-based 记录序号（pipeline `nextId=0`，boundaries.test 守「id===序号 0..n-1」），
 *   故 **pickId = countryId + 1**，pickId=0 留给背景（无命中，纯黑）。颜色编码 pickId = r<<16|g<<8|b
 *   （24-bit，可编码 16M，远超国家数 <300）。RT 清屏黑 → 未覆盖像素读 (0,0,0) → pickId=0 → null。
 *
 * ─── 边缘 ID 稳定（SPEC §6.3 风险验证 3）──────────────────────────────────────────
 *   两条保证：
 *   1. 颜色经归一化 [0,1] → 帧缓冲 8-bit 量化（round(×255)）→ pickIdToColor→量化→rgbToPickId 全程
 *      可逆（纯函数单测守，见 test/picking.test.ts），国家边缘像素不因量化串到邻国 id；
 *   2. RT 用 **NearestFilter**（非 Linear），GPU 采样不插值混色，亚像素边缘直接取最近国家色。
 *   MeshBasicMaterial + vertexColors：颜色 = vertexColor 直出，无光照/fog/alpha 干扰量化。
 *
 * ─── 拾取几何（与 CountryMeshes 可见几何同源）─────────────────────────────────────
 *   复用 Task 20 `buildBoundaryPositions`（同 position 贴地）+ Task 19 `fillIndices`（同三角形），
 *   仅多一个每顶点 `color` attribute（按国家 vertexOffset/vertexCount 范围填该国 pickIdToColor）。
 *   一次 draw call 渲染整张 ID 图（与 CountryMeshes 单合并 mesh 同构，Task 19 全局顶点池 GPU-ready）。
 *
 * ─── 与 Task 23 的边界 ─────────────────────────────────────────────────────────────
 *   本 Task 交付「拾取能力」：映射 / 几何 / 材质 / RT / pickAt（注入式 renderer）/ API 寄存器。
 *   Task 23 的 `usePointerPick.ts` hook 读 `getPickingApi()` 绑定指针事件 → store.setHovered/setSelected
 *   流转 + 高亮层（提亮 + 发光）。本 Task 不绑指针、不动 store 流转。
 */
import * as THREE from 'three'
import type { BoundaryData, ElevationData } from '../../data/types'
import type { ElevationMeta } from '../../config/projection'
import { buildBoundaryPositions } from './boundaryGeometry'

// ---------------------------------------------------------------------------
// countryId ↔ pickId ↔ RGB 映射（纯函数，全可逆）
// ---------------------------------------------------------------------------

/** 背景 pickId：无国家。RT 清屏黑读出 (0,0,0) → rgbToPickId=0 → pickIdToCountryId=null。 */
export const PICKING_BACKGROUND_PICK_ID = 0
/** pickId 上限（24-bit r=g=b=255）。远超国家数（<300），边界守。 */
export const MAX_PICK_ID = 0xffffff

/**
 * countryId（0-based 记录序号）→ pickId（1-based；0=背景）。
 * +1 偏移：countryId=0 的国家用 pickId=1，腾出 pickId=0 给背景。
 */
export function countryIdToPickId(countryId: number): number {
  return countryId + 1
}

/**
 * pickId → countryId | null。背景 0 → null；非正整数（越界/分数）→ null。
 * pickId-1 还原 0-based countryId。
 */
export function pickIdToCountryId(pickId: number): number | null {
  if (!Number.isInteger(pickId) || pickId <= 0) return null
  return pickId - 1
}

/**
 * pickId → 8-bit 三通道 [r,g,b]（0-255 整数）。pickId = r<<16|g<<8|b（SPEC §6.3 编码）。
 * pickId=0 → [0,0,0] 背景；pickId=MAX → [255,255,255]。
 */
export function pickIdToRGB(pickId: number): [number, number, number] {
  return [(pickId >> 16) & 0xff, (pickId >> 8) & 0xff, pickId & 0xff]
}

/** 8-bit 三通道（0-255）→ pickId（pickIdToRGB 的反函数，round-trip 可逆）。 */
export function rgbToPickId(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

/**
 * pickId → THREE.Color（归一化 [0,1]，供 vertexColors `color` attribute / material）。
 * 每通道 ÷255 归一；帧缓冲量化时 round(×255) 还原（量化可逆见单测）。
 */
export function pickIdToColor(pickId: number): THREE.Color {
  const [r, g, b] = pickIdToRGB(pickId)
  return new THREE.Color(r / 255, g / 255, b / 255)
}

// ---------------------------------------------------------------------------
// 拾取几何（复用 buildBoundaryPositions + fillIndices，加每顶点国家色）
// ---------------------------------------------------------------------------

/**
 * 为全局顶点池构建每顶点拾取色（Float32Array，3 floats/顶点，归一化 [0,1]，供 `color` attribute）。
 * 按国家 `vertexOffset..vertexOffset+vertexCount` 范围填该国 pickIdToColor（pickId = countryId+1）。
 *
 * position 顶点顺序与 `data.vertices` 同源（buildBoundaryPositions 线性遍历 i→project），故国家
 * vertexOffset/vertexCount 范围在 position 与 color attribute 中一一对应。纯函数，Node 单测验证。
 */
export function buildPickColors(boundaries: BoundaryData): Float32Array {
  const n = boundaries.vertices.length / 2
  const colors = new Float32Array(n * 3)
  for (const c of boundaries.countries) {
    const [r, g, b] = pickIdToRGB(countryIdToPickId(c.id))
    const cr = r / 255
    const cg = g / 255
    const cb = b / 255
    for (let i = 0; i < c.vertexCount; i++) {
      const vi = (c.vertexOffset + i) * 3
      colors[vi] = cr
      colors[vi + 1] = cg
      colors[vi + 2] = cb
    }
  }
  return colors
}

/**
 * 构建拾取 BufferGeometry：position（buildBoundaryPositions 同源贴地）+ color（每顶点国家色）+
 * index（fillIndices 三角形）。与 CountryMeshes 可见几何同顶点池/索引，仅多 color attribute +
 * 配不透明 vertexColors 材质（createPickingMaterial）。一次 draw call 渲染整张 ID 图。
 */
export function buildPickingGeometry(
  boundaries: BoundaryData,
  elevation: ElevationData,
  meta: ElevationMeta,
): THREE.BufferGeometry {
  const positions = buildBoundaryPositions(boundaries, elevation, meta)
  const colors = buildPickColors(boundaries)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.setIndex(new THREE.BufferAttribute(boundaries.fillIndices, 1))
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------
// 拾取材质 / RT（SPEC §6.3 D9：纯 ID 颜色渲染）
// ---------------------------------------------------------------------------

/**
 * 拾取材质透明/双面属性。MeshBasicMaterial + vertexColors：
 *   - 不透明（transparent=false）：ID 图不需混合，纯色直出（避免 alpha 干扰量化）；
 *   - DoubleSide：倾斜相机掠射角两面可拾（与可见填充 COUNTRY_FILL_MATERIAL_OPTS 同）；
 *   - 无 fog/light（MeshBasicMaterial 默认）：颜色 = vertexColor 直出，保证 pickId 精确。
 * 导出 plain object 供单测断言材质契约（同 COUNTRY_FILL_MATERIAL_OPTS 模式）。
 *
 * 深度：独立 picking scene 仅含国家面，**无地形参与**——山体后方国家仍可被拾取（MVP 简化；
 * 加地形纯色替身到 picking scene 可解决，属增强，交 Review）。MeshBasicMaterial depthTest 默认 true
 * 处理同国家重叠三角自相交（MultiPolygon 洞），保留背面剔除意义。
 */
export const PICKING_MATERIAL_OPTS = {
  vertexColors: true,
  side: THREE.DoubleSide,
} as const

/** 创建拾取材质（MeshBasicMaterial + vertexColors，不透明）。单测 / CountryMeshes 共用。 */
export function createPickingMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ ...PICKING_MATERIAL_OPTS })
}

/**
 * 创建拾取离屏 RenderTarget（SPEC §6.3 D9：低分辨率即可，1:1 指针像素读取）。
 *
 *   - RGBA8（UnsignedByteType）+ RGBAFormat：8-bit/通道，与 pickId 8-bit 量化对齐；
 *   - **NearestFilter**（min+mag）：GPU 采样不插值混色，亚像素边缘取最近国家色（边缘 ID 稳定保证 2）；
 *   - depthBuffer=true：同国家 MultiPolygon 重叠三角 depthTest 剔除（与材质 depthTest 配合）。
 * 尺寸跟随 canvas 渲染尺寸（CountryMeshes 传入 size.width/height）：指针 NDC→像素映射精确，小国家
 * 不丢亚像素。SPEC 点 5「按需重渲」由 pickAt 即时渲染（指针事件时）兑现，非每帧。
 */
export function createPickingTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  })
}

// ---------------------------------------------------------------------------
// pickAt：渲染 RT + 读 1×1 + 反查（命中判定核心，注入式 renderer 可测）
// ---------------------------------------------------------------------------

/**
 * 渲染拾取 RT 指针下 1×1 像素 → 反查 countryId（SPEC §6.3 D9 步骤 2-3）。
 *
 * 流程：getRenderTarget(存主画布) → setRenderTarget(rt) → render(pickingScene, camera) →
 *   readRenderTargetPixels(rt, px, py, 1, 1, buf) → rgbToPickId → pickIdToCountryId（背景 0→null）→
 *   setRenderTarget(主画布) 复位。
 *
 * **按需渲染**（SPEC 点 5）：指针事件时即时用当前相机渲染——成本 = 一次国家面 draw call + 1px
 * GPU→CPU 回读，远低于每帧渲染。Task 23 hook 节流调用。
 *
 * NDC→像素：NDC [-1,1] → 像素 [0,w/h)；framebuffer y 向下，NDC y 向上，py=(ndcY+1)/2×h 同向转换
 * （readRenderTargetPixels 原点在左下，与 NDC 上为正一致）。越界钳到边缘像素，不越界 readPixels。
 *
 * renderer 注入式：测试 mock readRenderTargetPixels 返回合成像素验证「像素→countryId」准确；
 * 真实 GL 渲染（dev）留 Review。
 */
export function pickAt(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  pickingScene: THREE.Scene,
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
): number | null {
  const w = target.width
  const h = target.height
  const px = Math.min(w - 1, Math.max(0, Math.round(((ndcX + 1) / 2) * w)))
  const py = Math.min(h - 1, Math.max(0, Math.round(((ndcY + 1) / 2) * h)))

  const pixel = new Uint8Array(4)
  const prevTarget = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.render(pickingScene, camera)
  renderer.readRenderTargetPixels(target, px, py, 1, 1, pixel)
  renderer.setRenderTarget(prevTarget)

  return pickIdToCountryId(rgbToPickId(pixel[0], pixel[1], pixel[2]))
}

// ---------------------------------------------------------------------------
// pickingApi 寄存器（CountryMeshes 注册 pickAt → Task 23 hook 读取）
// ---------------------------------------------------------------------------

/**
 * 拾取能力引用：pickAt 经 CountryMeshes 闭包捕获 renderer/RT/scene/camera 后的简化接口。
 * Task 23 `usePointerPick.ts` 读 `getPickingApi()` 调 pick(ndcX,ndcY)。
 */
export type PickingApi = {
  /** 给定指针 NDC [-1,1]，返回命中 countryId | null（无命中 / 拾取层未就绪）。 */
  pick: (ndcX: number, ndcY: number) => number | null
}

/**
 * module 级单例寄存器。为何不用 store：pickAt 闭包捕获 renderer/RT/scene/camera（非可序列化
 * three 对象），store 存函数不优雅；与 Scene↔Loader 经 store 桥梁的「可序列化状态」不同，pickAt
 * 是「能力引用」。单实例地图假设（dev HMR 重挂载 CountryMeshes 会重设，MVP 可接受）。
 */
let pickingApi: PickingApi | null = null

/** CountryMeshes 挂载时注册（api=null 卸载清理）。 */
export function setPickingApi(api: PickingApi | null): void {
  pickingApi = api
}

/** Task 23 hook 读取（未就绪返回 null，hook 守 null 不触发拾取）。 */
export function getPickingApi(): PickingApi | null {
  return pickingApi
}

/** 显式清理（测试用；卸载时 setPickingApi(null) 等价）。 */
export function clearPickingApi(): void {
  pickingApi = null
}
