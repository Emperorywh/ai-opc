/**
 * 省名 / 省会光点 / 岛礁名称标注的主图渲染层（TASK-016 基础呈现 + TASK-017 地形遮挡淡化）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的省名标签 / 省会光点 / 岛礁名称标签的世界
 *   坐标（PreparedPlaceLabels）装配成 drei Billboard + Text（troika，始终面向相机）+ 球体发光光点，
 *   并按地形遮挡判定调制省名 / 岛礁名标签的透明度」。它**只**依赖：配置层（PLACE_LABELS_CONFIG ——
 *   颜色 / 字号 / 光点半径 / 字体 URL 的唯一源；LABEL_OCCLUSION_CONFIG —— 遮挡目标透明度 / 采样 / 降频 /
 *   阻尼的唯一源）、领域层（PreparedPlaceLabels 类型 + computeLabelVisibility 纯函数 + TerrainWorldYSampler
 *   闭包类型）、three / R3F / drei（Billboard / Text / useFrame）。**禁止**自行读取地点 / 政治资产、复制
 *   投影 / 高程逻辑、或在组件内补写省名 / 岛礁坐标（TASK-016 实现约束「视图层只消费准备好的标签数据」
 *   「不得在组件内补写坐标或中文名称副本」）。
 * - 本组件只消费领域层产物与一个抽象地形采样器，**不**持有 ElevationProvider 引用、不读取 hover 状态、
 *   不改 UI overlay（TASK-017 实现约束「遮挡判定层可依赖相机、地形查询和标签位置，不得修改资产数据、
 *   hover 状态或 UI overlay」）。
 *
 * 始终面向相机（SPEC §3.7「Billboard 广告牌始终面向相机」、TASK-016 验证方式 4「省名和岛礁文字始终面向
 *   相机」）：
 * - 每个省名 / 岛礁名称标签用 drei <Billboard> 包裹 troika <Text>。Billboard 每帧把其子树的朝向同步为相机
 *   朝向，使文本恒面向相机——旋转视角时省名 / 岛礁名始终可读（不被自身朝向遮挡）。省会光点为球体
 *   （各向同性，无需 Billboard）。
 *
 * 地形遮挡淡化（SPEC §3.7「当某标签被地形遮挡时降低其透明度，避免视觉穿透的违和感」、§7.5、TASK-017）：
 * - Billboard 朝向（恒面向相机）与地形遮挡（前方山体挡住视线）是两个独立概念：前者由 Billboard 解决，
 *   后者由本层的遮挡判定 + 透明度调制解决。二者正交——本层**不**关闭深度测试（约束明令禁止），标签
 *   仍由 GPU 深度测试与地形正确遮挡；遮挡判定只在此基础上为「被前方地形挡住视线的标签」降低 fillOpacity，
 *   使其以淡化（而非突兀整块消失）的方式呈现可信的遮挡关系。
 * - 判定委托领域层纯函数 computeLabelVisibility（src/lib/label-occlusion）：射线方向「标签→相机」，在高度
 *   场上均匀采样，距离比较「地形世界 y 高出射线 y 超过余量 → 遮挡」。命中点比标签更近相机即 occluded。
 * - 透明度只由遮挡状态驱动（visible → 完全可见、occluded → 降低、indeterminate → 保持当前），不改变
 *   地点数据、锚点或相机；状态恢复无残留（TASK-017 可验证结果）。
 *
 * 降频 / 无分配 / 生命周期（TASK-017 可验证结果「不会造成逐帧抖动或分配压力」「字体加载未完成、地形
 *   不可用或标签已卸载时有明确生命周期处理」、实现约束「降频必须由统一帧循环驱动，不建立新的计时器/
 *   Clock」「不为每次检查重复创建大对象」）：
 * - 降频：单一 useFrame（R3F 统一帧循环）内用帧计数器对 checkFrameInterval 取模——每 N 帧判定一次。
 *   无 setInterval / setTimeout / new THREE.Clock()，无随机抽样。
 * - 无分配：目标 / 当前透明度数组在挂载期一次性分配、长度对齐标签数，运行循环只读写元素、不重建数组、
 *   不 new 对象；computeLabelVisibility 本身也无分配（见该模块）。
 * - 生命周期：terrainQuery 为 null（字体未就绪 / 地形未就绪 / 已卸载）时 useFrame 直接 return——不发射线、
 *   不调制透明度，标签保持 troika 默认完全可见。各标签 troika 实例由 R3F ref 回调在挂载时登记、卸载时
 *   置 null；卸载后 useFrame 不再被调用（组件已卸载），无僵尸更新。
 *
 * 字体离线加载（SPEC §3.7、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载」、验证方式 3
 *   「无在线字体请求」）：
 * - troika <Text> 的 font prop 取自 PLACE_LABELS_CONFIG.fontPath（本地 /fonts/ 路径，非 https:// CDN），运行时
 *   只从同源取字体。字体覆盖校验在场景层（ChinaMapScreen）渲染本组件之前完成（缺字即不渲染标签 + 错误
 *   状态），本组件只在「覆盖校验通过」后挂载，故 font prop 指向的字体已保证覆盖所有将渲染的字符。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-016 实现约束「本 TASK 不宣称取得审图号」）：
 * - 本组件只呈现省名 / 省会光点 / 岛礁名称文本与光点，不添加审图号角标、不通过任何视觉手段宣称已审图。
 */

import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PLACE_LABELS_CONFIG } from '../config/place-labels'
import { LABEL_OCCLUSION_CONFIG } from '../config/label-occlusion'
import { computeLabelVisibility } from '../lib/label-occlusion'
import type { TerrainWorldYSampler } from '../lib/label-occlusion'
import type {
  PreparedCapitalPoint,
  PreparedPlaceLabels,
} from '../lib/place-labels'

/**
 * troika Text 实例上被遮挡层操纵的最小形状。
 *
 * troika 的 fillOpacity 是普通实例属性（不在 SYNCABLE_PROPS 内，赋值无副作用）；其 onBeforeRender →
 * _prepareForRender 每帧把 fillOpacity 读入 uTroikaFillOpacity uniform，故在 useFrame 中赋值后下一帧
 * 渲染即生效。drei <Text> 的 ref 指向该 troika 实例（ForwardRefComponent，ref 类型 any），本层以最小
 * 形状约束之，避免引入对 troika 内部的强类型耦合。
 */
interface TroikaTextLike {
  fillOpacity: number
}

/**
 * 单个参与遮挡判定的文本标签的渲染描述（省名 + 岛礁名统一结构）。
 *
 * 把 TASK-016 的两类 Billboard 文本标签（省名 / 岛礁名）统一成同一结构，使遮挡层可用单一数组、单一
 * useFrame 循环管理它们的 ref / 目标透明度 / 当前透明度（对齐下标），避免两套并行结构。省会光点不参与
 * 遮挡（球体各向同性 + depthTest 已与地形正确遮挡，无 Billboard 文本的遮挡淡化需求）。
 */
interface OcclusionTextLabel {
  readonly key: string
  readonly text: string
  readonly position: readonly [number, number, number]
  readonly fontSizeMeters: number
  readonly colorHex: string
}

/** PlaceLabels 的 props：只接收领域层准备好的标签 / 光点 + 可选的地形采样器，不取数、不持有交互状态。 */
export interface PlaceLabelsProps {
  /** 领域层 preparePlaceLabels 的产物（省名标签 + 省会光点 + 岛礁名称标签，已贴地 + 浮高）。 */
  readonly labels: PreparedPlaceLabels
  /**
   * 地形世界 y 采样器（标签遮挡判定用），由场景层从共享 ElevationProvider + 夸张系数 k 构造。
   * null / undefined 表示地形不可用（字体未就绪 / 地形未就绪 / 已卸载）——此时遮挡层不发射线、标签
   * 保持 troika 默认完全可见（TASK-017 生命周期处理）。
   */
  readonly terrainQuery?: TerrainWorldYSampler | null
}

/**
 * 单个省会光点（球体 + additive 发光，贴地，位置真实）。
 *
 * 球体放在领域层准备的贴地世界坐标（y = h·k + epsilon）。MeshBasicMaterial 不参与光照（恒亮暖色）、
 * AdditiveBlending 呈发光。depthTest 保持开启使光点被前方山体正确遮挡；depthWrite=false 不影响其他透明层。
 * 省会光点不参与遮挡淡化（球体各向同性，depthTest 已与地形正确遮挡，无 Billboard 文本的遮挡需求）。
 */
function CapitalPoint({ point }: { readonly point: PreparedCapitalPoint }): ReactNode {
  return (
    <mesh position={[point.position[0], point.position[1], point.position[2]]} renderOrder={3}>
      <sphereGeometry args={[PLACE_LABELS_CONFIG.capitalPointRadiusMeters, 8, 8]} />
      <meshBasicMaterial
        color={PLACE_LABELS_CONFIG.capitalPointColorHex}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * 渲染全部省名 / 省会光点 / 岛礁名称标注（Billboard Text + 发光光点，始终面向相机），并对省名 / 岛礁名
 * 标签按地形遮挡判定调制透明度（TASK-017）。
 *
 * 本组件不承担投影 / 高程 / 浮高计算（领域层职责），不读取地点 / 政治 / heightmap / hover 状态——它只是
 * PreparedPlaceLabels 的纯渲染边界 + 一个由统一帧循环驱动的遮挡淡化控制器。回退本 TASK（TASK-017）仅
 * 移除遮挡判定与透明度反馈：把 terrainQuery 置 null 即恢复 TASK-016 的默认完全可见状态，标签朝向与地点
 * 位置无回归（TASK-017 回退边界）。
 */
export function PlaceLabels({ labels, terrainQuery }: PlaceLabelsProps): ReactNode {
  // 合并省名 + 岛礁名为统一的「遮挡文本标签」列表（省会光点不参与遮挡，单独渲染）。
  // text 原样透传领域层 shortName / 岛礁规范名（本组件不复制中文名表）；颜色 / 字号取自唯一配置源。
  const textLabels = useMemo<OcclusionTextLabel[]>(() => {
    const list: OcclusionTextLabel[] = []
    for (const label of labels.provinceLabels) {
      list.push({
        key: `province-name-${label.adminId}`,
        text: label.text,
        position: label.position,
        fontSizeMeters: PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters,
        colorHex: PLACE_LABELS_CONFIG.provinceLabelColorHex,
      })
    }
    for (const label of labels.islandLabels) {
      list.push({
        key: `island-name-${label.name}`,
        text: label.name,
        position: label.position,
        fontSizeMeters: PLACE_LABELS_CONFIG.islandLabelFontSizeMeters,
        colorHex: PLACE_LABELS_CONFIG.islandLabelColorHex,
      })
    }
    return list
  }, [labels])

  // 各文本标签的 troika 实例引用（下标与 textLabels 对齐；挂载 / 卸载由 R3F ref 回调自动维护）。
  const textRefs = useRef<(TroikaTextLike | null)[]>([])
  // 各标签的目标透明度（遮挡判定结果；indeterminate 时保持上一次目标，不抖动）。
  const targetOpacities = useRef<number[]>([])
  // 各标签当前透明度（指数阻尼的当前值；初始 = 可见）。
  const currentOpacities = useRef<number[]>([])
  // 帧计数（降频用）：由 R3F 统一帧循环递增，无独立计时器 / Clock。
  const frameCounter = useRef(0)

  // 标签数变化时同步数组长度（k 切换 / 资产重载导致 labels 变化时）；挂载期一次性分配，运行循环只
  // 读写元素、不重建数组（无分配约束）。新槽位初始化为可见目标（terrainQuery 未就绪时即保持可见）。
  const labelCount = textLabels.length
  if (targetOpacities.current.length !== labelCount) {
    targetOpacities.current = new Array<number>(labelCount).fill(LABEL_OCCLUSION_CONFIG.visibleOpacity)
    currentOpacities.current = new Array<number>(labelCount).fill(LABEL_OCCLUSION_CONFIG.visibleOpacity)
  }

  useFrame((state, delta) => {
    const sampler = terrainQuery ?? null
    // 生命周期守护：字体 / 地形未就绪或标签已卸载时，terrainQuery 为 null（场景层于 heightmap 就绪后才
    // 注入、于卸载时随组件一同释放）。此时不发射线、不调制透明度，标签保持 troika 默认完全可见——
    // 既不产生错误射线，也不在不可用期伪造遮挡淡化。
    if (sampler === null) return

    // 降频：由统一帧循环驱动的确定性帧间隔（帧计数器对 checkFrameInterval 取模），非计时器 / 非随机
    // 抽样。每 N 帧判定一次遮挡；未判定帧仍逐帧阻尼透明度（过渡平滑）。
    frameCounter.current += 1
    const shouldCheck = frameCounter.current >= LABEL_OCCLUSION_CONFIG.checkFrameInterval
    if (shouldCheck) {
      frameCounter.current = 0
    }

    const camPos = state.camera.position
    const cfg = LABEL_OCCLUSION_CONFIG
    // dt 钳到 [0, 0.1]：标签页失焦复归时 useFrame 可能给出超大 delta，钳制避免阻尼一步跨过目标。
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0
    const refs = textRefs.current
    const targets = targetOpacities.current
    const currents = currentOpacities.current

    for (let i = 0; i < labelCount; i++) {
      const handle = refs[i]
      if (handle === null || handle === undefined) {
        // 该标签的 troika 实例尚未挂载（troika 异步字体同步中）或已卸载——跳过，不产生错误射线 / 僵尸更新。
        continue
      }
      const desc = textLabels[i]
      if (shouldCheck) {
        // 遮挡判定（委托领域层纯函数）：射线方向「标签→相机」，距离比较「地形世界 y 高出射线 y 超过余量
        // → 命中点比标签更近相机 → occluded」，否则 visible；退化 / 全失败 → indeterminate。
        const visibility = computeLabelVisibility(
          {
            label: { x: desc.position[0], y: desc.position[1], z: desc.position[2] },
            camera: { x: camPos.x, y: camPos.y, z: camPos.z },
            sampler,
          },
          {
            maxSamples: cfg.maxSamples,
            nearMarginMeters: cfg.nearMarginMeters,
            farMarginMeters: cfg.farMarginMeters,
            verticalClearanceMeters: cfg.verticalClearanceMeters,
          },
        )
        // 仅在确定结论（visible / occluded）时更新目标；indeterminate 保持上一次目标（不抖动）。
        // 状态恢复无残留：遮挡消失（visible）即把目标拉回完全可见，阻尼逐帧恢复。
        if (visibility === 'occluded') {
          targets[i] = cfg.occludedOpacity
        } else if (visibility === 'visible') {
          targets[i] = cfg.visibleOpacity
        }
      }
      // 每帧指数阻尼当前透明度 → 目标（THREE.MathUtils.damp = lerp(current, target, 1 − exp(−λ·dt))）。
      // 过渡帧率无关（dt 来自统一时钟）、状态确定可恢复。阻尼结果赋给 troika fillOpacity，其
      // onBeforeRender 下一帧读入 uniform 即生效（深度测试保持开启，标签不永久穿透地形）。
      const target = targets[i]
      const next = THREE.MathUtils.damp(currents[i], target, cfg.dampLambda, dt)
      currents[i] = next
      handle.fillOpacity = next
    }
  })

  return (
    <group>
      {textLabels.map((desc, i) => (
        <Billboard key={desc.key} position={[desc.position[0], desc.position[1], desc.position[2]]}>
          {/*
            ref 回调按 textLabels 下标登记 troika 实例；卸载时 R3F 以 null 回调清空对应槽位（生命周期自动）。
            fillOpacity 不作为 prop 传入——由上方 useFrame 从第 1 帧起接管（troika 默认 fillOpacity=1.0
            覆盖首帧，与可见目标一致，故接管无可见跳变）。font 取本地子集路径（场景层已校验覆盖）。
          */}
          <Text
            ref={(el: TroikaTextLike | null) => {
              textRefs.current[i] = el
            }}
            font={PLACE_LABELS_CONFIG.fontPath}
            fontSize={desc.fontSizeMeters}
            color={desc.colorHex}
            anchorX="center"
            anchorY="middle"
          >
            {desc.text}
          </Text>
        </Billboard>
      ))}
      {labels.capitalPoints.map((point) => (
        <CapitalPoint key={`capital-point-${point.adminId}`} point={point} />
      ))}
    </group>
  )
}
