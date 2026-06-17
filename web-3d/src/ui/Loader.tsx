/**
 * 加载进度页（SPEC §加载体验 / §4.2 UI 层 DOM overlay，Task 17）。
 *
 * Canvas 外的 DOM overlay（App 挂载），订阅 store loading 切片渲染分项进度：
 * 进度条（整体 0–1）+ 阶段中文文案 + 百分比；ready 后卸载；错误态显示重试按钮。
 *
 * 资源不走 R3F loader（heightmap/labels 原生 fetch、troika 字体自加载），故不用 drei
 * useProgress（见 ./loading.ts 说明）。Scene 编排加载上报 store，Loader 订阅渲染。
 *
 * 样式自包含（内联 style + 一次性 <style> keyframes），不改全局 index.css（守 M5 边界）；
 * 低饱和水彩色取自 palette（§2.1），背景与 Scene `#0e1014` 协调。
 */
import { useStore } from '../state/store'
import { palette } from '../config/palette'
import { STAGE_LABELS, isReady } from './loading'

/** 加载点呼吸 + 进度条流光（一次性注入，组件卸载随之移除）。 */
const KEYFRAMES = `
@keyframes loader-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
@keyframes loader-shimmer { 0% { transform: translateX(-120%); } 100% { transform: translateX(120%); } }
`

export function Loader() {
  const stage = useStore((s) => s.loadingStage)
  const progress = useStore((s) => s.loadingProgress)
  const error = useStore((s) => s.loadingError)

  // 加载完成且无错误 → 卸载（Canvas 已可见，进度页淡出交后续视觉增强）。
  if (isReady(stage) && !error) return null

  const pct = Math.round(progress * 100)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(14, 16, 20, 0.94)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        color: palette.border,
      }}
    >
      <style>{KEYFRAMES}</style>
      <div style={{ width: 'min(440px, 82vw)', padding: '0 24px' }}>
        <h1
          style={{
            margin: '0 0 6px',
            fontSize: 'clamp(22px, 3.4vw, 30px)',
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: palette.border,
          }}
        >
          世界沙盘
        </h1>
        <p
          style={{
            margin: '0 0 28px',
            fontSize: '13px',
            letterSpacing: '0.14em',
            color: palette.oceanShallow,
            opacity: 0.85,
          }}
        >
          ANIME WORLD ATLAS · 低饱和手绘风地球沙盘
        </p>

        {error ? (
          <div
            role="alert"
            style={{
              padding: '16px 18px',
              borderRadius: 10,
              background: 'rgba(243, 233, 210, 0.06)',
              border: '1px solid rgba(243, 233, 210, 0.18)',
            }}
          >
            <p style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>
              地形数据加载失败
            </p>
            <p
              style={{
                margin: '0 0 16px',
                fontSize: 12,
                lineHeight: 1.6,
                opacity: 0.7,
                wordBreak: 'break-word',
              }}
            >
              {error}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 18px',
                fontSize: 13,
                letterSpacing: '0.06em',
                color: '#0e1014',
                background: palette.border,
                border: 'none',
                borderRadius: 999,
                cursor: 'pointer',
              }}
            >
              重新加载
            </button>
          </div>
        ) : (
          <>
            {/* 进度条：track 深色 + fill 暖白宽度=progress%，CSS transition 平滑跟进 */}
            <div
              style={{
                position: 'relative',
                height: 6,
                borderRadius: 999,
                background: 'rgba(243, 233, 210, 0.12)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${pct}%`,
                  borderRadius: 999,
                  background: palette.border,
                  transition: 'width 320ms ease-out',
                }}
              />
              {/* 流光高光（叠加在 fill 上方，体现活动） */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: '40%',
                  background:
                    'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
                  animation: 'loader-shimmer 1.4s ease-in-out infinite',
                }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginTop: 14,
                fontSize: 13,
                letterSpacing: '0.04em',
              }}
            >
              <span style={{ animation: 'loader-pulse 1.6s ease-in-out infinite' }}>
                {STAGE_LABELS[stage]}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{pct}%</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
