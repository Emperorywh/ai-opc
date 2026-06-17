/**
 * WebGL 不支持时的降级视图（SPEC §13.5 / §10「降级静态预览图 + 提示」，Task 17）。
 *
 * App 检测到无 WebGL（detectWebGL）时渲染此组件替代 <Canvas>。内联 SVG 简化世界地图
 * （2:1，七大洲简化色块）+ 中文提示。agent 无浏览器无法生成真实地图截图 → 自包含 SVG
 * 占位（降级路径纯函数 + 组件可测）；真实预览图留人工 `pnpm dev` 截图后替换。
 *
 * 低饱和水彩色取自 palette（§2.1）；与 Scene / Loader 背景协调。
 */
import { palette } from '../config/palette'

/**
 * 简化七大洲色块（2:1 viewBox 400×200；经纬度粗映射：x=(lon+180)/360·400, y=(90-lat)/180·200）。
 * 非精确地理，仅作"可辨认世界地图"的静态预览占位。
 */
const CONTINENTS = [
  // 北美洲
  { shape: 'ellipse', cx: 78, cy: 68, rx: 34, ry: 26, fill: palette.grassland[0] },
  // 南美洲
  { shape: 'ellipse', cx: 112, cy: 142, rx: 18, ry: 30, fill: palette.mountain[0] },
  // 欧洲
  { shape: 'ellipse', cx: 202, cy: 56, rx: 20, ry: 14, fill: palette.desert[0] },
  // 非洲
  { shape: 'ellipse', cx: 212, cy: 116, rx: 26, ry: 34, fill: palette.desert[1] },
  // 亚洲
  { shape: 'ellipse', cx: 292, cy: 66, rx: 52, ry: 30, fill: palette.grassland[1] },
  // 大洋洲
  { shape: 'ellipse', cx: 322, cy: 138, rx: 24, ry: 16, fill: palette.mountain[1] },
  // 南极洲（底部条带）
  { shape: 'rect', x: 0, y: 182, width: 400, height: 18, fill: palette.snow },
] as const

export function WebGLFallback() {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        padding: 24,
        background: '#0e1014',
        fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        color: palette.border,
      }}
    >
      <svg
        viewBox="0 0 400 200"
        width="min(560px, 86vw)"
        style={{ borderRadius: 12, overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }}
        aria-label="世界地图静态预览"
      >
        {/* 海洋背景（深→浅渐变） */}
        <defs>
          <linearGradient id="fb-ocean" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.oceanDeep} />
            <stop offset="100%" stopColor={palette.oceanShallow} stopOpacity={0.7} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="400" height="200" fill="url(#fb-ocean)" />
        {CONTINENTS.map((c, i) =>
          c.shape === 'rect' ? (
            <rect key={i} x={c.x} y={c.y} width={c.width} height={c.height} fill={c.fill} opacity={0.92} />
          ) : (
            <ellipse key={i} cx={c.cx} cy={c.cy} rx={c.rx} ry={c.ry} fill={c.fill} opacity={0.92} />
          ),
        )}
      </svg>

      <div style={{ textAlign: 'center', maxWidth: 520 }}>
        <p style={{ margin: '0 0 8px', fontSize: 'clamp(18px, 2.6vw, 22px)', fontWeight: 600 }}>
          您的浏览器不支持 WebGL
        </p>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, opacity: 0.75 }}>
          世界沙盘需要 WebGL2 才能渲染 3D 地形。当前显示静态预览图，
          <br />
          建议升级至支持 WebGL2 的现代浏览器（Chrome / Edge / Firefox / Safari 新版）
          或在浏览器设置中启用硬件加速。
        </p>
      </div>
    </div>
  )
}
