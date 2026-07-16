import { useEffect, useRef, type ElementRef } from 'react'
import { Bloom, EffectComposer, SMAA } from '@react-three/postprocessing'
import { BLOOM_THEME, COMPOSER_MULTISAMPLING } from '../../config/visualTheme'

/**
 * 唯一后处理管线：Bloom → SMAA（SPEC §8.1 PostEffects、§8.5、§3，TASK-014）。
 *
 * 职责：在场景渲染后接入唯一一条后处理链——先 Bloom（亮度阈值触发辉光），再 SMAA（边缘
 * 抗锯齿），不叠加 Canvas MSAA、Composer multisampling、FXAA、TAA 或任何替代实现
 * （SPEC §8.5、§3 "不启用重复的 MSAA 管线"，TASK-014 实现约束）。
 *
 * 为什么用 @react-three/postprocessing 组件并自持释放：
 * - SPEC §3、§14.2 固定依赖 @react-three/postprocessing 的 EffectComposer / Bloom / SMAA，
 *   不保留 three examples、自研或其他后处理分支（TASK-014 输入）。本组件直接消费这三个组件。
 * - @react-three/postprocessing 的 <EffectComposer> 在卸载时只 removePass、不 dispose composer
 *   及其内部 RenderTarget/pass/effect 资源（库已知限制，与 TASK-013 drei <MeshReflectorMaterial>
 *   的释放缺口同源）。SPEC §5.4 要求"正常卸载时必须显式释放……RenderTarget"，§11.3 要求卸载后
 *   GPU 资源回到基线、StrictMode 重复挂载不得泄漏。故本组件经 forwardRef 拿到 composer 实例，
 *   在卸载 effect 中显式 composer.dispose()，释放 composer 全链：RenderPass、EffectPass（含
 *   Bloom/SMAA 的内部 RenderTarget、材质与 SMAA 查找纹理）、input/output buffer、copyPass、
 *   timer 与共享全屏几何（SPEC §5.4、TASK-014 输出"覆盖卸载释放的自动化验证"）。
 *
 * 不变量：
 * - 链路顺序唯一固定：Bloom 在前、SMAA 在后（SPEC §8.5、§8.1 PostEffects）。Bloom 的辉光叠加
 *   发生在线性 HDR 空间，SMAA 在最终边缘上做抗锯齿；调换顺序会使 SMAA 边缘检测吃掉辉光。
 * - 单一抗锯齿：Composer multisampling = COMPOSER_MULTISAMPLING(0)，Canvas 原生 antialias 关闭
 *   （见 MapSceneView），抗锯齿唯一由 SMAA 承担（SPEC §8.5、TASK-014 实现约束）。
 * - 阈值驱动 Bloom：Bloom 只由亮度阈值触发，不按对象创建第二套材质、选择性渲染分支或运行时开关
 *   （TASK-014 实现约束）。Bloom 参数全部来自 BLOOM_THEME，组件内不散落阈值（§8.2 末条、§8.5）。
 * - 确定性释放：composer 在卸载 effect 中 dispose 一次；StrictMode 重复挂载下每次 setup 得到全新
 *   composer（useMemo 重算）、其 cleanup 释放当次 composer，不累积（SPEC §5.4、§11.3）。
 *
 * 色彩管线协作（SPEC §8.5，TASK-014）：
 * - renderer 的 outputColorSpace/toneMapping/exposure 由 MapSceneView 经 COLOR_PIPELINE 唯一写入。
 * - <EffectComposer> 渲染期临时把 renderer.toneMapping 置 NoToneMapping，使材质输出线性 HDR，
 *   Bloom 亮度阈值（1.0）据此触发；卸载时恢复 ACES。该机制不属于"重复 tone mapping"——着色器的
 *   tonemapping_fragment/colorspace_fragment 是 renderer 色调映射在材质侧的标准出口（Composer
 *   渲染期随 NoToneMapping 变为恒等），本链不新增 ToneMappingEffect，故全管线只存在一处色调映射
 *   职责（renderer 配置），不重复（TASK-014 输出"唯一色彩管线"）。
 *
 * 该组件位于展示层、不渲染可见场景对象，只接管渲染循环（EffectComposer 内部 useFrame 以
 * renderPriority 1 接管）。不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/**
 * 挂载唯一后处理链 Bloom → SMAA。
 *
 * composer 经 forwardRef 暴露（@react-three/postprocessing EffectComposer 的 useImperativeHandle），
 * 在卸载 effect 中显式 dispose。effect 依赖数组为空：composer 引用在挂载后（commit 之后、useEffect
 * 之前由 useImperativeHandle 写入 ref）一次性捕获，卸载时用该捕获值释放，避免 React 卸载阶段
 * ref 被置空导致漏释放。
 */
export function PostEffects() {
  // @react-three/postprocessing 的 <EffectComposer> 经 forwardRef 暴露 postprocessing EffectComposer 实例。
  // 经 ElementRef 推导其 ref 类型，避免直接依赖 postprocessing 子包的类型声明（postprocessing 为
  // @react-three/postprocessing 的传递依赖，不在本仓库 package.json 中显式声明）。
  type EffectComposerInstance = ElementRef<typeof EffectComposer>
  const composerRef = useRef<EffectComposerInstance>(null)

  // 卸载释放：composer.dispose() 级联释放 RenderPass/EffectPass/Bloom/SMAA 的全部内部资源、
  // input/output buffer、copyPass、timer 与共享全屏几何（SPEC §5.4、TASK-014）。
  // 依赖数组为空：仅挂载时捕获一次 composer 引用，卸载时释放；StrictMode 下成对 setup/cleanup。
  useEffect(() => {
    const composer = composerRef.current
    if (composer === null) return
    return () => {
      composer.dispose()
    }
  }, [])

  return (
    <EffectComposer ref={composerRef} multisampling={COMPOSER_MULTISAMPLING}>
      {/*
        SPEC §8.5、§8.1 PostEffects：链路顺序唯一固定为 Bloom → SMAA。
        Bloom 参数全部取自 BLOOM_THEME（亮度阈值 1.0、平滑 0.2、强度 1.1、mipmap blur），
        组件内不散落阈值（§8.2 末条、§8.5）。
      */}
      <Bloom
        mipmapBlur={BLOOM_THEME.mipmapBlur}
        luminanceThreshold={BLOOM_THEME.luminanceThreshold}
        luminanceSmoothing={BLOOM_THEME.luminanceSmoothing}
        intensity={BLOOM_THEME.intensity}
      />
      {/*
        SMAA 为链路末端的唯一抗锯齿（SPEC §8.5）。查找纹理由 SMAAEffect 从内嵌数据 URL 生成，
        无网络请求（与 §8.3 无远程资源一致）。
      */}
      <SMAA />
    </EffectComposer>
  )
}
