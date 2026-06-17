/**
 * 标签层（SPEC §6.5 / §4.3 渲染管线）。
 *
 * Task 14：troika-three-text SDF 文本渲染。每标签独立 `Text` 实例（SPEC §6.5 默认路线），
 * 锚点 = `labelWorldPosition`（project + CPU 高度表 + heightOffset）。消费 Task 13 labels.json
 * + Task 12 map-zh.woff2。billboard 固定向上（troika 默认，俯瞰+45° 倾斜时文字竖直）。
 *
 * 范围切割：Task 14 = 渲染层（11 标签全显、中文无缺字、锚点对齐、4K 60fps）；
 *           Task 15 = collision.ts 优先级视口 AABB 剔除 + useLabelCollision + LOD 联动。
 *
 * troika R3F 集成：`Text` 是 Object3D，经 `<primitive object={t}>` 挂载；属性在 useMemo 构造期
 * 设置 + `sync()`（异步 SDF 生成）；卸载 `dispose()` 释放 GPU（同 Ocean material ref 模式，
 * 构造期 mutate 自建实例合法，非 render 后 mutate）。
 */
import { useMemo, useEffect } from 'react'
import { Text } from 'troika-three-text'
import type { Label, TerrainAssets } from '../../data/types'
import { LABEL_STYLE, labelFontUrl, labelWorldPosition } from './labelLayout'

/**
 * 标签层根：映射 labels → 单标签组件。
 * props：assets（CPU 高度表 + meta，算锚点 y）、labels（Task 13 labels.json，11 条大洲+大洋）。
 */
export function LabelLayer({ assets, labels }: { assets: TerrainAssets; labels: Label[] }) {
  // 字体 URL 懒求值一次（BASE_URL 运行时常量，组件生命期内稳定）。
  const fontUrl = useMemo(() => labelFontUrl(), [])
  return (
    <group>
      {labels.map((label) => (
        <TroikaLabel key={label.id} label={label} fontUrl={fontUrl} assets={assets} />
      ))}
    </group>
  )
}

/** 单个 troika SDF 标签（独立 Text 实例；组件卸载释放 GPU 资源）。 */
function TroikaLabel({
  label,
  fontUrl,
  assets,
}: {
  label: Label
  fontUrl: string
  assets: TerrainAssets
}) {
  const text = useMemo(() => {
    const t = new Text()
    t.text = label.zhName
    t.font = fontUrl
    t.fontSize = LABEL_STYLE.fontSize
    t.anchorX = LABEL_STYLE.anchorX
    t.anchorY = LABEL_STYLE.anchorY
    t.color = LABEL_STYLE.color
    t.outlineWidth = LABEL_STYLE.outlineWidth
    t.outlineColor = LABEL_STYLE.outlineColor
    t.outlineOpacity = LABEL_STYLE.outlineOpacity
    const [x, y, z] = labelWorldPosition(
      label,
      assets.elevation,
      assets.meta,
      LABEL_STYLE.heightOffset,
    )
    t.position.set(x, y, z)
    // 异步同步字形（worker 解析 woff2 + SDF atlas 生成）；属性变更后须再调。
    t.sync()
    return t
  }, [label, fontUrl, assets])

  // 卸载释放 troika GPU 资源（SDF 纹理/几何），避免泄漏。
  useEffect(() => {
    return () => {
      text.dispose()
    }
  }, [text])

  return <primitive object={text} />
}
