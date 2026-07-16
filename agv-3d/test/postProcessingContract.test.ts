import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three'
import {
  BLOOM_THEME,
  COLOR_PIPELINE,
  COMPOSER_MULTISAMPLING,
} from '../src/features/agv-map/config/visualTheme'

/**
 * 唯一色彩输出与后处理管线静态契约测试（SPEC §8.1 PostEffects、§8.5、§3，TASK-014）。
 *
 * 这些属性难以在 Node 环境通过渲染验证（EffectComposer/Bloom/SMAA 渲染需浏览器 WebGL 上下文），
 * 改为对源码做静态契约断言，确保实现不偏离 SPEC 固定契约：
 * - 唯一色彩管线：Canvas onCreated 把 COLOR_PIPELINE（sRGB/ACES/1.0）写入 renderer，组件内不散落
 *   第二套色彩转换；Canvas 原生 antialias 关闭。
 * - 唯一后处理链：PostEffects 接入 EffectComposer，子节点顺序固定为 Bloom → SMAA；不叠加
 *   ToneMapping / FXAA / TAA / 第二套抗锯齿；multisampling 取自 COMPOSER_MULTISAMPLING(0)。
 * - Bloom 阈值驱动：Bloom 参数取自 BLOOM_THEME，不在组件内散落阈值；不按对象创建选择性渲染分支。
 * - 色彩职责不重复：链中不存在 ToneMappingEffect（与 renderer ACES 重复）；自定义路径材质保留
 *   tonemapping_fragment/colorspace_fragment 作为 renderer 色调映射在材质侧的标准出口（非第二套）。
 * - 确定性释放：PostEffects 卸载 effect 显式 composer.dispose()（@react-three/postprocessing 的
 *   <EffectComposer> 卸载时不 dispose，库已知限制），覆盖 Composer 全链资源释放（SPEC §5.4、§11.3）。
 * - 锁定依赖：展示层后处理只从 @react-three/postprocessing 引入 EffectComposer/Bloom/SMAA，
 *   不保留 three examples、自研或替代后处理分支（SPEC §3、§14.2，TASK-014 实现约束）。
 */

const SCENE_DIR = resolve(__dirname, '..', 'src', 'features', 'agv-map', 'presentation', 'scene')

function readScene(rel: string): string {
  return readFileSync(resolve(SCENE_DIR, rel), 'utf8')
}

const POST_EFFECTS = readScene('PostEffects.tsx')
const MAP_SCENE_VIEW = readScene('MapSceneView.tsx')
const PATH_SHADER = readScene('pathShader.ts')

/** 统计非重叠子串出现次数。 */
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

/**
 * 提取 PostEffects 中 `from '@react-three/postprocessing'` 导入块绑定的标识符名。
 *
 * 与 environmentContract.dreiImportedNames 同构：只解析 import 语句，不触及注释/JSX，
 * 用于精确断言后处理依赖图只引入 SPEC 允许的 EffectComposer/Bloom/SMAA，未引入
 * FXAA/TAA/ToneMapping/SelectiveBloom 等替代或重复后处理。
 */
function postprocessingImportedNames(source: string): string[] {
  const names: string[] = []
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@react-three\/postprocessing['"]/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      const id = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (id.length > 0) names.push(id)
    }
  }
  return names
}

/** PostEffects 从 @react-three/postprocessing 引入的全部标识符（断言依赖图锁定）。 */
const POSTPROCESSING_IMPORTS = postprocessingImportedNames(POST_EFFECTS)

describe('TASK-014 静态契约 — 唯一色彩管线（SPEC §8.5）', () => {
  it('Canvas 原生 antialias 关闭（抗锯齿唯一由 SMAA 负责）', () => {
    expect(MAP_SCENE_VIEW).toContain('antialias: false')
  })

  it('Canvas onCreated 把 COLOR_PIPELINE 三要素写入 renderer', () => {
    // 经 COLOR_PIPELINE 集中配置写入，不在组件内散落 sRGB/ACES/曝光数值。
    expect(MAP_SCENE_VIEW).toContain('state.gl.outputColorSpace = COLOR_PIPELINE.outputColorSpace')
    expect(MAP_SCENE_VIEW).toContain('state.gl.toneMapping = COLOR_PIPELINE.toneMapping')
    expect(MAP_SCENE_VIEW).toContain('state.gl.toneMappingExposure = COLOR_PIPELINE.toneMappingExposure')
  })

  it('MapSceneView 引用 COLOR_PIPELINE 配置（不散落 sRGB/ACES/1.0 数值）', () => {
    expect(MAP_SCENE_VIEW).toContain('COLOR_PIPELINE')
    // 不在 onCreated 内散落裸的 ACESFilmicToneMapping / SRGBColorSpace 字面量。
    const onCreatedBlock = MAP_SCENE_VIEW.slice(
      MAP_SCENE_VIEW.indexOf('state.gl.outputColorSpace'),
      MAP_SCENE_VIEW.indexOf('state.gl.toneMappingExposure') + 40,
    )
    expect(onCreatedBlock).not.toMatch(/ACESFilmicToneMapping|SRGBColorSpace/)
  })

  it('COLOR_PIPELINE 与 three.js 常量同源（sRGB / ACESFilmic / 1.0）', () => {
    expect(COLOR_PIPELINE.outputColorSpace).toBe(SRGBColorSpace)
    expect(COLOR_PIPELINE.toneMapping).toBe(ACESFilmicToneMapping)
    expect(COLOR_PIPELINE.toneMappingExposure).toBe(1.0)
  })
})

describe('TASK-014 静态契约 — 唯一后处理链 Bloom → SMAA（SPEC §8.1、§8.5、§3）', () => {
  it('PostEffects 从 @react-three/postprocessing 引入且仅引入 EffectComposer、Bloom、SMAA', () => {
    // 依赖图锁定：只允许这三个标识符，不引入 FXAA/TAA/ToneMapping/SelectiveBloom 等替代或重复后处理。
    expect(POSTPROCESSING_IMPORTS).toContain('EffectComposer')
    expect(POSTPROCESSING_IMPORTS).toContain('Bloom')
    expect(POSTPROCESSING_IMPORTS).toContain('SMAA')
    // 引入集合恰为 {EffectComposer, Bloom, SMAA}：无第二套抗锯齿、无 ToneMapping、无选择性 Bloom。
    expect(POSTPROCESSING_IMPORTS.sort()).toEqual(['Bloom', 'EffectComposer', 'SMAA'])
  })

  it('链路顺序固定为 Bloom 在前、SMAA 在后', () => {
    const bloomIdx = POST_EFFECTS.indexOf('<Bloom')
    const smaaIdx = POST_EFFECTS.indexOf('<SMAA')
    expect(bloomIdx).toBeGreaterThan(-1)
    expect(smaaIdx).toBeGreaterThan(-1)
    expect(bloomIdx).toBeLessThan(smaaIdx)
  })

  it('EffectComposer multisampling 取自 COMPOSER_MULTISAMPLING(0)，不散落数字', () => {
    expect(POST_EFFECTS).toContain('multisampling={COMPOSER_MULTISAMPLING}')
    expect(COMPOSER_MULTISAMPLING).toBe(0)
    // 不在 EffectComposer 上散落 multisampling={数字} 字面量。
    expect(POST_EFFECTS).not.toMatch(/multisampling=\{\d+\}/)
  })

  it('Bloom 参数取自 BLOOM_THEME，不在组件内散落阈值', () => {
    expect(POST_EFFECTS).toContain('mipmapBlur={BLOOM_THEME.mipmapBlur}')
    expect(POST_EFFECTS).toContain('luminanceThreshold={BLOOM_THEME.luminanceThreshold}')
    expect(POST_EFFECTS).toContain('luminanceSmoothing={BLOOM_THEME.luminanceSmoothing}')
    expect(POST_EFFECTS).toContain('intensity={BLOOM_THEME.intensity}')
  })

  it('Bloom 参数与 SPEC §8.5 逐字一致', () => {
    expect(BLOOM_THEME.luminanceThreshold).toBe(1.0)
    expect(BLOOM_THEME.luminanceSmoothing).toBe(0.2)
    expect(BLOOM_THEME.intensity).toBe(1.1)
    expect(BLOOM_THEME.mipmapBlur).toBe(true)
  })

  it('SMAA 为唯一抗锯齿（链中只出现一次 SMAA primitive）', () => {
    // Composer multisampling=0、Canvas antialias=false；抗锯齿唯一由 SMAA 承担。
    expect(countOccurrences(POST_EFFECTS, '<SMAA')).toBe(1)
  })

  it('不保留 three examples / 自研 / 替代后处理分支（SPEC §3、§14.2）', () => {
    // 后处理只从 @react-three/postprocessing 引入；不出现 three/examples 后处理或自研 RenderPass 引用。
    expect(POST_EFFECTS).not.toMatch(/from ['"]three\/examples/)
    expect(POST_EFFECTS).not.toMatch(/UnrealBloomPass/)
  })

  it('Bloom 不按对象创建选择性渲染分支或运行时开关（阈值驱动）', () => {
    // 依赖图已断言未引入 SelectiveBloom；EffectComposer/Bloom 组件也不挂运行时 enabled 开关规避阈值。
    expect(POST_EFFECTS).not.toMatch(/<EffectComposer[^>]*enabled=/)
    expect(POST_EFFECTS).not.toMatch(/<Bloom[^>]*enabled=/)
  })
})

describe('TASK-014 静态契约 — 色彩职责不重复（SPEC §8.5，TASK-014 实现约束）', () => {
  it('自定义路径材质保留 tonemapping_fragment / colorspace_fragment 作为 renderer 色调映射的标准出口', () => {
    // 这些 include 是 three.js 材质消费 renderer.toneMapping/outputColorSpace 的标准机制，
    // 在 EffectComposer 渲染期随 NoToneMapping 变为恒等，使材质输出线性 HDR 供 Bloom 阈值触发；
    // 它不是"第二套"色调映射，而是 renderer 唯一色调映射在材质侧的出口（TASK-014 色彩职责说明）。
    expect(PATH_SHADER).toContain('tonemapping_fragment')
    expect(PATH_SHADER).toContain('colorspace_fragment')
  })

  it('后处理依赖图不含任何色彩转换 effect（ToneMapping/GammaCorrection/BrightnessContrast 等）', () => {
    // 链路只含 Bloom → SMAA；依赖图已锁定为 {EffectComposer, Bloom, SMAA}，
    // 不含任何会与 renderer COLOR_PIPELINE 重复执行 tone mapping 或色彩空间转换的 effect。
    const forbidden = ['ToneMapping', 'GammaCorrection', 'BrightnessContrast', 'HueSaturation', 'LUT']
    for (const name of forbidden) {
      expect(POSTPROCESSING_IMPORTS, `依赖图引入了 ${name}`).not.toContain(name)
    }
  })
})

describe('TASK-014 静态契约 — Composer 确定性释放（SPEC §5.4、§11.3）', () => {
  it('PostEffects 经 forwardRef 拿到 composer 实例（ElementRef 推导，不直接依赖 postprocessing 子包）', () => {
    expect(POST_EFFECTS).toMatch(/ElementRef<typeof EffectComposer>/)
    expect(POST_EFFECTS).toContain('composerRef')
  })

  it('卸载 effect 结构：捕获 composer 引用 → cleanup 调 dispose → 依赖数组为空', () => {
    // 匹配实际代码结构（非注释）：const composer = composerRef.current ... return () => { composer.dispose() } }, [])
    // 该正则跨越 cleanup 体与空依赖数组，确认 StrictMode 下成对 setup/cleanup、每次释放当次 composer。
    expect(POST_EFFECTS).toMatch(
      /const composer = composerRef\.current[\s\S]*?return \(\) => \{[\s\S]*?composer\.dispose\(\)[\s\S]*?\}, \[\]\)/,
    )
  })
})

describe('TASK-014 静态契约 — MapSceneView 接入 PostEffects（SPEC §8.1）', () => {
  it('MapSceneView 挂载 PostEffects', () => {
    expect(MAP_SCENE_VIEW).toContain('<PostEffects')
  })

  it('MapSceneView 引入 PostEffects 组件', () => {
    expect(MAP_SCENE_VIEW).toMatch(/from ['"]\.\/PostEffects['"]/)
  })
})
