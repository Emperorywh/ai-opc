/**
 * 标签层（SPEC §6.5 / §4.3 渲染管线）。
 *
 * Task 14：troika-three-text SDF 文本渲染。每标签独立 `Text` 实例（SPEC §6.5 默认路线），
 * 锚点 = `labelWorldPosition`（project + CPU 高度表 + heightOffset）。消费 Task 13 labels.json
 * + Task 12 map-zh.woff2。billboard 固定向上（troika 默认，俯瞰+45° 倾斜时文字竖直）。
 *
 * Task 15：接入 useLabelCollision（优先级视口 AABB 贪心剔除 + LOD 缩放/质量档密度联动）。
 * texts Map 集中持有所有 Text 实例，供碰撞每帧（节流）遍历投影 + 设 visible。
 *
 * troika R3F 集成：`Text` 是 Object3D，经 `<primitive object={t}>` 挂载；属性在 useMemo 构造期
 * 设置 + `sync()`（异步 SDF 生成）；卸载 `dispose()` 释放 GPU（同 Ocean material ref 模式，
 * 构造期 mutate 自建实例合法，非 render 后 mutate）。
 */
import { useMemo, useEffect } from 'react'
import { Text } from 'troika-three-text'
import type { Label, TerrainAssets } from '../../data/types'
import { LABEL_STYLE, labelFontUrl, labelWorldPosition } from './labelLayout'
import { useLabelCollision } from '../../hooks/useLabelCollision'

/**
 * 标签层根：创建所有 troika Text 实例（texts Map），primitive 挂载，useLabelCollision 驱动 visible。
 * props：assets（CPU 高度表 + meta，算锚点 y）、labels（Task 13 labels.json，11 条大洲+大洋）。
 */
export function LabelLayer({ assets, labels }: { assets: TerrainAssets; labels: Label[] }) {
  // 字体 URL 懒求值一次（BASE_URL 运行时常量，组件生命期内稳定）。
  const fontUrl = useMemo(() => labelFontUrl(), [])

  // 每标签独立 troika Text（SPEC §6.5「每标签独立 Text 实例」）。labels / assets 变更才重建。
  const texts = useMemo(() => {
    const map = new Map<string, Text>()
    for (const label of labels) {
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
      map.set(label.id, t)
    }
    return map
  }, [labels, fontUrl, assets])

  // 卸载释放 troika GPU 资源（SDF 纹理/几何），避免泄漏。
  useEffect(() => {
    return () => {
      texts.forEach((t) => t.dispose())
    }
  }, [texts])

  // Task 15：碰撞剔除 + LOD 联动（每帧节流设 text.visible）。
  useLabelCollision(texts, labels)

  return (
    <group>
      {labels.map((label) => {
        const t = texts.get(label.id)
        return t ? <primitive key={label.id} object={t} /> : null
      })}
    </group>
  )
}
