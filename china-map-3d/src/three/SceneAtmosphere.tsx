/**
 * 深色地势照明与背景层次装配（渲染层，TASK-012）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把场景视觉配置（src/config/scene-atmosphere 的
 *   SCENE_ATMOSPHERE_CONFIG）装配成 three.js / R3F 的背景色 / 雾 / 半球环境光 / 方向主光」。约束数值
 *   全部来自配置层，本组件不复制任何光向 / 颜色 / 强度常量，也不在组件内维护隐式氛围状态
 *   （TASK-012 实现约束「视觉参数集中管理，场景装配不复制色阶或相机领域逻辑」）。
 * - 本组件依赖：配置层（SCENE_ATMOSPHERE_CONFIG —— 氛围参数唯一源）、R3F（color / fogExp2 / 灯光
 *   JSX 元素）。**不**读取行政区 / 地点 / hover 状态 / 地形资产（TASK-012 实现约束「光照 / 背景层只能
 *   依赖场景视觉配置，不得读取行政区、地点或 hover 状态」）。氛围是纯视觉层，与领域 / 交互解耦。
 *
 * 与地形着色器的分工（单一光向源，两个必要通道）：
 * - 地形是自定义 ShaderMaterial（src/three/terrain-shaders），**不**自动消费 three.js 场景灯（无 lights
 *   绑定、无 fog 着色器 chunk）。因此同一份光向 / 光色 / 环境色 / 雾密度既要驱动本组件渲染的场景灯
 *   （供未来标准材质的海面 / 标签等消费），又要由 ChinaTerrainMesh 把同样的值注入地形着色器 uniform——
 *   二者都只读 SCENE_ATMOSPHERE_CONFIG，配置是唯一源，不存在第二套光向常量。这不是「重复逻辑」，而是
 *   「同一份参数经两个必要通道作用到两类材质」。
 *
 * 阴影关闭（SPEC §3.4、TASK-012 实现约束「地形不投递高分辨率阴影贴图」）：
 * - 主光 castShadow 显式取配置中的 MAIN_LIGHT_CAST_SHADOW（结构性 false）；渲染器阴影图总开关由
 *   ChinaMapScreen 的 `<Canvas shadows={SCENE_SHADOWS_ENABLED}>` 控制（也在此配置中为 false）。本组件
 *   不开启任何 shadow map——地势方向感由方向光 Lambert + 半球环境光体现（详见 terrain-shaders.ts）。
 */

import type { ReactNode } from 'react'
import { SCENE_ATMOSPHERE_CONFIG } from '../config/scene-atmosphere'

/**
 * 装配深色背景 / 可选轻雾 / 半球环境光 / 单盏方向主光。
 *
 * 无 props：氛围参数全部来自冻结的 SCENE_ATMOSPHERE_CONFIG（单一事实源），不接收任何运行时状态——
 * 这使氛围层「只依赖场景视觉配置」，与行政区 / 地点 / hover / 入场状态正交（后续入场 TASK 改的是相机
 * 交互启停与升起 uniform，不影响氛围装配）。
 */
export function SceneAtmosphere(): ReactNode {
  const { backgroundHex, mainLight, hemisphereAmbient, fog } = SCENE_ATMOSPHERE_CONFIG

  return (
    <>
      {/*
        深蓝黑纯色背景（SPEC §3.4「纯色或竖向渐变深蓝黑，不引入天空盒贴图」）。用 <color attach="background">
        设置 scene.background：纯色、零纹理、零外部请求（TASK-012 验证方式 2「不引入外部纹理请求」）。
        深蓝黑与地表色阶近黑端足够接近又不重合，受光地形浮于背景、背光面可辨认（不靠天空盒 / 卫星影像）。
      */}
      <color attach="background" args={[backgroundHex]} />

      {/*
        极轻微指数雾（SPEC §3.4「可选极轻微指数雾，柔化地图远缘与背景的衔接」）。雾色 = 背景色，远缘地形
        片元淡入背景形成无接缝过渡（TASK-012 验证方式 4「背景衔接自然」）。密度极低（远角雾因子 ~9%），
        南海诸岛 / 边界 / 标签完全可读（实现约束「若启用雾则南海和远缘地形仍可读」）。FOG_ENABLED=false
        时不渲染——此时远缘衔接由背景色 + 构图承担（二者已在背景色上对齐）。
        注：scene.fog 只自动作用于标准材质；地形是自定义 ShaderMaterial，由其片元手动复算同一 FogExp2
        公式（terrain-shaders.ts），密度取自同一配置，二者永不漂移。
      */}
      {fog.enabled && <fogExp2 attach="fog" args={[fog.hex, fog.density]} />}

      {/*
        低强度半球环境光（SPEC §3.4「低强度半球光（天 / 地双色），保证背光面不死黑」）。color=天色、
        groundColor=地色，three.js 按法线 +Y 在天 / 地色间插值——朝上表面偏冷蓝、朝下表面偏暖，背光面
        保留环境补光可辨认。强度 < 1（低强度），不冲淡分层设色（实现约束「不以过强环境光冲淡高程色阶」）。
        这是「环境光存在」不变量的承载者（TASK-012 验证方式 1）。
      */}
      <hemisphereLight
        color={hemisphereAmbient.skyHex}
        groundColor={hemisphereAmbient.groundHex}
        intensity={hemisphereAmbient.intensity}
      />

      {/*
        单盏方向主光（SPEC §3.4「单盏主光，从西北偏高方位照射」、TASK-012 验证方式 1「单主光」）。
        position = 主光方向（surface-to-light = 西北偏高），three.js DirectionalLight 从 position 照向
        target（默认原点 = 地图中心），故光线沿「西北→东南」下行，强调青藏—东海地势梯度。光色冷白、
        强度取配置。castShadow 显式 false（MAIN_LIGHT_CAST_SHADOW 结构性 false）——地势明暗由方向光
        Lambert + 半球环境光体现，不投递地形阴影贴图（4096² 阴影图成本过高，SPEC §3.4、TASK-012 实现
        约束）。这是「主光方向 / 单主光 / 地形阴影关闭」不变量的承载者。
      */}
      <directionalLight
        position={[mainLight.direction.x, mainLight.direction.y, mainLight.direction.z]}
        color={mainLight.hex}
        intensity={mainLight.intensity}
        castShadow={mainLight.castShadow}
      />
    </>
  )
}
