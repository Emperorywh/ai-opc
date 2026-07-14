import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { PATH_VISUAL_THEME } from '../../config/visualTheme'
import type { PathGeometryPacket } from '../../domain/renderPacket'
import { FlowPhaseClock } from './flowClock'
import { buildPathGeometry } from './pathGeometry'
import { createPathMaterial, FLOW_OFFSET_UNIFORM } from './pathShader'

/**
 * 路径图层：合并后的单一扁带 Mesh（SPEC §7.5、§8.1 PathLayer、§8.3，TASK-010）。
 *
 * 不变量：
 * - 单批次单材质：全部 3045 条有向边合并为一个 BufferGeometry，由一个 ShaderMaterial
 *   渲染（§8.3、§11.1 路径 DrawCall 1、路径材质 1）。静态运行期不重建几何或材质。
 * - 只读渲染：顶点数据来自 RenderPacket.pathGeometry（geometry 层预编译），本组件只负责
 *   上传 GPU 与渲染，不解析原始 JSON、不重算扁带（§5.1 展示层边界）。
 * - 每帧单 uniform：useFrame 内只推进流光相位并写入 uFlowOffsetM，不创建临时 Vector、
 *   数组或材质（§7.6、§11.1 每帧业务更新 1 个有界流光 uniform）。
 * - 可见性暂停：页面隐藏时停止推进相位（§11.3）；恢复可见后由 FlowPhaseClock 钳制
 *   超大 delta，动画从暂停处平滑续接，不累计超大时间差。
 * - 无交互：不渲染路径名称、连通性高亮或规划结果（§2.3、TASK-010 验收）。
 * - 确定性释放：几何与材质各构建一次，组件卸载时显式 dispose（§5.4、§11.3）。
 */

export interface PathLayerProps {
  /** 合并后的路径扁带几何包（来自 RenderPacket.pathGeometry）。 */
  readonly geometry: PathGeometryPacket
}

/**
 * 渲染合并路径扁带 Mesh。
 *
 * 几何按数据包一次性构建（useMemo），经 primitive 挂接并关闭 R3F 自动释放，
 * 由 effect 统一 dispose。材质同理创建一次。useFrame 仅在页面可见时推进流光相位，
 * 写入唯一随帧变化的 uniform。
 */
export function PathLayer({ geometry: packet }: PathLayerProps) {
  // 流光相位时钟：渲染间稳定的单例，卸载即随组件销毁。
  const clockRef = useRef<FlowPhaseClock | null>(null)
  if (clockRef.current === null) {
    clockRef.current = new FlowPhaseClock(PATH_VISUAL_THEME.flow)
  }
  // 页面可见性标志：隐藏期间不推进相位（§11.3）。
  const pausedRef = useRef(false)

  const geometry = useMemo(() => buildPathGeometry(packet), [packet])
  const material = useMemo(
    () => createPathMaterial(PATH_VISUAL_THEME.color, PATH_VISUAL_THEME.flow),
    [],
  )

  // 监听页面可见性：隐藏即暂停流光帧循环（§11.3）。恢复时由时钟钳制恢复帧 delta。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const syncPaused = (): void => {
      pausedRef.current = document.hidden
    }
    syncPaused()
    document.addEventListener('visibilitychange', syncPaused)
    return () => {
      document.removeEventListener('visibilitychange', syncPaused)
    }
  }, [])

  // 每帧只更新流光偏移 uniform（§7.6、§11.1）。
  useFrame((_, delta) => {
    if (pausedRef.current) return
    const clock = clockRef.current
    if (clock === null) return
    material.uniforms[FLOW_OFFSET_UNIFORM].value = clock.advance(delta)
  })

  // 几何与材质确定性释放：primitive 关闭 R3F 自动释放，由本 effect 统一 dispose。
  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  return (
    <mesh>
      <primitive object={geometry} attach="geometry" dispose={null} />
      <primitive object={material} attach="material" dispose={null} />
    </mesh>
  )
}
