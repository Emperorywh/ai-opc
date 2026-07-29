/**
 * 分层设色 ramp 纹理构造（渲染层，TASK-006）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层（src/three），把配置层（src/config/elevation-color-ramp）派生的 256×1 ramp
 *   RGB 字节序列构造成可供片元着色器采样的 GPU DataTexture。只依赖 three.js（DataTexture）与
 *   色阶配置类型；不依赖 React / R3F，可在 Node 测试环境直接实例化并断言纹理参数。
 * - 色阶事实源（断点 / 基线色 / 插值策略 / 256 纹素量化）全部在 elevation-color-ramp；本模块只做
 *   「字节序列 → GPU 纹理」的格式适配，不复制任何颜色常量。
 *
 * 为什么是 RGBA 而非 RGB（three r185 / WebGL2 约束）：
 * - three r185 的 WebGLTextures.getInternalFormat 没有为「RGBFormat + UnsignedByteType」选择 WebGL2
 *   sized internal format（仅有 RGB_INTEGER 分支），会以 unsized GL_RGB（0x1907）调用 texStorage2D，
 *   被 WebGL2 拒绝（GL_INVALID_ENUM）——纹理不完整，片元采样恒黑，地形等效隐形。
 * - RGBAFormat + UnsignedByteType 映射到 RGBA8（WebGL2 完全支持），是 8 位颜色查找表的标准形态。
 *   故本模块把 256×3 的 RGB 字节展开为 256×4 的 RGBA（alpha 恒 255）再上传——这只是 GPU 上传格式
 *   适配，色阶语义（RGB 三通道）与 CPU 事实源逐字节一致。
 */

import * as THREE from 'three'
import type { ElevationColorConfig } from '../config/elevation-color-ramp'

/**
 * 把 256×3 的 ramp RGB 字节序列展开为 256×4 的 RGBA 字节序列（alpha 恒 255）。
 *
 * 导出供测试在 Node 环境内省展开形状（长度 = width·4、alpha 通道恒 255、RGB 通道与源逐字节一致）。
 */
export function rampRgbToRgbaBytes(rampRgbData: Uint8Array, rampWidth: number): Uint8Array {
  if (!Number.isInteger(rampWidth) || rampWidth <= 0) {
    throw new RangeError(`ramp 宽度必须为正整数，实际为 ${rampWidth}。`)
  }
  if (rampRgbData.length !== rampWidth * 3) {
    throw new RangeError(
      `ramp RGB 字节长度 ${rampRgbData.length} 与期望 ${rampWidth * 3}（width·3）不符。`,
    )
  }
  const out = new Uint8Array(rampWidth * 4)
  for (let i = 0; i < rampWidth; i++) {
    out[i * 4] = rampRgbData[i * 3]
    out[i * 4 + 1] = rampRgbData[i * 3 + 1]
    out[i * 4 + 2] = rampRgbData[i * 3 + 2]
    out[i * 4 + 3] = 255
  }
  return out
}

/**
 * 由已解析的色阶配置构造 256×1 ramp GPU 纹理（纯同步，便于测试注入配置）。
 *
 * 纹理参数：
 * - 格式 RGBAFormat + UnsignedByteType：映射到 WebGL2 RGBA8 sized internal format（见文件头，
 *   RGBFormat 在 three r185 下不可用）。
 * - magFilter / minFilter 均为 LinearFilter：断点间平滑过渡（与 CPU 采样器的分段线性策略一致，
 *   差异仅在 256 纹素的亚纹素量化）。
 * - wrapS/T ClampToEdge：低于 minH / 高于 maxH 的归一化坐标收敛到端点纹素（深海近黑 / 雪白），
 *   与 sampleElevationColor 的夹断语义一致。
 * - generateMipmaps=false：ramp 是 256×1 查找表，不需 mipmap；needsUpdate=true 触发上传。
 */
export function buildElevationRampTexture(colorConfig: ElevationColorConfig): THREE.DataTexture {
  const data = rampRgbToRgbaBytes(colorConfig.rampRgbData, colorConfig.rampWidth)
  const texture = new THREE.DataTexture(data, colorConfig.rampWidth, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
