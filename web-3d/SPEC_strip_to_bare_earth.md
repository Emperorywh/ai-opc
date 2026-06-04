# SPEC: 精简至原始地球

> **目标**：移除所有粒子效果、大气层光晕、星空背景、后处理管线、加载秀场、手势识别，将场景精简为一个仅使用 PBR 光照 + 白天纹理的基础地球球体，保留鼠标交互控制与地球自转动画。

---

## 1. 决策摘要

| 项目 | 决策 |
|------|------|
| 大气层光晕（Atmosphere） | **删除** |
| 后处理（Bloom/Vignette/Noise） | **全部删除** |
| 星空背景（StarField） | **删除**，Canvas 保持纯黑 |
| 地球 Shader | **替换**为 `MeshStandardMaterial` + 单张白天纹理 |
| 加载秀场（LoadingSequence） | **彻底移除**（含 loadingSlice 状态机） |
| 纹理贴图 | **仅白天贴图**（earth-blue-marble.jpg） |
| 相机控制 | **仅鼠标交互**（拖拽旋转 + 滚轮缩放） |
| 地球自转 | **保留**，沿用现有 `useSceneState` 驱动 |
| 地球倾斜角 | **保留** 23.4° |
| 手势控制（MediaPipe） | **删除** |
| 空闲公转（IdleOrbit） | **删除** |
| 无用文件 | **删除**，不留注释占位 |
| 状态管理 | **保留** Zustand/Redux 框架，仅删除不再使用的 slice |
| Canvas 透明度 | **不透明**（`alpha: false`），背景纯黑 |
| 未来扩展 | **不再添加特效**，无需预留扩展点 |

---

## 2. 需要删除的文件

以下文件将在实现中从磁盘删除：

### 2.1 粒子系统
- `src/components/particles/ParticleField.tsx` — 轨道粒子 + 漂浮尘埃
- `src/components/particles/PulsePoints.tsx` — 地表脉冲点
- `src/components/particles/shaders/particles.vert`
- `src/components/particles/shaders/particles.frag`
- `src/components/particles/shaders/dust.vert`
- `src/components/particles/shaders/dust.frag`
- `src/components/particles/shaders/pulse.vert`
- `src/components/particles/shaders/pulse.frag`

### 2.2 星空背景
- `src/components/stars/StarField.tsx`
- `src/components/stars/shaders/stars.vert`
- `src/components/stars/shaders/stars.frag`

### 2.3 大气层光晕
- `src/components/earth/Atmosphere.tsx`
- `src/components/earth/shaders/atmosphere.vert`
- `src/components/earth/shaders/atmosphere.frag`

### 2.4 地球自定义 Shader（被 MeshStandardMaterial 替代）
- `src/components/earth/shaders/earth.vert`
- `src/components/earth/shaders/earth.frag`

### 2.5 加载秀场
- `src/components/loading/LoadingSequence.tsx`
- `src/components/loading/shaders/loading.vert`
- `src/components/loading/shaders/loading.frag`

### 2.6 后处理
- `src/components/postprocessing/PostProcessing.tsx`

### 2.7 手势相关
- `src/hooks/useHandGesture.ts`
- `src/hooks/useGestureCursor.ts`
- `src/hooks/useSmoothing.ts`
- `src/components/camera/GestureCursor.tsx`

### 2.8 输入优先级 / 空闲公转（手势模式删除后不再需要）
- `src/hooks/useInputPriority.ts`
- `src/components/camera/IdleOrbit.tsx`

### 2.9 状态管理
- `src/stores/loadingSlice.ts` — 加载阶段状态机（彻底移除）
- `src/stores/inputSlice.ts` — 输入模式状态（手势/空闲已删，仅鼠标模式无意义）

### 2.10 空目录清理
删除上述文件后，检查并删除以下空目录：
- `src/components/particles/` （含 `shaders/`）
- `src/components/stars/` （含 `shaders/`）
- `src/components/loading/` （含 `shaders/`）
- `src/components/postprocessing/`
- `src/components/earth/shaders/` （所有 shader 文件已删除）

---

## 3. 需要修改的文件

### 3.1 `src/App.tsx`

**变更**：
- 移除 `HandGestureTracker` 组件及其 import
- 移除 `useHandGesture` import
- Canvas 配置基本保持不变（`alpha: false`、`antialias: true`）
- 移除 `onCreated` 中的 `ACESFilmicToneMapping` 设置（无后处理，tone mapping 不再必要）

**简化后结构**：
```tsx
export default function App() {
  return (
    <Canvas
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      camera={{ fov: 45, near: 0.1, far: 1000, position: [0, 0, 3.5] }}
      style={{ width: '100%', height: '100%' }}
    >
      <Scene />
    </Canvas>
  )
}
```

### 3.2 `src/components/Scene.tsx`

**变更**：大幅简化。移除所有条件渲染逻辑（加载阶段控制），只保留：
1. `<EarthLoader />` — 地球（含 Suspense）
2. `<CameraController />` — 鼠标相机控制
3. 场景灯光（新增，因为 MeshStandardMaterial 需要光源）

**简化后结构**：
```tsx
export default function Scene() {
  return (
    <>
      {/* 灯光：MeshStandardMaterial 需要 */}
      <ambientLight intensity={0.1} />
      <directionalLight position={[5, 1.5, 2.5]} intensity={1.5} />

      {/* 地球 */}
      <EarthLoader />

      {/* 相机控制（仅鼠标） */}
      <CameraController />
    </>
  )
}
```

**说明**：
- `ambientLight` 极弱（0.1），仅提供背光面微弱可见度
- `directionalLight` 位置对应原 Shader 中的 `SUN_DIRECTION`（右前方偏上），模拟太阳光
- 无需阶段判断，组件直接挂载

### 3.3 `src/components/earth/Earth.tsx`

**重大重写**：从自定义 ShaderMaterial 替换为 MeshStandardMaterial。

**删除**：
- 所有 GLSL shader import
- `useTexture` 加载夜景纹理（仅保留白天纹理）
- 所有自定义 uniforms（`uDayMap`、`uNightMap`、`uSunDirection`、`uTextureReveal`、`uTime`）
- 纹理显现过渡动画逻辑（`revealStartRef`、`revealDoneRef`）
- `<Atmosphere />` 子组件
- `setLoadingPhase` dispatch

**保留/简化**：
- `useSceneState` hook — 驱动地球自转
- `EARTH_RADIUS`、`EARTH_SEGMENTS`、`EARTH_TILT` 常量
- 地球倾斜 `<group rotation={[0, 0, EARTH_TILT]}>`
- 纹理来源保持不变（`earth-blue-marble.jpg` from unpkg CDN）

**简化后结构**：
```tsx
export function Earth() {
  const meshRef = useRef<THREE.Mesh>(null)
  const sceneState = useSceneState()
  const dayMap = useTexture(TEXTURE_DAY_MAP)

  // 纹理配置
  useMemo(() => {
    dayMap.colorSpace = THREE.SRGBColorSpace
    dayMap.minFilter = THREE.LinearMipmapLinearFilter
    dayMap.magFilter = THREE.LinearFilter
    dayMap.anisotropy = 4
  }, [dayMap])

  // 地球自转
  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y = sceneState.current.earthRotation
    }
  })

  return (
    <group rotation={[0, 0, EARTH_TILT]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_RADIUS, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
        <meshStandardMaterial
          map={dayMap}
          roughness={0.8}
          metalness={0.1}
        />
      </mesh>
    </group>
  )
}
```

**材质参数说明**：
- `roughness: 0.8` — 地球表面粗糙（海洋和陆地都不光滑如镜），配合 DirectionalLight 产生自然漫反射
- `metalness: 0.1` — 地球非金属材质，极低金属度

### 3.4 `src/components/earth/EarthLoader.tsx`

**简化**：
- 移除 `setTexturesLoaded` dispatch（loadingSlice 将被删除）
- 保留 `<Suspense>` 边界以确保纹理异步加载正常工作

```tsx
import { Suspense } from 'react'
import { Earth } from './Earth'

export function EarthLoader() {
  return (
    <Suspense fallback={null}>
      <Earth />
    </Suspense>
  )
}
```

### 3.5 `src/components/camera/CameraController.tsx`

**大幅简化**：删除所有手势相关代码。

**删除**：
- 手势帧循环（`useFrame` 中 `input.handDetected` 分支）
- `useSmoothing` hook 及其 import
- 手势状态 ref（`prevSmoothed`、`gestureVelocity`、`wasHandDetected`）
- 手势常量（`GESTURE_ROTATION_SENSITIVITY`、`GESTURE_PINCH_SENSITIVITY` 等）
- `GESTURE_DAMPING_FACTOR` import
- `store` / `recordInput` 相关 import 和调用（inputSlice 将被删除）

**保留**：
- 鼠标拖拽旋转（`pointerdown` / `pointermove` / `pointerup`）
- 滚轮缩放（`wheel`）
- 惯性滑动 + 阻尼衰减
- `useCameraState` hook

**注意**：`recordInput()` 调用原本用于空闲模式检测（3秒无输入 → idle）。删除 inputSlice 后，鼠标事件中不再需要 `store.dispatch(recordInput())`。惯性系统自身的阻尼衰减（在 `useCameraState` 中）仍然工作，不受影响。

### 3.6 `src/stores/store.ts`

**简化**：
```tsx
import { configureStore } from '@reduxjs/toolkit'

export const store = configureStore({
  reducer: {
    // loading 和 input slice 已删除
    // 保留空 store 以维持架构一致性
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
```

**备选方案**：如果空 store 看起来多余，可以彻底移除 Redux 依赖。但用户选择「保留框架」，因此保留空 store 配置。

### 3.7 `src/utils/constants.ts`

**精简**：删除不再使用的常量，保留地球和相机相关常量。

**保留**：
```ts
// 地球参数
export const EARTH_RADIUS = 1.0
export const EARTH_SEGMENTS = 64
export const EARTH_TILT = 23.5 * (Math.PI / 180)
export const EARTH_ROTATION_SPEED = 0.02

// 相机参数
export const CAMERA_INITIAL_DISTANCE = 3.5
export const CAMERA_FOV = 45
export const CAMERA_ZOOM_MIN = 2.0
export const CAMERA_ZOOM_MAX = 8.0
export const CAMERA_NEAR = 0.1
export const CAMERA_FAR = 1000
```

**删除**：所有颜色常量、Fresnel 参数、粒子规模、星空参数、后处理参数、加载秀场参数、手势平滑参数、空闲超时。

### 3.8 `src/stores/useSceneState.ts`

**保留不变**。地球自转仍通过此模块级单例驱动。

### 3.9 `src/stores/hooks.ts`

检查是否仍引用已删除的 slice selector。如有则清理。

---

## 4. 需要新增的内容

### 4.1 场景灯光

在 `Scene.tsx` 中新增两个 Three.js 灯光（见 §3.2）。这是从自定义 Shader（自处理光照）迁移到 MeshStandardMaterial（依赖 Three.js 灯光系统）的必要变更。

### 4.2 Canvas 背景色

当前 Canvas 配置 `alpha: false`，WebGL 默认 clearColor 为 `(0, 0, 0, 1)` 即纯黑。无需额外设置。如果需要显式指定（防御性编程）：

```tsx
onCreated={({ gl }) => {
  gl.setClearColor(0x000000, 1)
}}
```

---

## 5. 依赖清理

以下 npm 包在精简后不再被直接使用，但可能作为 peer dependency 仍被其他包间接依赖：

| 包 | 当前用途 | 精简后状态 |
|----|---------|-----------|
| `@react-three/postprocessing` | Bloom/Vignette/Noise | **可卸载** |
| `postprocessing` | 上述包的底层依赖 | **可卸载** |
| `@mediapipe/tasks-vision` | 手势识别（WASM + 类型） | **可卸载** |

**建议**：在代码变更完成后，运行 `pnpm remove @react-three/postprocessing postprocessing @mediapipe/tasks-vision` 清理依赖。但先确认没有其他组件引用这些包。

---

## 6. 不受影响的文件

以下文件**不修改**：
- `src/main.tsx` — 入口文件，不变
- `src/vite-env.d.ts` — 类型声明，不变
- `src/stores/useCameraState.ts` — 相机状态管理，CameraController 仍然使用
- `src/stores/useSceneState.ts` — 地球自转状态，Earth 组件仍然使用
- 所有 `package.json` / `vite.config.*` / `tsconfig.*` — 不变（依赖清理见 §5）

---

## 7. 实现顺序

建议按以下顺序实施，确保每步可编译可验证：

1. **修改 `Earth.tsx`** — 替换为 MeshStandardMaterial + 单纹理（核心变更）
2. **修改 `EarthLoader.tsx`** — 移除 loadingSlice 依赖
3. **修改 `Scene.tsx`** — 精简组件树 + 添加灯光
4. **修改 `CameraController.tsx`** — 删除手势代码
5. **修改 `App.tsx`** — 移除 HandGestureTracker
6. **修改 `store.ts`** — 移除 loading/input slice
7. **精简 `constants.ts`** — 删除无用常量
8. **删除无用文件** — 按本规格 §2 列表逐个删除
9. **清理 npm 依赖** — 卸载不再需要的包（§5）
10. **验证** — 运行项目，确认地球正常显示，鼠标交互正常

---

## 8. 风险与注意事项

### 8.1 纹理加载体验
移除加载秀场后，纹理从 CDN 下载期间地球不会显示（Suspense fallback=null → 黑屏）。首次加载时 CDN 响应约 1-3 秒。如果黑屏不可接受，可考虑：
- 添加简单的 CSS loading spinner 在 Suspense fallback 中
- 将纹理打包为本地资源（增大 bundle 但消除网络延迟）

### 8.2 MeshStandardMaterial vs 自定义 Shader 的视觉差异
从自定义 GLSL 切换到 MeshStandardMaterial 后：
- **失去**：Fresnel 边缘冰蓝光、day/night 纹理混合、大气散射、晨昏线过渡
- **获得**：PBR 物理正确的光照反射、更简洁的代码、更易维护
- 地球视觉将从「科幻风格」变为「写实地球」

### 8.3 删除 inputSlice 后的 CameraController
`CameraController` 原本通过 `recordInput()` 跟踪用户输入以支持空闲模式检测。删除 inputSlice 后：
- 鼠标拖拽、滚轮缩放、惯性衰减仍正常工作（这些逻辑在 CameraController 和 useCameraState 内部）
- 只是不再有「3秒无操作 → 自动公转」的行为

### 8.4 store 为空的架构考虑
Redux store 精简后可能变为空 reducer。如果后续完全不需要 Redux：
- 可考虑将 `useSceneState` 和 `useCameraState` 这两个模块级单例作为唯一的状态管理方案
- 但当前保留 store 框架以维持架构一致性

---

## 9. 最终预期效果

- **视觉**：纯黑背景上，一个带 PBR 光照的白天地球缓慢自转，23.4° 倾斜，无任何粒子/光晕/后处理装饰
- **交互**：鼠标拖拽旋转地球，滚轮缩放，释放后惯性滑动
- **代码**：从 ~20 个源文件精简至 ~8 个活跃文件，无 GLSL shader，无多阶段加载状态机
