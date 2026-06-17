/**
 * troika-three-text 0.52 不附带类型定义（package.json 无 `types` 字段、dist 无 .d.ts），
 * 此为最小 ambient 声明（同 Task 03 `fast-png.d.ts` 模式）。仅覆盖 LabelLayer（Task 14）用到的
 * `Text` 类属性 —— SDF 文本渲染（SPEC §6.5「默认 troika-three-text，每标签独立 Text 实例」）。
 *
 * `Text` 继承 `THREE.Object3D`（实际为内部 derived material 的 Mesh），可经 R3F `<primitive>` 挂载；
 * `sync()` 异步生成 SDF（worker 解析字体 + 生成 atlas），`dispose()` 释放 GPU 资源（卸载时调）。
 */
declare module 'troika-three-text' {
  import type { Object3D } from 'three'

  /** troika SDF 文本实例（Object3D，可作 mesh 挂载到场景）。 */
  export class Text extends Object3D {
    /**
     * SDF 同步后的渲染信息（`sync()` 异步完成前为 null）。
     * Task 15 碰撞剔除读 `visibleBounds`（实际可见字形局部 AABB [minX,minY,maxX,maxY]，
     * 文字 XY 平面世界单位，anchor 为原点）投影到屏幕做 AABB 比较。
     */
    textRenderInfo: {
      /** 整个文字块（含行高 padding）的局部 AABB。 */
      blockBounds: [number, number, number, number]
      /** 紧贴可见字形路径的局部 AABB（Task 15 碰撞用）。 */
      visibleBounds: [number, number, number, number]
    } | null
    text: string
    /** 字体 URL（woff2/woff/ttf/otf）；指向 Task 12 子集化产出的 map-zh.woff2。 */
    font: string | null | undefined
    /** 字号（世界单位）。 */
    fontSize: number
    letterSpacing: number
    lineHeight: number | null
    maxWidth: number
    anchorX: number | string
    anchorY: number | string
    whiteSpace: string
    overflowWrap: string
    color: number | string
    /** 描边（动漫/图鉴风描边字，增强可读性）。 */
    outlineWidth: number
    outlineColor: number | string
    outlineOpacity: number
    outlineBlur: number
    outlineOffsetX: number
    outlineOffsetY: number
    strokeWidth: number
    strokeColor: number | string
    strokeOpacity: number
    fillOpacity: number
    /** 片元深度偏移（世界单位，正值拉远/负值拉近相机，调 z-fighting/绘制序）。 */
    depthOffset: number
    orientation: string
    clipRect: unknown
    /** 异步同步字形：设置属性后调用，字体加载/SDF 生成完成后回调。 */
    sync(callback?: () => void): void
    /** 释放 GPU 资源（SDF 纹理/几何）。组件卸载时调用。 */
    dispose(): void
  }
}
