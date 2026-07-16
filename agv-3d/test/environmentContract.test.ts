import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REFLECTION_TARGET_SIZE_PIXELS,
  SHADOW_MAP_SIZE_PIXELS,
} from '../src/features/agv-map/config/performanceConfig'

/**
 * 深色沙盘环境静态契约测试（SPEC §8.1、§8.3、§8.4、§11.1，TASK-012 静态检查）。
 *
 * 这些属性难以在 Node 环境通过渲染验证（需浏览器 WebGL 上下文），改为对源码做静态契约断言：
 * - 单一灯光配置：全局仅一个 <directionalLight>（带阴影）与一个 <ambientLight>（低强度）。
 * - 仅节点投射阴影：castShadow 只出现在 NodeLayer（节点实例）与 EnvironmentLayer（方向光）；
 *   PathLayer、地面、网格均不投射阴影。
 * - 阴影贴图预算：directionalLight 的 shadow-mapSize 取自 SHADOW_MAP_SIZE_PIXELS（2048×2048）。
 * - 无远程环境资源：环境相关源码不出现 http(s) URL、HDR 文件、CDN、<Environment preset>。
 * - 真实平面反射（TASK-013）：地面使用 drei MeshReflectorMaterial 唯一反射方案；反射目标固定
 *   REFLECTION_TARGET_SIZE_PIXELS（1024×1024），不绑定主画布 DPR/CSS 尺寸；地面尺寸由 layout
 *   推导；场景唯一地面；无普通材质伪反射/第二套反射 fallback；反射资源具备显式释放路径。
 * - Canvas 启用 shadows：MapSceneView 的 Canvas 声明 shadows 属性。
 */

const SRC = resolve(__dirname, '..', 'src', 'features', 'agv-map')
const SCENE_DIR = resolve(SRC, 'presentation', 'scene')

function readScene(rel: string): string {
  return readFileSync(resolve(SCENE_DIR, rel), 'utf8')
}

/** 读取 scene 目录下全部 .ts/.tsx 源码（含文件名），用于跨文件静态契约扫描。 */
const ALL_SCENE_FILES = readdirSync(SCENE_DIR)
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map((name) => ({ name, content: readFileSync(resolve(SCENE_DIR, name), 'utf8') }))

/**
 * 提取一个源码文件中所有 `from '@react-three/drei'` 导入块绑定的标识符名。
 *
 * 支持单行与多行导入块；用正则定位 drei 导入，回溯到对应的 import 语句头，提取花括号内标识符。
 * 仅用于静态契约断言（确认未导入 Environment），不做完整 TS 解析。
 */
function dreiImportedNames(source: string): string[] {
  const names: string[] = []
  // 匹配 import { ... } from '@react-three/drei'（允许多行、含 type 修饰）。
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@react-three\/drei['"]/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const body = m[1]
    // 每个绑定形如 `Name`、`Name as Alias`、`type Name`；取首个标识符。
    for (const raw of body.split(',')) {
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      const id = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (id.length > 0) names.push(id)
    }
  }
  return names
}

const ENVIRONMENT_LAYER = readScene('EnvironmentLayer.tsx')
const MAP_SCENE_VIEW = readScene('MapSceneView.tsx')
const NODE_LAYER = readScene('NodeLayer.tsx')
const PATH_LAYER = readScene('PathLayer.tsx')
const LOCAL_ENVIRONMENT = readScene('LocalEnvironment.tsx')
const LOCAL_ENV_SCENE = readScene('localEnvironmentScene.ts')
const LOCAL_ENV_PMREM = readScene('localEnvironmentPmrem.ts')
const PLANE_REFLECTION_GROUND = readScene('PlaneReflectionGround.tsx')
const REFLECTION_MATERIAL = readScene('reflectionMaterial.ts')
const REFLECTION_SESSION = readScene('reflectionSession.ts')

describe('TASK-012 静态契约 — 单一灯光配置（SPEC §8.3）', () => {
  it('环境图层仅声明一个 <directionalLight> 与一个 <ambientLight>', () => {
    expect(countOccurrences(ENVIRONMENT_LAYER, '<directionalLight')).toBe(1)
    expect(countOccurrences(ENVIRONMENT_LAYER, '<ambientLight')).toBe(1)
  })

  it('展示层其余图层不额外声明方向光或环境光（无重复光照）', () => {
    // MapSceneView 已把临时光照替换为 EnvironmentLayer，不再保留内联 directionalLight/ambientLight。
    expect(countOccurrences(MAP_SCENE_VIEW, '<directionalLight')).toBe(0)
    expect(countOccurrences(MAP_SCENE_VIEW, '<ambientLight')).toBe(0)
    expect(countOccurrences(MAP_SCENE_VIEW, '<color attach="background"')).toBe(0)
  })
})

describe('TASK-012 静态契约 — 仅节点投射阴影（SPEC §8.3、§11.1）', () => {
  it('NodeLayer 节点实例 castShadow', () => {
    expect(NODE_LAYER).toContain('castShadow')
  })

  it('PathLayer 不投射阴影（扁带为薄带上表面）', () => {
    expect(PATH_LAYER).not.toContain('castShadow')
  })

  it('EnvironmentLayer 仅在方向光上 castShadow；反射地面只 receiveShadow、网格不参与阴影', () => {
    // 方向光启用 castShadow（EnvironmentLayer 内唯一一处 castShadow）。
    expect(countOccurrences(ENVIRONMENT_LAYER, 'castShadow')).toBe(1)
    // 反射地面（PlaneReflectionGround）mesh 声明 receiveShadow 但无 castShadow；接收节点阴影。
    expect(PLANE_REFLECTION_GROUND).toContain('receiveShadow')
    expect(PLANE_REFLECTION_GROUND).not.toContain('castShadow')
    // 网格 mesh 为 EnvironmentLayer 最后一个 <mesh（反射地面已抽为独立组件），不应带阴影属性。
    const gridMeshStart = ENVIRONMENT_LAYER.lastIndexOf('<mesh')
    expect(gridMeshStart).toBeGreaterThan(-1)
    const gridMeshBlock = ENVIRONMENT_LAYER.slice(gridMeshStart)
    expect(gridMeshBlock).not.toContain('castShadow')
    expect(gridMeshBlock).not.toContain('receiveShadow')
  })
})

describe('TASK-012 静态契约 — 阴影贴图预算（SPEC §11.1：2048×2048）', () => {
  it('方向光 shadow-mapSize 取自 SHADOW_MAP_SIZE_PIXELS，不散落数字', () => {
    expect(ENVIRONMENT_LAYER).toContain('shadow-mapSize-width={SHADOW_MAP_SIZE_PIXELS}')
    expect(ENVIRONMENT_LAYER).toContain('shadow-mapSize-height={SHADOW_MAP_SIZE_PIXELS}')
    expect(ENVIRONMENT_LAYER).not.toMatch(/shadow-mapSize-(width|height)=\{2048\}/)
  })

  it('阴影正交范围由 ref 写入并显式 updateProjectionMatrix（R3F shadow-camera-* 不自动重算投影）', () => {
    expect(ENVIRONMENT_LAYER).toContain('light.shadow.camera')
    expect(ENVIRONMENT_LAYER).toContain('updateProjectionMatrix()')
    // 阴影相机范围不应以 JSX shadow-camera-* 形式声明（那样不会重算投影矩阵）。
    expect(ENVIRONMENT_LAYER).not.toMatch(/shadow-camera-(left|right|top|bottom|near|far)=/)
  })

  it('SHADOW_MAP_SIZE_PIXELS = 2048', () => {
    expect(SHADOW_MAP_SIZE_PIXELS).toBe(2048)
  })
})

describe('TASK-012 静态契约 — 无远程环境资源（SPEC §8.3、TASK-012 实现约束）', () => {
  it('环境光照源码不出现 http(s) URL、HDR 文件或 CDN 域名', () => {
    const sources = [ENVIRONMENT_LAYER, LOCAL_ENVIRONMENT, LOCAL_ENV_SCENE, LOCAL_ENV_PMREM].join('\n')
    expect(sources).not.toMatch(/https?:\/\//i)
    expect(sources).not.toMatch(/\.hdr\b/i)
    expect(sources).not.toMatch(/poly\.haven|cdn\./i)
  })

  it('展示层不从 @react-three/drei 导入 Environment（避免 preset/files 下载远程 HDR）', () => {
    // 扫描全部 scene 源码的 @react-three/drei 导入块，断言绑定名不含 Environment。
    // CameraRig 的 OrbitControls 为允许的相机控件导入；Environment（preset/files）会被拒绝。
    for (const file of ALL_SCENE_FILES) {
      for (const imported of dreiImportedNames(file.content)) {
        expect(imported, `${file.name} 从 drei 导入了 Environment`).not.toBe('Environment')
      }
    }
  })

  it('PMREM 由本地 PMREMGenerator.fromScene 烘焙程序化场景（烘焙逻辑集中于 localEnvironmentPmrem）', () => {
    expect(LOCAL_ENV_PMREM).toContain('PMREMGenerator')
    expect(LOCAL_ENV_PMREM).toContain('fromScene')
    expect(LOCAL_ENV_PMREM).toContain('buildEnvironmentScene')
  })

  it('LocalEnvironment 通过 bakeLocalPmremSession 挂载 PMREM 且烘焙失败不静默吞错', () => {
    // 组件委托 bakeLocalPmremSession 管理生命周期；失败重抛交由场景错误边界，不再以 try/catch 吞错。
    expect(LOCAL_ENVIRONMENT).toContain('bakeLocalPmremSession')
    // 不存在实际的 catch 子句（catch 后跟 ( 或 {）；注释中提及 catch 不影响该判定。
    expect(LOCAL_ENVIRONMENT).not.toMatch(/catch\s*[({]/)
  })
})

describe('TASK-013 静态契约 — 真实平面反射单一方案（SPEC §8.4、TASK-013 实现约束）', () => {
  it('反射材质来自 drei MeshReflectorMaterial（非普通材质伪反射/自研替代）', () => {
    // 反射材质工厂实例化 drei 的 MeshReflectorMaterial 类（onBeforeCompile 注入反射采样着色器）。
    expect(REFLECTION_MATERIAL).toMatch(/from '@react-three\/drei\/materials\/MeshReflectorMaterial'/)
    expect(REFLECTION_MATERIAL).toContain('new MeshReflectorMaterial(')
  })

  it('反射渲染使用 drei BlurPass 做一次粗糙模糊（不自研替代模糊管线）', () => {
    expect(REFLECTION_SESSION).toMatch(/from '@react-three\/drei\/materials\/BlurPass'/)
    expect(REFLECTION_SESSION).toContain('new BlurPass(')
  })

  it('不存在普通材质伪反射、环境贴图反射或第二套反射 fallback', () => {
    const sources = [PLANE_REFLECTION_GROUND, REFLECTION_MATERIAL, REFLECTION_SESSION].join('\n')
    // 不使用普通 MeshStandardMaterial 作为地面伪反射（反射地面唯一使用 MeshReflectorMaterial）。
    expect(PLANE_REFLECTION_GROUND).not.toContain('meshStandardMaterial')
    // 不使用屏幕截图/环境贴图/Reflector 等替代方案。
    expect(sources).not.toMatch(/ReflectorMaterial2|ScreenSpaceReflection|envMap/i)
  })
})

describe('TASK-013 静态契约 — 反射目标固定预算与 resize 不变（SPEC §11.1、TASK-013）', () => {
  it('反射目标分辨率取自 REFLECTION_TARGET_SIZE_PIXELS 常量，不散落数字', () => {
    expect(PLANE_REFLECTION_GROUND).toContain('resolution: REFLECTION_TARGET_SIZE_PIXELS')
    expect(REFLECTION_TARGET_SIZE_PIXELS).toBe(1024)
    // 不在反射组件内散落 1024 / 512 等数字（必须经集中常量）。
    expect(PLANE_REFLECTION_GROUND).not.toMatch(/resolution:\s*\d+/)
  })

  it('反射目标不绑定主画布 DPR、CSS 尺寸或 size（resize 不变性）', () => {
    // 反射组件不从 useThree 读取 size/dpr/viewport；反射会话仅随 gl 重建。
    const sources = [PLANE_REFLECTION_GROUND, REFLECTION_SESSION].join('\n')
    expect(sources).not.toMatch(/state\.size|state\.viewport|state\.performance|devicePixelRatio/i)
    // 反射会话 useMemo 依赖仅 gl，不含 size/dpr。
    expect(PLANE_REFLECTION_GROUND).toMatch(/useThree\(\(state\) => state\.gl\)/)
  })

  it('反射会话在 useLayoutEffect 内创建/释放，依赖数组含 gl 不含主画布尺寸（resize 不变、StrictMode 安全）', () => {
    // 会话在 layout effect 内成对创建/释放（与 PMREM 会话同构），依赖 [gl, material]：
    // 不含 size/dpr/viewport，故 resize 不重建会话；StrictMode 下每次 setup 得全新会话由其 cleanup 释放。
    expect(PLANE_REFLECTION_GROUND).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*createReflectionSession/)
    // useLayoutEffect 依赖数组为 [gl, material]：不含主画布尺寸相关项。
    expect(PLANE_REFLECTION_GROUND).toMatch(/\}, \[gl, material\]\)/)
    // 整个反射组件不读取主画布 size/viewport/dpr（resize 不变性）。
    expect(PLANE_REFLECTION_GROUND).not.toMatch(/state\.size|state\.viewport|state\.performance|devicePixelRatio/i)
  })
})

describe('TASK-013 静态契约 — 反射平面空间由 renderBounds 推导（SPEC §6.3、§8.4）', () => {
  it('EnvironmentLayer 以 layout 挂载 PlaneReflectionGround（地面尺寸/中心由 renderBounds 推导）', () => {
    expect(ENVIRONMENT_LAYER).toContain('<PlaneReflectionGround')
    expect(ENVIRONMENT_LAYER).toContain('layout={layout}')
  })

  it('反射地面几何尺寸取自 layout.groundWidthM / groundDepthM（不写死世界坐标）', () => {
    expect(PLANE_REFLECTION_GROUND).toContain('layout.groundWidthM')
    expect(PLANE_REFLECTION_GROUND).toContain('layout.groundDepthM')
    expect(PLANE_REFLECTION_GROUND).toContain('layout.center')
  })

  it('反射地面不写死绝对世界坐标（尺寸/位置全部经 layout）', () => {
    // 不出现硬编码的 position=[<数字>, ...]（除 rotation-x 与 layout.center 引用外）。
    expect(PLANE_REFLECTION_GROUND).not.toMatch(/position=\{\[-?\d+/)
  })
})

describe('TASK-013 静态契约 — 唯一地面（SPEC §8.1、TASK-013）', () => {
  it('场景中 PlaneReflectionGround 仅挂载一次（EnvironmentLayer 内唯一地面）', () => {
    expect(countOccurrences(ENVIRONMENT_LAYER, '<PlaneReflectionGround')).toBe(1)
  })

  it('EnvironmentLayer 不再内联地面 mesh（地面职责唯一归于 PlaneReflectionGround）', () => {
    // EnvironmentLayer 内剩余 <mesh> 只有网格（独立图层），无地面 mesh。
    expect(countOccurrences(ENVIRONMENT_LAYER, '<mesh')).toBe(1)
  })

  it('MapSceneView 不额外声明地面（无第二个地面）', () => {
    expect(countOccurrences(MAP_SCENE_VIEW, '<mesh')).toBe(0)
  })
})

describe('TASK-013 静态契约 — 反射资源确定性释放（SPEC §5.4、§11.3）', () => {
  it('PlaneReflectionGround 卸载 effect 显式 dispose 几何、材质与会话', () => {
    expect(PLANE_REFLECTION_GROUND).toContain('geometry.dispose()')
    expect(PLANE_REFLECTION_GROUND).toContain('material.dispose()')
    expect(PLANE_REFLECTION_GROUND).toContain('session.dispose()')
  })

  it('反射会话 dispose 与创建失败路径共用 cleanup 逆序释放全部资源（不遗留 RenderTarget）', () => {
    // allocate 登记每个资源到 cleanup；dispose 与创建失败 catch 逆序调用 cleanup（SPEC §5.4，
    // 创建失败与正常卸载共用同一释放序列，避免重复逻辑）。
    expect(REFLECTION_SESSION).toContain('cleanup')
    expect(REFLECTION_SESSION).toContain('allocate')
    // 反射/模糊 RenderTarget 与深度纹理经 allocate 登记释放（rt.dispose / dt.dispose）。
    // 反射 RenderTarget 的深度纹理须单独登记释放（WebGLRenderTarget.dispose 不自动释放 depthTexture）。
    expect(REFLECTION_SESSION).toContain('(rt) => rt.dispose()')
    expect(REFLECTION_SESSION).toContain('(dt) => dt.dispose()')
    // BlurPass 自身无 dispose，须由会话经 allocate 登记其内部两张中间 RenderTarget、卷积材质及其全屏
    // 三角 BufferGeometry 的逐一释放（screen.geometry 在 render 期上传 GPU，计入 geometries 计数，§5.4）。
    expect(REFLECTION_SESSION).toContain('renderTargetA.dispose()')
    expect(REFLECTION_SESSION).toContain('renderTargetB.dispose()')
    expect(REFLECTION_SESSION).toContain('convolutionMaterial.dispose()')
    expect(REFLECTION_SESSION).toContain('screen.geometry?.dispose()')
  })

  it('反射会话创建失败时逆序释放已登记资源后重抛（SPEC §5.4，TASK-013 关键异常路径）', () => {
    // 构造期任一分配抛错时，catch 逆序调用 cleanup 后重抛，避免半开放 RenderTarget/BlurPass 泄漏。
    expect(REFLECTION_SESSION).toMatch(/catch\s*\(\s*error\s*\)\s*\{[\s\S]*?cleanup/)
    expect(REFLECTION_SESSION).toContain('throw error')
  })

  it('反射会话 dispose 幂等（disposed 守卫，重复挂载/卸载不二次释放）', () => {
    expect(REFLECTION_SESSION).toMatch(/let disposed = false/)
    expect(REFLECTION_SESSION).toMatch(/if \(disposed\) return/)
  })
})

describe('TASK-012 静态契约 — Canvas 启用阴影（SPEC §8.3）', () => {
  it('MapSceneView 的 Canvas 声明 shadows 属性', () => {
    expect(MAP_SCENE_VIEW).toMatch(/^\s*shadows\b/m)
  })

  it('MapSceneView 挂载 EnvironmentLayer 并传入 renderBounds', () => {
    expect(MAP_SCENE_VIEW).toContain('<EnvironmentLayer')
    expect(MAP_SCENE_VIEW).toContain('bounds={packet.renderBounds}')
  })
})

describe('TASK-012 静态契约 — 环境层纳入场景错误边界（SPEC §10.2）', () => {
  it('EnvironmentLayer 位于 SceneErrorBoundary 内（PMREM/材质构造失败可进入统一 error 链）', () => {
    // 环境/路径/节点三类数据驱动 GPU 图层须在同一 SceneErrorBoundary 内，任一渲染期或 effect 期
    // 抛错均经 notifySceneCreateFailed 进入统一 error 状态，不展示半成品场景（§10.2、TASK-012）。
    const openIdx = MAP_SCENE_VIEW.indexOf('<SceneErrorBoundary')
    const closeIdx = MAP_SCENE_VIEW.indexOf('</SceneErrorBoundary>')
    expect(openIdx).toBeGreaterThan(-1)
    expect(closeIdx).toBeGreaterThan(openIdx)
    const envIdx = MAP_SCENE_VIEW.indexOf('<EnvironmentLayer')
    expect(envIdx).toBeGreaterThan(openIdx)
    expect(envIdx).toBeLessThan(closeIdx)
  })
})

/** 统计非重叠子串出现次数（用于精确计数 JSX 标签/属性）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  let idx = haystack.indexOf(needle, from)
  while (idx !== -1) {
    count += 1
    from = idx + needle.length
    idx = haystack.indexOf(needle, from)
  }
  return count
}
