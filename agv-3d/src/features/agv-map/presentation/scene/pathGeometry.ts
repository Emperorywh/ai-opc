import { BufferAttribute, BufferGeometry } from 'three'
import type { PathGeometryPacket } from '../../domain/renderPacket'

/**
 * 路径扁带几何构建（SPEC §7.5、§8.3，TASK-010）。
 *
 * 职责：把 geometry 层编译、经 Worker 转移的 PathGeometryPacket 零拷贝挂接为 Three.js
 * BufferGeometry，供 PathLayer 的单一 Mesh 使用。
 *
 * 不变量：
 * - 属性命名对齐着色器（pathShader）：position/normal 为 Three.js 内建，
 *   aPathU/aFlowDirection 为流光自定义 attribute（§7.5）。命名不一致会导致着色器
 *   读不到顶点数据，是 TASK-010 验收（流向、流光）的关键接线点，故单独构建并测试。
 * - 零拷贝：BufferAttribute 直接包裹 packet 的 TypedArray，不复制大缓冲（§5.4 转移后
 *   直接消费）。dispose 仅释放 GPU 缓冲，JS 数组随 packet 生命周期回收。
 * - 索引 32 位：Uint32Array 支撑，兼容大地图顶点数（>65535）。
 * - 包围球重算：合并扁带顶点散布于整个地图，BufferGeometry 默认包围球为空，
 *   不重算会被视锥剔除误判为不可见（§11.1 静态几何、避免误剔除）。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（§5.1）。
 */

/**
 * 由路径几何包构建合并 BufferGeometry。
 *
 * 顶点属性每顶点分量数：position/normal=3，aPathU/aFlowDirection=1；索引每顶点 1 个。
 */
export function buildPathGeometry(packet: PathGeometryPacket): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(packet.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(packet.normals, 3))
  geometry.setAttribute('aPathU', new BufferAttribute(packet.pathU, 1))
  geometry.setAttribute('aFlowDirection', new BufferAttribute(packet.flowDirections, 1))
  geometry.setIndex(new BufferAttribute(packet.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}
