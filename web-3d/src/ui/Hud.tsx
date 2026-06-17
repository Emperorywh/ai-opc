/**
 * HUD 骨架：常驻数据署名 + 许可弹窗（SPEC §6.7 / §12 + M5 Task 18）。
 *
 * Canvas 外的 DOM overlay（App 挂载）：
 * - 常驻署名行（左下角，低饱和暖白小字 + 「许可」按钮触发弹窗）；
 * - 许可弹窗（居中卡片，按分类列出 active 数据来源 + 许可，ESC / 点遮罩关闭）。
 *
 * 与 3D 经 z-index 解耦（非 store）：加载期 Loader（z50 全屏不透明）遮蔽 HUD（z30），
 * ready 后 Loader 自卸载、HUD 显现；弹窗 z60 浮于最上。容器 pointer-events:none，仅在
 * 可交互元素（按钮 / 弹窗）重开 pointer-events:auto，避免遮挡 SandboxControls 拖拽缩放。
 *
 * 样式自包含（内联 style），不改全局 index.css（守 M5 边界）；低饱和水彩色取自 palette
 * （§2.1），与 Loader / WebGLFallback 协调。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { palette } from '../config/palette'
import type { DataSource } from './credits'
import {
  CATEGORY_LABELS,
  FONT_LICENSE_NOTE,
  activeSources,
  formatAttributionLine,
  groupSourcesByCategory,
} from './credits'

const FONT_FAMILY = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'

export function Hud() {
  const [open, setOpen] = useState(false)

  // active 来源 + 署名行（DATA_SOURCES 静态，缓存稳定引用避免子组件无谓重渲染）。
  const sources = useMemo(() => activeSources(), [])
  const attribution = useMemo(() => formatAttributionLine(sources), [sources])

  // ESC 关闭弹窗（仅 open 时挂监听）。
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
  }, [])
  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onKeyDown])

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 30, pointerEvents: 'none', fontFamily: FONT_FAMILY }}
    >
      {/* 左下角常驻署名 */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          bottom: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          maxWidth: 'calc(100vw - 32px)',
          padding: '7px 12px',
          borderRadius: 999,
          background: 'rgba(14, 16, 20, 0.55)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(243, 233, 210, 0.16)',
          fontSize: 12,
          letterSpacing: '0.03em',
          color: palette.border,
          pointerEvents: 'auto',
        }}
      >
        <span
          style={{
            opacity: 0.82,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          数据：{attribution}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            flex: '0 0 auto',
            padding: '4px 12px',
            fontSize: 12,
            letterSpacing: '0.06em',
            color: '#0e1014',
            background: palette.border,
            border: 'none',
            borderRadius: 999,
            cursor: 'pointer',
          }}
        >
          许可
        </button>
      </div>

      {open && <LicenseModal sources={sources} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** 许可弹窗（Hud 内部子组件，不导出以满足 react-refresh/only-export-components）。 */
function LicenseModal({
  sources,
  onClose,
}: {
  sources: readonly DataSource[]
  onClose: () => void
}) {
  // 按分类分组（纯函数，渲染期计算；来源静态故一次性即可）。
  const grouped = useMemo(() => groupSourcesByCategory(sources), [sources])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="数据来源与许可"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(14, 16, 20, 0.72)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        pointerEvents: 'auto',
        fontFamily: FONT_FAMILY,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 92vw)',
          maxHeight: '80vh',
          overflowY: 'auto',
          padding: '22px 24px',
          borderRadius: 14,
          background: '#15181e',
          border: '1px solid rgba(243, 233, 210, 0.18)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.55)',
          color: palette.border,
        }}
      >
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>数据来源与许可</h2>
        <p
          style={{
            margin: '0 0 18px',
            fontSize: 11,
            opacity: 0.55,
            letterSpacing: '0.16em',
          }}
        >
          DATA SOURCES &amp; LICENSES
        </p>

        {grouped.map(([cat, items]) => (
          <section key={cat} style={{ marginBottom: 18 }}>
            <h3
              style={{
                margin: '0 0 10px',
                fontSize: 12,
                letterSpacing: '0.14em',
                color: palette.oceanShallow,
                opacity: 0.9,
              }}
            >
              {CATEGORY_LABELS[cat]}
            </h3>
            {items.map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
            {cat === 'font' && (
              <p
                style={{
                  margin: '8px 0 0',
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  opacity: 0.55,
                }}
              >
                {FONT_LICENSE_NOTE}
              </p>
            )}
          </section>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 20px',
              fontSize: 13,
              letterSpacing: '0.06em',
              color: '#0e1014',
              background: palette.border,
              border: 'none',
              borderRadius: 999,
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/** 单条来源行（名称链接 + 许可徽标 + 用途说明）。 */
function SourceRow({ source: s }: { source: DataSource }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <a
          href={s.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: palette.border, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}
        >
          {s.name}
        </a>
        <span
          style={{
            flex: '0 0 auto',
            fontSize: 11,
            padding: '2px 9px',
            borderRadius: 999,
            background: 'rgba(127, 196, 192, 0.14)',
            color: palette.oceanShallow,
            whiteSpace: 'nowrap',
          }}
        >
          {s.license}
        </span>
      </div>
      <p style={{ margin: '3px 0 0', fontSize: 12, lineHeight: 1.5, opacity: 0.62 }}>{s.role}</p>
    </div>
  )
}
