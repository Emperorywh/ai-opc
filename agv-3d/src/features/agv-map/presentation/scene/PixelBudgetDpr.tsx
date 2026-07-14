import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { computeEffectiveDpr } from '../../config/performanceConfig'

/**
 * 像素预算 DPR 管理器（SPEC §9.3、§11.1，TASK-011）。
 *
 * 职责：把主画布的有效设备像素比钳制到 3840×2160 物理像素预算内，并在容器 resize 时重算，
 * 避免操作系统缩放或高 DPI 使 4K 目标画布膨胀到 6K/8K（SPEC §11.1）。
 *
 * 实现：R3F 的 Canvas dpr prop 仅接受数字或 [min,max]，无法直接表达像素预算公式，故由本组件
 * 在 Canvas 内部用 useThree 读取容器 CSS 尺寸（size）与 setDpr，在挂载与每次 resize 后写入
 * 由 computeEffectiveDpr 计算的有效 DPR。该组件不渲染可见对象，仅作为副作用挂载点。
 *
 * 不变量：
 * - resize 只更新 DPR 与渲染尺寸，不重新下载、解析或编译地图（§9.3）；本组件不触及几何或数据包。
 * - 极端窄屏或异常尺寸不产生 NaN：computeEffectiveDpr 对非有限或非正输入回退 DPR_FLOOR（§9.3）。
 * - 卸载即停：useEffect 清理随组件卸载自动停止，无全局监听遗留；R3F 内部 resize 观察者由
 *   Canvas 生命周期管理，本组件只消费其派发的 size 快照。
 */

/** 浏览器设备像素比的 SSR 安全读取：window 不存在时视作 1（不放大）。 */
function readDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1
  const ratio = window.devicePixelRatio
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

/**
 * 挂载像素预算 DPR 管理：随容器 size 变化重算并写入有效 DPR。
 *
 * 不渲染任何可见内容，返回 null。
 */
export function PixelBudgetDpr() {
  const setDpr = useThree((state) => state.setDpr)
  const size = useThree((state) => state.size)

  useEffect(() => {
    setDpr(computeEffectiveDpr(readDevicePixelRatio(), size.width, size.height))
  }, [size.width, size.height, setDpr])

  return null
}
