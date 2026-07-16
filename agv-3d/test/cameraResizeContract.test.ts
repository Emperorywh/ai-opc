import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 相机、控件与 resize 像素预算静态契约测试（SPEC §9、§11.1，TASK-011）。
 *
 * 这些属性难以在 Node 环境通过真实渲染验证（需浏览器 R3F 上下文、OrbitControls DOM
 * 监听与 resize 事件循环），改为对源码做静态契约断言，与 environmentContract.test.ts
 * 同一模式（§13.1 纯 Node 测试、§13.3 浏览器交互留给人工）。
 *
 * 覆盖 TASK-011 明确要求的、纯函数测试（cameraFraming / performanceConfig）无法触及的
 * 组件级不变量：
 * - resize 不重编译：PixelBudgetDpr 的导入面被严格限制为 R3F size/setDpr 与 computeEffectiveDpr，
 *   不引用任何加载、解析、校验、编译或 RenderPacket 几何字段；CameraRig 同样不触发数据重处理
 *   （SPEC §9.3 resize 只更新 aspect、渲染尺寸与有效 DPR）。
 * - 监听释放：CameraRig 与 PixelBudgetDpr 不直接注册 window/document 全局监听，相机交互与
 *   resize 副作用全部经由 R3F 的 useFrame/useEffect（卸载自动停止）与 drei OrbitControls
 *   （自管 DOM 监听并在卸载 dispose）承载（SPEC §9.2 卸载移除监听器）。
 * - framing 仅依赖最终渲染边界：MapSceneView 的相机 framing 仅由 packet.renderBounds 派生，
 *   不读节点 AABB、硬编码地图坐标或相机运行状态（TASK-011 实现约束）。
 * - 数值集中：相机/性能数值取自 cameraConfig/performanceConfig，展示组件内不散落魔法数字
 *   （SPEC §12、TASK-011 实现约束）。
 */

const SCENE_DIR = resolve(__dirname, '..', 'src', 'features', 'agv-map', 'presentation', 'scene')

function readScene(rel: string): string {
  return readFileSync(resolve(SCENE_DIR, rel), 'utf8')
}

const PIXEL_BUDGET_DPR = readScene('PixelBudgetDpr.tsx')
const CAMERA_RIG = readScene('CameraRig.tsx')
const MAP_SCENE_VIEW = readScene('MapSceneView.tsx')
const CAMERA_FRAMING = readScene('cameraFraming.ts')

/** 从 import ... from 'mod' 语句中提取被禁止出现的加载/解析/校验/编译入口标识符。 */
const FORBIDDEN_DATA_PIPELINE_SYMBOLS = [
  'compileRenderPacket',
  'sampleEdges',
  'samplePath',
  'groupLanes',
  'compilePathGeometry',
  'compileNodeInstances',
  'normalizeMap',
  'validateRawMap',
  'extractMapPayload',
  'postMessage',
  'fetchMapAsset',
  'MapCompilerWorker',
] as const

describe('resize 不重编译（SPEC §9.3，TASK-011）', () => {
  it('PixelBudgetDpr 仅依赖 R3F size/setDpr 与 computeEffectiveDpr，不触及几何/数据包/编译入口', () => {
    // 导入面被严格限制：只能从 react、@react-three/fiber、performanceConfig 导入。
    // 一旦出现数据管线符号或 RenderPacket 字段，即意味着 resize 路径可能触发重处理，违反 §9.3。
    for (const symbol of FORBIDDEN_DATA_PIPELINE_SYMBOLS) {
      expect(PIXEL_BUDGET_DPR, `PixelBudgetDpr 引用了数据管线符号 ${symbol}`).not.toContain(symbol)
    }
    // RenderPacket 几何字段名不得出现：resize 只改 DPR，不重读 pathGeometry / nodeInstances。
    expect(PIXEL_BUDGET_DPR).not.toContain('pathGeometry')
    expect(PIXEL_BUDGET_DPR).not.toContain('nodeInstances')
    expect(PIXEL_BUDGET_DPR).not.toContain('RenderPacket')
    // 必须消费 computeEffectiveDpr（像素预算公式的唯一入口，§11.1）。
    expect(PIXEL_BUDGET_DPR).toContain('computeEffectiveDpr')
    expect(PIXEL_BUDGET_DPR).toContain('setDpr')
  })

  it('CameraRig 不引用任何加载/解析/校验/编译入口（控件只管相机行为，不触发数据重处理）', () => {
    for (const symbol of FORBIDDEN_DATA_PIPELINE_SYMBOLS) {
      expect(CAMERA_RIG, `CameraRig 引用了数据管线符号 ${symbol}`).not.toContain(symbol)
    }
    // CameraRig 只读 bounds（已编译的渲染边界）用于推导距离/平移范围，不重编译几何。
    expect(CAMERA_RIG).not.toContain('pathGeometry')
    expect(CAMERA_RIG).not.toContain('nodeInstances')
  })
})

describe('监听释放（SPEC §9.2 卸载移除监听器，TASK-011）', () => {
  it('CameraRig 不直接注册全局 DOM 监听（经 useFrame/useLayoutEffect 与 drei OrbitControls 承载）', () => {
    // 相机交互与每帧 target 钳制全部经由 R3F useFrame（卸载自动停止）与 drei OrbitControls
    // （自管 DOM 监听并在 dispose 释放）。组件内不应出现裸 addEventListener/removeEventListener。
    expect(CAMERA_RIG).not.toMatch(/addEventListener/)
    expect(CAMERA_RIG).not.toMatch(/removeEventListener/)
    expect(CAMERA_RIG).not.toMatch(/\bwindow\./)
    expect(CAMERA_RIG).not.toMatch(/\bdocument\./)
    // 必须以 useFrame 承载每帧 target 钳制（随组件卸载自动停止）。
    expect(CAMERA_RIG).toContain('useFrame')
  })

  it('PixelBudgetDpr 不直接注册全局 DOM 监听（resize 副作用经 R3F size 快照 + useEffect 承载）', () => {
    // DPR 重算由 R3F 内部 ResizeObserver 派发的 size 快照驱动，本组件只消费快照，
    // 不自行 addEventListener('resize')；useEffect 清理随卸载自动停止。
    // 注意：readDevicePixelRatio 读取 window.devicePixelRatio 属被动属性读取（带 SSR 守卫），
    // 不是事件监听注册，故只断言不出现 addEventListener。
    expect(PIXEL_BUDGET_DPR).not.toMatch(/addEventListener/)
    expect(PIXEL_BUDGET_DPR).not.toMatch(/removeEventListener/)
    expect(PIXEL_BUDGET_DPR).not.toMatch(/\bdocument\./)
    expect(PIXEL_BUDGET_DPR).toContain('useEffect')
  })
})

describe('framing 仅依赖最终渲染边界（TASK-011 实现约束）', () => {
  it('MapSceneView 的 frame 仅由 packet.renderBounds 派生（依赖数组只含 renderBounds）', () => {
    // framing 只依赖 TASK-005 的最终渲染边界，不得使用节点 AABB、硬编码地图坐标或相机运行状态。
    // 断言 useMemo 的依赖数组恰好为 [packet.renderBounds]。
    expect(MAP_SCENE_VIEW).toMatch(/useMemo\([\s\S]*?\[packet\.renderBounds\]/)
    // 不应出现硬编码的地图范围坐标或节点 AABB 派生。
    expect(MAP_SCENE_VIEW).not.toContain('nodeAabb')
    expect(MAP_SCENE_VIEW).not.toContain('nodeBounds')
  })

  it('computeCameraFrame 签名仅接收 bounds 与 aspect（不读节点、相机或系统状态）', () => {
    // 纯函数 framing：相同 bounds 与 aspect 产生相同相机参数（§7.1、§9.1）。
    expect(CAMERA_FRAMING).toMatch(/export function computeCameraFrame\(\s*\bbounds\b[^,]*,\s*\baspect\b[^)]*\)/)
  })
})

describe('相机/性能数值集中（SPEC §12，TASK-011 实现约束）', () => {
  it('CameraRig 的极角与阻尼参数取自 cameraConfig，组件内不散落魔法数字', () => {
    expect(CAMERA_RIG).toContain('MIN_POLAR_RAD')
    expect(CAMERA_RIG).toContain('MAX_POLAR_RAD')
    expect(CAMERA_RIG).toContain('DAMPING_FACTOR')
    // 距离与平移边界经纯函数推导，不在组件内重复写死半径因子。
    expect(CAMERA_RIG).toContain('computeOrbitDistanceLimits')
    expect(CAMERA_RIG).toContain('computePanBounds')
  })

  it('MapSceneView 的 FOV、near 与参考宽高比取自 cameraConfig', () => {
    expect(MAP_SCENE_VIEW).toContain('CAMERA_FOV_DEG')
    expect(MAP_SCENE_VIEW).toContain('CAMERA_NEAR_M')
    expect(MAP_SCENE_VIEW).toContain('FRAMING_REFERENCE_ASPECT')
  })

  it('PixelBudgetDpr 的 DPR 公式取自 performanceConfig，不在组件内重推导预算公式', () => {
    expect(PIXEL_BUDGET_DPR).toContain('computeEffectiveDpr')
    // 不应在组件内重实现预算公式（Math.sqrt / MAX_RENDER_PIXELS）；预算常量与公式集中在
    // performanceConfig，组件只委托 computeEffectiveDpr。注释中提及 3840×2160 不违反集中性。
    expect(PIXEL_BUDGET_DPR).not.toMatch(/Math\.sqrt/)
    expect(PIXEL_BUDGET_DPR).not.toContain('MAX_RENDER_PIXELS')
  })
})
