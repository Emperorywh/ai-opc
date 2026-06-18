/**
 * 数据标注面板（SPEC §6.7 / D19「仅名称+所属大洲」，Task 24）。
 *
 * click 选中（store.selectedId，Task 23 usePointerPick 点击流转）国家 → 弹出中式信息卡片：
 * 中文国名 + 所属大洲。定位于国家质心屏幕投影（drei <Html> 世界锚点）。
 *
 * ─── 定位（R2/R3 同源）─────────────────────────────────────────────────────────
 * 世界锚点 = countryAnchorLonLat（§10 落海修复：USA 用主体陆地人工锚点，其余用顶点均值）
 *   → project(lon,lat) 得 [x,z]；y = max(sampleWorldY, seaLevelWorldY) + CARD_Y_OFFSET
 *   （与 labelWorldPosition / buildBoundaryPositions 同源贴地 + 浮起）。
 * drei <Html position={[x,y,z]} center> 每帧据相机把世界点投到屏幕 → 卡片随 pan/zoom 自动跟随
 *   （几何静态，仅 position prop 随 selectedId 变；相机跟随由 Html 内部 useFrame 完成）。
 *
 * ─── 可见性 & 入场动画 ──────────────────────────────────────────────────────────
 * 仅 selectedId（click 钉住，稳定交互；hover 高亮已由 Task 23 提供，hover 卡片留作后续打磨）。
 * selectedId=null 不渲染（<Html> 卸载）；再次选中重新挂载 → CSS 入场动画重播。
 * selectedId 在两国间切换时 <Html> 保持挂载、position 更新、卡片 div 不重挂 → 不重复动画，
 *   仅文字平滑更新（React 同位复用，CSS animation 不重启）。
 *
 * ─── 关闭 ──────────────────────────────────────────────────────────────────────
 * · × 按钮 / Esc（SPEC §9 无障碍「Esc 取消选中」）→ store.setSelected(null)。
 *
 * ─── 边界 ──────────────────────────────────────────────────────────────────────
 * 仅 src/three/labels/**（countryInfo.ts 纯函数 + 本组件）。读 store.selectedId/setSelected，
 * 不改 store 骨架、不动 LabelLayer/collision（Task 25 国家地图标签范畴）、不动边界/地形/海洋 shader。
 * 样式自包含（内联 style + 一次性注入的 <style> keyframes，不触碰全局 index.css，守 M5 边界）。
 */
import { useEffect } from 'react'
import { Html } from '@react-three/drei'
import { project, metersToWorldY } from '../../config/projection'
import { sampleWorldY } from '../../data/assets'
import type { BoundaryData, TerrainAssets } from '../../data/types'
import { useStore } from '../../state/store'
import { palette } from '../../config/palette'
import { countryAnchorLonLat, resolveCountryInfo } from './countryInfo'

const FONT_FAMILY = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'

/**
 * 卡片锚点 Y 浮起（世界单位）。略大于标签 heightOffset(0.012) / 边界 BOUNDARY_Y_OFFSET(0.003)：
 * 卡片为屏幕空间 DOM，世界 Y 仅决定「锚定在国家上方哪一点」——稍浮起让指示点略高于地表。
 */
const CARD_Y_OFFSET = 0.02

/** 入场动画 keyframes（柔和：透明度 + 上移 + 微缩放，~0.26s ease-out）。 */
const CARD_KEYFRAMES_ID = 'country-card-keyframes'
const CARD_KEYFRAMES_CSS = `
@keyframes countryCardIn {
  from { opacity: 0; transform: translateY(10px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}`

/** 注入 keyframes <style>（幂等：缺则建，已在则跳过）。组件挂载时调一次。 */
function ensureKeyframes(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CARD_KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = CARD_KEYFRAMES_ID
  style.textContent = CARD_KEYFRAMES_CSS
  document.head.appendChild(style)
}

/**
 * 卡片 R3F 组件：需在 <Canvas> 内挂载（Scene 挂载，assets+boundaries 双就绪后）。
 * selectedId=null 或越界 → 不渲染。
 */
export function CountryCard({
  assets,
  boundaries,
}: {
  assets: TerrainAssets
  boundaries: BoundaryData
}) {
  const selectedId = useStore((s) => s.selectedId)
  const setSelected = useStore((s) => s.setSelected)

  // Esc 取消选中（SPEC §9）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSelected])

  // 入场动画 keyframes 一次性注入。
  useEffect(() => {
    ensureKeyframes()
  }, [])

  if (selectedId == null) return null
  const country = boundaries.countries[selectedId]
  if (!country) return null

  const info = resolveCountryInfo(country, boundaries.continents)
  const [lon, lat] = countryAnchorLonLat(boundaries, country)
  const [x, z] = project(lon, lat)
  const groundY = sampleWorldY(assets.elevation, assets.meta, lon, lat)
  const seaY = metersToWorldY(assets.meta.seaLevelMeters)
  const y = Math.max(groundY, seaY) + CARD_Y_OFFSET

  const close = () => setSelected(null)

  return (
    <Html
      position={[x, y, z]}
      center
      zIndexRange={[50, 35]}
      style={{ pointerEvents: 'none' }}
    >
      <div
        role="dialog"
        aria-label={`${info.zhName}信息`}
        style={{
          position: 'relative',
          minWidth: 132,
          padding: '12px 16px 13px',
          borderRadius: 12,
          background: 'rgba(14, 16, 20, 0.78)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(243, 233, 210, 0.18)',
          boxShadow: '0 14px 40px rgba(0, 0, 0, 0.5)',
          color: palette.border,
          fontFamily: FONT_FAMILY,
          textAlign: 'left',
          userSelect: 'none',
          animation: 'countryCardIn 0.26s ease-out both',
        }}
      >
        <button
          type="button"
          aria-label="关闭"
          onClick={close}
          style={{
            position: 'absolute',
            top: 4,
            right: 6,
            width: 20,
            height: 20,
            lineHeight: '18px',
            padding: 0,
            border: 'none',
            borderRadius: 999,
            background: 'rgba(243, 233, 210, 0.1)',
            color: palette.border,
            fontSize: 14,
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          ×
        </button>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.02em' }}>
          {info.zhName}
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 11.5,
            letterSpacing: '0.14em',
            color: palette.oceanShallow,
            opacity: 0.9,
          }}
        >
          {info.zhContinent}
        </div>
      </div>
    </Html>
  )
}
