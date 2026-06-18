/**
 * 国家高亮材质 + countryId 顶点属性（SPEC §6.3「高亮层」，Task 23）。
 *
 * 非组件模块（导出常量 / 纯函数 / 材质工厂），与 picking.ts / boundaryGeometry.ts 同构，
 * 使 CountryMeshes.tsx 满足 react-refresh「单组件导出」规则（同 oceanMaterial.ts 模式）。
 *
 * ─── 高亮契约（SPEC §6.3「hover/selected 时填充色提亮 + 边缘发光」）──────────────────
 * 可见填充 mesh（Task 20 MeshBasicMaterial 占位）升级为 ShaderMaterial：
 *   - 每顶点带 `countryId` attribute（0-based 记录序号，与 picking countryId 同源 ——
 *     picking.ts buildPickColors 同样按 c.vertexOffset..+vertexCount 范围填色）；
 *   - uniforms uHoveredId / uSelectedId：**-1 = 无高亮哨兵**（countryId 0-based，0 是有效国家，
 *     不能用 0 当哨兵，故用负数）；
 *   - 片元按 countryId 匹配 hover/selected：填充色 mix 提亮（hover 中、selected 强）+
 *     selected 国家边缘发光（见下）。hover/selected 时 alpha 提升（更不透明，视觉聚焦）。
 *
 * ─── 边缘发光巧思：fwidth(vCountryId) ──────────────────────────────────────────────
 *   countryId 是 per-vertex attribute。同一国家所有三角形顶点 id 相同 → 片元插值在国家
 *   **内部**恒定 → `fwidth(vCountryId) = 0`；两个不同国家三角形共享边处，片元跨边采样到
 *   不同 id → `fwidth > 0`。故 `fwidth(vCountryId)` **精确标记国家边界**（非三角形细分线）。
 *   selected 国家的边界像素叠加发光色 → 轮廓发光，内部不发光（水彩 / 科技质感）。
 *   与 terrain 海岸线 `fwidth`（Task 08）、normal 细节同源；代码库已验证 fwidth 在
 *   ShaderMaterial + WebGL2 下可用（three 自动注入 derivatives 扩展）。
 *
 * ─── 透明渲染顺序（SPEC §4.3，Task 20 契约不退化）──────────────────────────────────
 *   transparent + depthWrite=false + DoubleSide + renderOrder=2（读 Terrain 深度，山体遮挡
 *   后方填充）。材质透明属性直接复用 COUNTRY_FILL_MATERIAL_OPTS（Task 20 已守，本 Task 不改契约）。
 *
 * ─── 美学（颜色 / 强度）────────────────────────────────────────────────────────────
 *   填充色复用 Task 20 COUNTRY_FILL_COLOR（低饱和草绿，默认几乎不可见）；hover / selected 用
 *   palette 派生暖赭强调色（低饱和，与水彩地形协调、与冷色海洋区分）；发光用 palette.border
 *   暖白。具体观感（提亮程度 / 发光带宽 / 与真实 NE 尺度）交 Review。
 */
import * as THREE from 'three'
import type { BoundaryData } from '../../data/types'
import { palette, desaturateHex } from '../../config/palette'
import {
  COUNTRY_FILL_COLOR,
  COUNTRY_FILL_OPACITY,
  COUNTRY_FILL_MATERIAL_OPTS,
} from './boundaryGeometry'

/** 无高亮哨兵：uHoveredId / uSelectedId 取此值表示「无目标」。countryId 0-based，0 有效，故用 -1。 */
export const HIGHLIGHT_NONE_ID = -1

/**
 * hover 提亮色（palette.desert[0] 浅赭石降饱和 → 柔和暖提示，与水彩地形协调）。
 * selected 用原色（更亮饱和），形成 hover < selected 的视觉递进。
 */
export const HIGHLIGHT_HOVER_COLOR = desaturateHex(palette.desert[0])
/** selected 强调色（palette.desert[0] 原色，比 hover 降饱和版更亮）。 */
export const HIGHLIGHT_SELECTED_COLOR = palette.desert[0]
/** 边缘发光色（palette.border 柔光暖白，与描边同源）。 */
export const HIGHLIGHT_GLOW_COLOR = palette.border

/** hover 填充 mix 强度（0=不提亮，1=全替换为 hover 色）。 */
export const HIGHLIGHT_HOVER_STRENGTH = 0.5
/** selected 填充 mix 强度（高于 hover，强调选中态）。 */
export const HIGHLIGHT_SELECTED_STRENGTH = 0.8
/** hover 态填充不透明度（> 默认 0.16，聚焦可见）。 */
export const HIGHLIGHT_HOVER_OPACITY = 0.32
/** selected 态填充不透明度（> hover，强聚焦）。 */
export const HIGHLIGHT_SELECTED_OPACITY = 0.45
/** 边缘发光亮度系数（叠加 glowColor × edgeMask × 此值）。 */
export const HIGHLIGHT_GLOW_STRENGTH = 1.0
/**
 * 边缘 mask 缩放：edgeMask = clamp(fwidth(countryId) × glowScale, 0, 1)。
 * 跨国边界 fwidth ≥ 1（不同国家 id 差 ≥ 1）→ glowScale=1 即边界 mask=1；同国内部 fwidth=0 → mask=0。
 * 保留为可调位（未来控发光带宽）。
 */
export const HIGHLIGHT_GLOW_SCALE = 1.0

/**
 * 高亮材质透明属性（复用 Task 20 COUNTRY_FILL_MATERIAL_OPTS 契约）：
 * transparent + depthWrite=false + DoubleSide。导出 plain object 供单测断言渲染顺序契约不退化。
 */
export const HIGHLIGHT_MATERIAL_OPTS = COUNTRY_FILL_MATERIAL_OPTS

// ---------------------------------------------------------------------------
// countryId 顶点属性（与 buildPickColors 同源遍历，填 countryId 本身非 pickId）
// ---------------------------------------------------------------------------

/**
 * 为全局顶点池构建每顶点 countryId（Float32Array，1 float/顶点，供 `countryId` attribute）。
 * 按国家 c.vertexOffset..+vertexCount 范围填 c.id（0-based 记录序号）。
 *
 * 顶点顺序与 buildBoundaryPositions / buildPickColors 同源（线性遍历 vertices），
 * 故国家 vertexOffset/vertexCount 范围在 position / color / countryId attribute 中一一对应。
 * 纯函数，Node 单测验证（合成数据）。shader fwidth(countryId) 据此检测国家边界。
 */
export function buildCountryIdAttribute(data: BoundaryData): Float32Array {
  const n = data.vertices.length / 2
  const ids = new Float32Array(n)
  for (const c of data.countries) {
    for (let i = 0; i < c.vertexCount; i++) {
      ids[c.vertexOffset + i] = c.id
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// shader 决策纯函数（与 GLSL fragment 同源，供单测）
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/**
 * countryId 是否匹配高亮目标（GLSL：`target >= 0.0 && abs(id - target) < 0.5`）。
 * target=null 或 < 0（HIGHLIGHT_NONE_ID）→ false（无目标）。
 * 浮点 attribute 插值容差 0.5（同国 id 整数，插值后仍接近该整数）。
 */
export function matchesCountry(countryId: number, targetId: number | null): boolean {
  return targetId !== null && targetId >= 0 && Math.abs(countryId - targetId) < 0.5
}

/**
 * 边缘发光 mask（GLSL：`clamp(fwidth(vCountryId) * uGlowScale, 0.0, 1.0)`）。
 * countryIdFwidth = fwidth(countryId)：同国内部 0，跨国边界 ≥ 1（不同国家 id 差）。
 * glowScale 缩放后 clamp 到 [0,1]：边界 1（发光），内部 0（不发光）。
 */
export function edgeGlowMask(countryIdFwidth: number, glowScale: number): number {
  return clamp01(countryIdFwidth * glowScale)
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const HIGHLIGHT_VERT = /* glsl */ `
  attribute float countryId;   // 每顶点国家 id（0-based，buildCountryIdAttribute）

  varying float vCountryId;    // 传片元供 fwidth 检测国家边界

  void main() {
    vCountryId = countryId;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const HIGHLIGHT_FRAG = /* glsl */ `
  precision highp float;

  uniform float uHoveredId;     // -1 = 无 hover（HIGHLIGHT_NONE_ID）
  uniform float uSelectedId;    // -1 = 无 selected
  uniform vec3 uFillColor;      // Task 20 低饱和填充色（默认几乎不可见）
  uniform vec3 uHoverColor;
  uniform vec3 uSelectedColor;
  uniform vec3 uGlowColor;      // 边缘发光色（palette.border 暖白）
  uniform float uOpacity;       // 默认填充不透明度
  uniform float uHoverStrength;
  uniform float uSelectedStrength;
  uniform float uHoverOpacity;
  uniform float uSelectedOpacity;
  uniform float uGlowStrength;
  uniform float uGlowScale;

  varying float vCountryId;

  void main() {
    float id = vCountryId;
    bool hovered = uHoveredId >= 0.0 && abs(id - uHoveredId) < 0.5;
    bool selected = uSelectedId >= 0.0 && abs(id - uSelectedId) < 0.5;

    vec3 col = uFillColor;
    float alpha = uOpacity;

    if (selected) {
      // selected：强提亮 + 国家边界发光（fwidth(vCountryId) 标记跨国边界，内部为 0）
      col = mix(uFillColor, uSelectedColor, uSelectedStrength);
      alpha = uSelectedOpacity;
      float edge = fwidth(vCountryId);
      float edgeMask = clamp(edge * uGlowScale, 0.0, 1.0);
      col += uGlowColor * edgeMask * uGlowStrength;
    } else if (hovered) {
      // hover：中等提亮（无边缘发光，与 selected 区分层级）
      col = mix(uFillColor, uHoverColor, uHoverStrength);
      alpha = uHoverOpacity;
    }

    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma（与 ocean / terrain 一致）；col 叠加
    // 发光可能 >1，clamp 后再 pow 防溢出。
    vec3 finalCol = clamp(col, 0.0, 1.0);
    gl_FragColor = vec4(pow(finalCol, vec3(1.0 / 2.2)), clamp(alpha, 0.0, 1.0));
  }
`

// ---------------------------------------------------------------------------
// 材质工厂
// ---------------------------------------------------------------------------

/**
 * 创建国家高亮 ShaderMaterial（SPEC §6.3：hover/selected 填充提亮 + selected 边缘发光）。
 *
 * 初始 uHoveredId/uSelectedId = HIGHLIGHT_NONE_ID（无高亮，仅显示 Task 20 低饱和填充）。
 * CountryMeshes 订阅 store hoveredId/selectedId → useEffect 同步这两个 uniform value
 * （material 引用稳定，仅改 uniform，不重建 —— 同 Ocean matRef 同步 uniform 模式）。
 */
export function createHighlightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...HIGHLIGHT_MATERIAL_OPTS,
    uniforms: {
      uHoveredId: { value: HIGHLIGHT_NONE_ID },
      uSelectedId: { value: HIGHLIGHT_NONE_ID },
      uFillColor: { value: new THREE.Color(COUNTRY_FILL_COLOR) },
      uHoverColor: { value: new THREE.Color(HIGHLIGHT_HOVER_COLOR) },
      uSelectedColor: { value: new THREE.Color(HIGHLIGHT_SELECTED_COLOR) },
      uGlowColor: { value: new THREE.Color(HIGHLIGHT_GLOW_COLOR) },
      uOpacity: { value: COUNTRY_FILL_OPACITY },
      uHoverStrength: { value: HIGHLIGHT_HOVER_STRENGTH },
      uSelectedStrength: { value: HIGHLIGHT_SELECTED_STRENGTH },
      uHoverOpacity: { value: HIGHLIGHT_HOVER_OPACITY },
      uSelectedOpacity: { value: HIGHLIGHT_SELECTED_OPACITY },
      uGlowStrength: { value: HIGHLIGHT_GLOW_STRENGTH },
      uGlowScale: { value: HIGHLIGHT_GLOW_SCALE },
    },
    vertexShader: HIGHLIGHT_VERT,
    fragmentShader: HIGHLIGHT_FRAG,
  })
}
