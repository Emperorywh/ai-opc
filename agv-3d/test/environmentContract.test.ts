import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHADOW_MAP_SIZE_PIXELS } from '../src/features/agv-map/config/performanceConfig'

/**
 * 深色沙盘环境静态契约测试（SPEC §8.1、§8.3、§8.4、§11.1，TASK-012 静态检查）。
 *
 * 这些属性难以在 Node 环境通过渲染验证（需浏览器 WebGL 上下文），改为对源码做静态契约断言：
 * - 单一灯光配置：全局仅一个 <directionalLight>（带阴影）与一个 <ambientLight>（低强度）。
 * - 仅节点投射阴影：castShadow 只出现在 NodeLayer（节点实例）与 EnvironmentLayer（方向光）；
 *   PathLayer、地面、网格均不投射阴影。
 * - 阴影贴图预算：directionalLight 的 shadow-mapSize 取自 SHADOW_MAP_SIZE_PIXELS（2048×2048）。
 * - 无远程环境资源：环境相关源码不出现 http(s) URL、HDR 文件、CDN、<Environment preset>。
 * - 不混入平面反射：本期不引入 MeshReflectorMaterial（TASK-012 完成标准）。
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

  it('EnvironmentLayer 仅在方向光上 castShadow，地面只 receiveShadow、网格不参与阴影', () => {
    // 方向光启用 castShadow；地面 mesh 声明 receiveShadow 但无 castShadow；网格 mesh 无阴影属性。
    expect(countOccurrences(ENVIRONMENT_LAYER, 'castShadow')).toBe(1)
    expect(ENVIRONMENT_LAYER).toMatch(/castShadow/)
    expect(ENVIRONMENT_LAYER).toContain('receiveShadow')
    // 网格 mesh 为 EnvironmentLayer 最后一个 <mesh（位于地面 mesh 之后），不应带 castShadow/receiveShadow。
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
    const sources = [ENVIRONMENT_LAYER, LOCAL_ENVIRONMENT, LOCAL_ENV_SCENE].join('\n')
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

  it('PMREM 由本地 PMREMGenerator.fromScene 烘焙程序化场景', () => {
    expect(LOCAL_ENVIRONMENT).toContain('PMREMGenerator')
    expect(LOCAL_ENVIRONMENT).toContain('fromScene')
    expect(LOCAL_ENVIRONMENT).toContain('buildEnvironmentScene')
  })
})

describe('TASK-012 静态契约 — 不混入平面反射（TASK-012 完成标准）', () => {
  it('环境相关源码不引入 MeshReflectorMaterial（属后续平面反射任务）', () => {
    const sources = [ENVIRONMENT_LAYER, MAP_SCENE_VIEW].join('\n')
    expect(sources).not.toMatch(/MeshReflectorMaterial/i)
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
