/**
 * 图例面板（SPEC §6.7「Legend 图例（地物配色说明）」，Task 25）。
 *
 * Canvas 外 DOM overlay（App 挂载，与 Hud 同层 z30）：可折叠配色图例，说明地图可见地物
 * 配色语义（海洋 / 地形分层 / 国家边界 / 争议虚线）。配色与渲染层同源（见 legend.ts）。
 *
 * ─── 定位 & 层级 ───────────────────────────────────────────────────────────────
 * 右上角常驻（与左下角署名 Hud 分立）。z-index=30 与 Hud 同层；加载期被 Loader（z50 全屏）
 * 遮蔽，ready 后显现。容器 pointer-events:none，仅面板 + 折叠按钮重开 pointer-events:auto
 * （不遮挡 SandboxControls 拖拽缩放）。
 *
 * ─── 折叠 ──────────────────────────────────────────────────────────────────────
 * 默认展开；点标题行切换。收起后仅留标题条（少占屏幕，专注看图）。
 *
 * ─── 边界 ──────────────────────────────────────────────────────────────────────
 * 仅 src/ui/**（legend.ts 数据 + 本组件）。读 palette（只读不改），不改 store / 地形/海洋/边界
 * shader 主体。样式自包含（内联 style，不触碰全局 index.css，守 M5/M8 边界）。
 */
import { useState } from 'react'
import { palette } from '../config/palette'
import { LEGEND_ITEMS, type LegendItem } from './legendData'

const FONT_FAMILY = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'

/** 色样背景 CSS：单色=纯色，渐变对 [浅,深]=横向渐变（海洋深浅）。 */
function swatchBackground(item: LegendItem): string {
  return Array.isArray(item.color)
    ? `linear-gradient(90deg, ${item.color[0]}, ${item.color[1]})`
    : item.color
}

export function Legend() {
  const [open, setOpen] = useState(true)

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 30, pointerEvents: 'none', fontFamily: FONT_FAMILY }}
    >
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          minWidth: 132,
          maxWidth: 'calc(100vw - 32px)',
          padding: open ? '11px 14px 9px' : '7px 12px',
          borderRadius: 12,
          background: 'rgba(14, 16, 20, 0.55)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(243, 233, 210, 0.16)',
          color: palette.border,
          pointerEvents: 'auto',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 8,
            padding: 0,
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.04em' }}>图例</span>
          <span style={{ fontSize: 11, opacity: 0.55, letterSpacing: '0.14em' }}>
            {open ? '收起 ▴' : '展开 ▾'}
          </span>
        </button>

        {open && (
          <ul style={{ listStyle: 'none', margin: '9px 0 0', padding: 0 }}>
            {LEGEND_ITEMS.map((item) => (
              <li
                key={item.label}
                style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}
              >
                {item.shape === 'solid' ? (
                  <span
                    style={{
                      width: 24,
                      height: 12,
                      borderRadius: 3,
                      background: swatchBackground(item),
                      border: '1px solid rgba(243, 233, 210, 0.22)',
                      flex: '0 0 auto',
                    }}
                  />
                ) : (
                  <span
                    aria-hidden
                    style={{
                      width: 24,
                      borderTop: `2px ${item.shape === 'dashed' ? 'dashed' : 'solid'} ${swatchBackground(item)}`,
                      flex: '0 0 auto',
                    }}
                  />
                )}
                <span style={{ fontSize: 12, opacity: 0.88 }}>{item.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
