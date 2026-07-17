/*
 * 按需标签图层与静止零空转帧协调器（scene 装配层，SPEC 11.3 / 11.4 / 13 / 4.3 / 15.5 / 任务约束）。
 *
 * 信任边界定位（TASK-022）：
 *   - 本组件是“标签描述符集合 + 字体门禁信号 → 最多 400 个始终朝向相机的 Troika Text”的唯一 R3F 装配点。
 *   - 只消费不可变 LabelDescriptor[] 与 fontReady 信号；不解析原始 JSON、不重算锚点 / 局部偏移、
 *     不重新判断车道偏移（任务约束）。
 *
 * 字体门禁接入不变量（SPEC 11.1 / 4.2 / 任务约束）：
 *   - fontReady = false 时帧协调器不查询可见集、不挂载任何标签（planLabelFrame 字体门禁）。
 *   - 调用方（App）只在 LoadState = ready（model + resources + fontReady 三道门禁全通过）时挂载本层，
 *     故运行时进入本组件即字体已预载；fontReady 显式参数使门禁接入可单测、防御性成立。
 *   - 不重复打包字体 / 复制 glyph 校验 / preload；不远程字体、不系统字体 fallback（任务约束）。
 *
 * 差量挂载不变量（SPEC 11.3 第 7 项 / 任务约束）：
 *   - 可见集由 computeLabelVisibilitySet（TASK-021）计算并截断到 400；本层只把目标集合经 React 状态
 *     setMountedIds 提交，React 按 key 调和对差量 create / destroy LabelTextItem，不重建整个列表、
 *     不预创建隐藏 Text（SPEC 11.3 第 7 项 / 任务“禁止全量隐藏 Text”）。
 *   - 初始标准 fit 后全部投影字号 < 进入阈值 → 目标集合为空 → 首屏已挂载 Text 数为 0（SPEC 11.4）。
 *
 * 单一帧协调器不变量（SPEC 11.4 / 任务“标签层只有一个帧协调器”）：
 *   - 本层恰有一个 useFrame：每帧把 camera quaternion + 由 camera 朝向推导的屏幕偏移位姿批量写入
 *     当前最多 400 个 Text 对象（computeLabelTextTransform + 直接写对象）。
 *   - 标签集合变化走 React 状态（setMountedIds）；逐帧朝向直接写对象，不触发 React setState（SPEC 11.4）。
 *   - 每个 LabelTextItem 不注册 useFrame、不嵌套 <Billboard>（任务约束）。
 *
 * demand 帧调度不变量（SPEC 13 / §15.5 / 任务约束）：
 *   - 静止时 <Canvas frameloop="demand"> 不常驻 60 FPS；本层不发起常驻帧请求。
 *   - 可见集变化后显式 invalidate 请求一次渲染；首帧 / resize 由 planLabelFrame 标记 invalidate。
 *   - 相机持续位移期间复用 TASK-021 调度器 10Hz 节流；位移刚结束产出 'controls-end' 立即查询确保末态不漏。
 *   - 文字 SDF 同步完成由 LabelTextItem 在 sync 回调内 invalidate（SPEC 13）。
 *
 * 生命周期不变量（SPEC 4.3 / 任务“卸载只调用既有所有者的幂等释放边界”）：
 *   - 每个 Text 由其 LabelTextItem 成对创建 / dispose；本层卸载时 React 卸载全部 LabelTextItem，
 *     触发各自 cleanup dispose，StrictMode / HMR 下计数平衡、无悬挂 Text。
 *
 * 依赖方向（SPEC 3.3）：labels（空间索引 / 可见集 / 描述符 / 配置常量）+ 本层（labelFrameCoordinator /
 *   labelText / LabelTextItem）+ r3f + react；不依赖 application / workers / camera / 原始数据。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import type { LabelDescriptor } from '../../labels/labelDescriptor'
import { buildLabelSpatialIndex } from '../../labels/labelSpatialIndex'
import type { LabelSpatialIndex } from '../../labels/labelSpatialIndex'
import { computeLabelVisibilitySet } from '../../labels/labelVisibilitySet'
import { LABEL_GRID_CELL_SIZE } from '../../labels/labelVisibilityConfig'
import { LABEL_FONT_URL } from '../../config/fontConfig'
import {
  applyVisibilityTarget,
  buildLabelCameraInput,
  computeLabelTextTransform,
  initialLabelCoordinatorState,
  makeCameraSignature,
  planLabelFrame,
} from '../labelFrameCoordinator'
import type { LabelCoordinatorState } from '../labelFrameCoordinator'
import { LabelTextItem } from '../LabelTextItem'
import type { Text } from 'troika-three-text'

/*
 * 按需标签图层入参。
 *   - descriptors：SceneModel.labels（启动时建立的 4810 个不可变描述符，标签唯一名称来源）。
 *   - fontReady：字体门禁是否通过（application 层 ready 状态的必要条件；false 时不挂载任何标签）。
 *   - fontUrl：本地字体 URL（默认 LABEL_FONT_URL，禁止远端）。
 */
export interface LazyLabelLayerProps {
  readonly descriptors: readonly LabelDescriptor[]
  readonly fontReady: boolean
  readonly fontUrl?: string
}

/*
 * 按需标签图层主组件。
 *
 * 装配（SPEC §13 LazyLabelLayer）：
 *   - 空间索引（useMemo，随 descriptors 稳定）+ 描述符表（id → descriptor，供朝向位姿与 LabelTextItem 查询）。
 *   - mountedIds：当前已挂载标签 ID 数组（React 状态，集合变化唯一入口）。
 *   - 单一 useFrame 帧协调器：planLabelFrame 决策 → 可见集查询 → 差量 setMountedIds → 批量朝向写入。
 */
export function LazyLabelLayer({
  descriptors,
  fontReady,
  fontUrl = LABEL_FONT_URL,
}: LazyLabelLayerProps): React.JSX.Element {
  // 选择性订阅 camera / size / invalidate，避免无关 R3F 状态变更触发重渲染。
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)

  // 空间索引：启动时对全部描述符分桶（SPEC 11.3 第 2 项）；随 descriptors 稳定，不重复构建。
  const spatialIndex = useMemo<LabelSpatialIndex>(
    () => buildLabelSpatialIndex(descriptors, LABEL_GRID_CELL_SIZE),
    [descriptors],
  )
  // 描述符表：id → descriptor，供朝向位姿计算与 LabelTextItem 取描述符。
  const descriptorMap = useMemo<ReadonlyMap<string, LabelDescriptor>>(
    () => {
      const m = new Map<string, LabelDescriptor>()
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i]
        m.set(d.id, d)
      }
      return m
    },
    [descriptors],
  )

  // 已挂载标签 ID 数组（React 状态，集合变化唯一入口）；ref 同步以避免 useFrame 闭包读到过期值。
  const [mountedIds, setMountedIds] = useState<readonly string[]>([])
  const mountedIdsRef = useRef<readonly string[]>(mountedIds)

  // 帧协调器状态（prevSignature / wasMoving / scheduler / prevSize）：唯一持有，不进 React 状态。
  const coordStateRef = useRef<LabelCoordinatorState>(initialLabelCoordinatorState())
  // 已登记 Text 对象表（id → Text）：LabelTextItem 注册 / 注销，帧协调器每帧批量写入朝向。
  const textObjectsRef = useRef<Map<string, Text>>(new Map())

  // LabelTextItem 注册 / 注销回调：稳定身份（useCallback），不引发子组件重复创建 Text。
  const onTextReady = useCallback((id: string, text: Text) => {
    textObjectsRef.current.set(id, text)
  }, [])
  const onTextDestroy = useCallback((id: string) => {
    textObjectsRef.current.delete(id)
  }, [])

  /*
   * 单一帧协调器（SPEC 11.4 / 任务“标签层只有一个帧协调器”）。
   * 每帧：决策是否查询可见集 → 差量更新挂载集合 → 批量写入 Text 朝向 / 位姿 → 必要时 invalidate。
   * 不注册 controls 监听 / 不嵌套 Billboard；相机逐帧状态由 useThree 提供。
   */
  useFrame(() => {
    const cam = camera as PerspectiveCamera
    // 相机矩阵更新：保证 matrixWorldInverse / projectionMatrix 为当前帧值（Three camera.updateMatrixWorld）。
    cam.updateMatrixWorld()

    // 提取本帧相机位姿签名（位置 + 世界四元数）；非有限位姿返回 null，planLabelFrame 据此跳过。
    const signature = makeCameraSignature(
      cam.position.x, cam.position.y, cam.position.z,
      cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w,
    )
    const plan = planLabelFrame({
      state: coordStateRef.current,
      currentSignature: signature,
      size: { width: size.width, height: size.height },
      nowMs: performance.now(),
      fontReady,
    })
    coordStateRef.current = plan.state

    // 可见集查询：复用 TASK-021 computeLabelVisibilitySet（视锥 / 字号 / 迟滞 / 400 截断 / 差量）。
    if (plan.shouldQuery) {
      const camInput = buildLabelCameraInput({
        projectionMatrix: cam.projectionMatrix.elements,
        matrixWorldInverse: cam.matrixWorldInverse.elements,
        quaternion: cam.quaternion,
        size: { width: size.width, height: size.height },
      })
      const result = computeLabelVisibilitySet({
        spatialIndex,
        camera: camInput,
        mountedIds: new Set(mountedIdsRef.current),
      })
      if (result !== null) {
        // 差量：只在目标与当前已挂载不同时 setMountedIds + invalidate（SPEC 11.3 第 7 项）。
        const applied = applyVisibilityTarget(mountedIdsRef.current, result.targetIds)
        if (applied.changed) {
          mountedIdsRef.current = applied.nextMounted
          setMountedIds(applied.nextMounted)
          invalidate()
        }
      }
    }

    // 批量朝向写入：把 camera quaternion + 屏幕偏移位姿写入所有已登记 Text（SPEC 11.4，不触发 setState）。
    const texts = textObjectsRef.current
    if (texts.size > 0) {
      const cq = cam.quaternion
      for (const entry of texts) {
        const desc = descriptorMap.get(entry[0])
        if (desc === undefined) continue
        const transform = computeLabelTextTransform(cq, desc)
        const t = entry[1]
        t.quaternion.set(
          transform.quaternion[0], transform.quaternion[1], transform.quaternion[2], transform.quaternion[3],
        )
        t.position.set(transform.position[0], transform.position[1], transform.position[2])
      }
    }

    // 首帧 / resize 显式 invalidate：确保 demand 帧模式下首屏与尺寸变化后必有一次渲染（SPEC 13）。
    if (plan.invalidate) invalidate()
  })

  return (
    <>
      {/*
        已挂载标签：每个 LabelTextItem 装配一个 Troika Text，key 为稳定标签 ID（不用数组下标）。
        集合变化由 setMountedIds 驱动，React 按 key 调和对差量 create / destroy。
      */}
      {mountedIds.map((id) => {
        const descriptor = descriptorMap.get(id)
        if (descriptor === undefined) return null
        return (
          <LabelTextItem
            key={id}
            descriptor={descriptor}
            fontUrl={fontUrl}
            onTextReady={onTextReady}
            onTextDestroy={onTextDestroy}
          />
        )
      })}
    </>
  )
}
