import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Matrix4 } from 'three'
import type { InstancedMesh } from 'three'
import { DEFAULT_NODE_DIMENSIONS_CONFIG } from '../../config/geometryConfig'
import type { NodeDimensions } from '../../config/geometryConfig'
import { NODE_VISUAL_THEME } from '../../config/visualTheme'
import type { RawNodeType } from '../../domain/rawDto'
import type { CompiledNodeInstances, NodeInstancePacket } from '../../domain/renderPacket'
import { NODE_BATCH_TYPES, assertNodeInstancePacket } from './nodeBatch'
import { buildNodeGeometry } from './nodeGeometry'
import { createNodeMaterial } from './nodeMaterial'

/**
 * 节点图层：四类节点各一个 InstancedMesh（SPEC §7.2、§8.1 NodeLayer）。
 *
 * 不变量：
 * - 固定四批：node/work/charge/park 各一个 InstancedMesh，共 4 个节点 DrawCall（SPEC §7.2、§11.1）。
 *   静态运行期间不因相机距离重新分组、不实现 LOD（TASK-009 验收）。
 * - 只读渲染：实例矩阵来自 RenderPacket（geometry 层预编译），本组件只负责上传到 GPU 与渲染，
 *   不解析原始 JSON、不重算放置（SPEC §5.1 展示层边界）。
 * - 无交互：不渲染名称、图例，不挂悬停或点击处理（SPEC §2.3、TASK-009 验收）。
 * - 确定性释放：几何与材质各构建一次（useMemo），primitive 关闭 R3F 自动释放，由 effect 统一 dispose
 *   （SPEC §5.4、§11.3；释放路径不依赖后续 TASK）。
 * - 数据自洽校验：挂载前校验每类包的 count 与 matrices 长度一致，不一致直接抛错，交由
 *   SceneErrorBoundary → notifySceneCreateFailed 进入统一错误状态，绝不静默跳过坏记录（TASK-009 异常路径）。
 */

/** 每个 4×4 实例矩阵的浮点分量数（与 geometry 层 NODE_MATRIX_FLOATS 对齐）。 */
const MATRIX_FLOATS = 16

export interface NodeLayerProps {
  /** 四类节点实例包（来自 RenderPacket.nodeInstances）。 */
  readonly instances: CompiledNodeInstances
}

/**
 * 渲染四类节点的 InstancedMesh 集合。
 *
 * 每类一个 NodeInstancedMesh 子组件，独立持有几何与材质，互不查询内部对象（SPEC §8.1）。
 * 挂载前先校验全部四类包自洽，任一不一致直接抛错，不分配任何 GPU 资源。
 */
export function NodeLayer({ instances }: NodeLayerProps) {
  // 挂载前校验全部四类包自洽：任一不一致即抛错，交由 Canvas 内 SceneErrorBoundary 捕获，
  // 进入统一错误状态；绝不静默上传越界矩阵或展示半批节点（TASK-009 异常路径）。
  for (const type of NODE_BATCH_TYPES) {
    assertNodeInstancePacket(instances[type], type)
  }

  return (
    <>
      {NODE_BATCH_TYPES.map((type) => (
        <NodeInstancedMesh
          key={type}
          type={type}
          packet={instances[type]}
          dimensions={DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]}
        />
      ))}
    </>
  )
}

interface NodeInstancedMeshProps {
  readonly type: RawNodeType
  readonly packet: NodeInstancePacket
  readonly dimensions: NodeDimensions
}

/**
 * 单类节点的 InstancedMesh。
 *
 * 几何与材质各按类型与主题构建一次（useMemo），经 primitive 挂接、关闭 R3F 自动释放，
 * 由卸载 effect 统一 dispose，避免重复释放或泄漏。材质为 MeshStandardMaterial（SPEC §8.3），
 * 由 createNodeMaterial 从视觉主题构建，颜色、自发光、金属度与粗糙度集中取自主题（§8.2、§12）。
 *
 * 实例矩阵在挂载后用 useLayoutEffect 一次性写入（节点为静态几何，运行期不再更新，SPEC §11.1），
 * 随后计算包围球以修正视锥剔除——InstancedMesh 默认包围球只覆盖几何本地范围，
 * 不计实例位移，若不重算会误剔除散布在大地图上的节点。
 */
function NodeInstancedMesh({ type, packet, dimensions }: NodeInstancedMeshProps) {
  const ref = useRef<InstancedMesh>(null)
  const geometry = useMemo(() => buildNodeGeometry(type, dimensions), [type, dimensions])
  const material = useMemo(() => createNodeMaterial(NODE_VISUAL_THEME[type]), [type])
  const count = packet.count

  useLayoutEffect(() => {
    const mesh = ref.current
    if (mesh === null) return
    const matrix = new Matrix4()
    for (let i = 0; i < count; i += 1) {
      matrix.fromArray(packet.matrices, i * MATRIX_FLOATS)
      mesh.setMatrixAt(i, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    // 重算包围球，使视锥剔除覆盖全部实例的世界位移（SPEC §11.1 静态几何、避免误剔除）。
    mesh.computeBoundingSphere()
  }, [packet, count])

  // 几何与材质确定性释放：primitive 关闭 R3F 自动释放，由本 effect 统一 dispose（SPEC §5.4）。
  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  if (count === 0) return null

  return (
    <instancedMesh
      ref={ref}
      // 构造时给出实例数；几何与材质由 primitive 挂接，避免构造期分配默认资源。
      args={[undefined, undefined, count]}
      castShadow
    >
      <primitive object={geometry} attach="geometry" dispose={null} />
      <primitive object={material} attach="material" dispose={null} />
    </instancedMesh>
  )
}
