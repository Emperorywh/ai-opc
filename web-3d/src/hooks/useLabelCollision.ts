/**
 * 标签碰撞剔除 + LOD 联动 hook（SPEC §6.5 / §8）—— 把 collision.ts 纯函数算法接入 R3F 渲染循环。
 *
 * Task 15：每帧（节流 2~4 帧）：
 *  1. 读 store cameraZoom + qualityTier → 有效密度（zoomToDensity 与 qualityConfigs.labelDensity 取严）
 *  2. 对每个已 sync 的 troika Text：LOD 过滤 + 文字局部 visibleBounds 4 角经世界矩阵 → 相机 NDC → 屏幕 AABB
 *  3. greedyCollision 贪心剔除
 *  4. 设 text.visible（LOD 不达 / 碰撞剔除 → false，否则 true）
 *
 * 节流（SPEC §8「每 2~4 帧」）：标签量小（M4 11 条）开销可忽略；Phase 2 数百标签时算法 O(n²)
 * 仍可承受（SPEC §6.5.5「排序列表足够」）。store 用 getState 非订阅读取（避免每帧触发 re-render，
 * 同 Task 11 AdaptiveQuality 模式）。
 *
 * troika Text 是 Object3D，mutate 其 visible 是 three 标准渲染控制（非 React state）；
 * texts Map 经 ref 持有（render 期写 ref、useFrame 读 ref），避开 react-hooks/immutability
 * 对 useMemo 返回值的误报与 react-hooks/refs 对 render 期读 ref 的禁令（同 Ocean matRef 模式）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Camera } from 'three'
import type { Text } from 'troika-three-text'
import type { Label } from '../data/types'
import { qualityConfigs } from '../config/quality'
import { useStore } from '../state/store'
import {
  greedyCollision,
  densityVisible,
  zoomToDensity,
  stricterDensity,
  ndcToScreen,
  aabbFromCorners,
  padAabb,
  LABEL_PADDING_PX,
  type AABB,
  type PlacedLabel,
} from '../three/labels/collision'

/** 碰撞计算节流间隔（帧）；SPEC §8「每 2~4 帧」。 */
const COLLISION_INTERVAL_FRAMES = 3

/**
 * 把单个 troika Text 的局部 visibleBounds（[minX,minY,maxX,maxY]，文字 XY 平面世界单位）
 * 投影到屏幕 AABB：4 角点经 text.matrixWorld（局部→世界）→ camera.project（世界→NDC）→ 像素。
 *
 * `text.matrixWorld` 在读取前更新，确保锚点 / group 变换已应用（three 渲染前才自动更新世界矩阵，
 * useFrame 时机可能滞后一帧）。文字面朝 +Z、俯瞰 45° 时屏幕 AABB 取 4 角包围盒（保守包围，
 * 非 OBB）—— 符合 SPEC「视口 AABB」语义。
 */
function projectTextAabb(
  text: Text,
  visibleBounds: [number, number, number, number],
  camera: Camera,
  width: number,
  height: number,
  tmp: Vector3,
): AABB {
  const [minX, minY, maxX, maxY] = visibleBounds
  text.updateMatrixWorld()
  const corners: Array<[number, number]> = []
  const localPts: ReadonlyArray<readonly [number, number]> = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ]
  for (const [lx, ly] of localPts) {
    tmp.set(lx, ly, 0).applyMatrix4(text.matrixWorld).project(camera)
    corners.push(ndcToScreen(tmp.x, tmp.y, width, height))
  }
  return aabbFromCorners(corners)
}

/**
 * 标签碰撞 + LOD 联动。须在 R3F Canvas 子树内调用（读 useThree camera/size + useFrame）。
 *
 * @param texts  每标签 troika Text 实例（key = label.id；LabelLayer 集中持有）
 * @param labels 标签数据（含 kind / priority）
 */
export function useLabelCollision(texts: Map<string, Text>, labels: Label[]): void {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const frameCounter = useRef(0)
  const tmpVec = useMemo(() => new Vector3(), [])

  // 经 ref 持有 texts / labels，useFrame mutate text.visible 不触发 react-hooks/immutability。
  const textsRef = useRef(texts)
  const labelsRef = useRef(labels)
  useEffect(() => {
    textsRef.current = texts
    labelsRef.current = labels
  }, [texts, labels])

  useFrame(() => {
    frameCounter.current += 1
    if (frameCounter.current % COLLISION_INTERVAL_FRAMES !== 0) return

    // store 非订阅读取（避开额外 re-render，同 Task 11 AdaptiveQuality）。
    const { cameraZoom, qualityTier } = useStore.getState()
    const density = stricterDensity(
      zoomToDensity(cameraZoom),
      qualityConfigs[qualityTier].labelDensity,
    )

    const { width, height } = size
    const currentTexts = textsRef.current
    const currentLabels = labelsRef.current

    // 1. 收集「LOD 可见 + 已 sync」标签的屏幕 AABB。
    const candidates: PlacedLabel[] = []
    for (const label of currentLabels) {
      const text = currentTexts.get(label.id)
      if (!text) continue
      if (!densityVisible(label.kind, density)) continue // LOD 不达：不参与碰撞，第 3 步统一隐藏
      const info = text.textRenderInfo
      if (!info) continue // 未 sync（首次渲染），保留默认 visible，下帧再算
      const aabb = padAabb(
        projectTextAabb(text, info.visibleBounds, camera, width, height, tmpVec),
        LABEL_PADDING_PX,
      )
      candidates.push({ id: label.id, priority: label.priority, bounds: aabb })
    }

    // 2. 贪心碰撞剔除。
    const visibleIds = greedyCollision(candidates)

    // 3. 设 visible：LOD 不达 → false；候选集内 → 碰撞结果；未 sync（不在候选）→ 保留当前 visible。
    for (const label of currentLabels) {
      const text = currentTexts.get(label.id)
      if (!text) continue
      if (!densityVisible(label.kind, density)) {
        text.visible = false
        continue
      }
      if (!text.textRenderInfo) continue // 未 sync，保留当前 visible（默认 true）
      text.visible = visibleIds.has(label.id)
    }
  })
}
