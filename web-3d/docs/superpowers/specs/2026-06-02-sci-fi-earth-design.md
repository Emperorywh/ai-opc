# Sci-Fi Earth MVP — 设计规格说明

> 日期：2026-06-02
> 状态：已批准
> 项目定位：浏览器里的科幻电影 UI / 视觉艺术作品

---

## 1. 项目概述

一个可通过手势操控的科幻 3D 地球。打开网页即看到漂浮在宇宙中的未来地球，用户可通过鼠标或摄像头手势旋转、缩放地球。整体体验像操控未来 AI 系统。

**核心目标：** 截图传播力——用户第一反应必须是"这是浏览器？"

**不是：** GIS 系统、数据平台、商业产品。

---

## 2. 关键决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 目标设备 | 仅桌面（独立显卡） | 可放开效果上限，不做移动端妥协 |
| 地球纹理 | 混合方案（真实卫星图 + 程序化增强） | 真实感 + 动态效果兼得 |
| 手势反馈 | 隐形摄像头 + 3D 光标映射 | 沉浸感强，手部动作有视觉反馈 |
| 主色调 | 冰蓝 / 青色 (`#4DB8FF` ~ `#00E5FF`) | 经典科幻 HUD 感，发光效果突出 |
| 输入模式 | 鼠标 + 手势并存，手势自动优先 | 无感切换，不要求手动操作 |
| 空闲相机 | 智能切换（空闲自动公转，操作时手动） | 空闲时截图角度好看，操作时完全可控 |
| 加载体验 | 加载即秀场（粒子聚合成地球） | 加载过程本身就是视觉展示 |
| 音效 | 不做 | 纯视觉 MVP，后期可扩展 |
| 飞线 | 不做 | 简化范围，聚焦核心 |
| HUD | 不做，纯 3D 场景 | 沉浸感优先，避免 2D overlay 破坏空间感 |
| 粒子规模 | 中等密度（5000-10000） | 有"场"的感觉，中端桌面 GPU 无压力 |
| 手势平滑 | 极致平滑（强低通滤波），允许 ~150ms 延迟 | 电影感优先，牺牲响应速度换平滑度 |
| 手势启动 | 页面加载后自动请求摄像头 | 最无感体验 |
| 图形 API | WebGL 2 | 成熟稳定，Shader 用 GLSL 300 es 即可，MVP 阶段无需 WebGPU 复杂度 |
| 后处理 | 中等电影感（Bloom + Vignette + Noise） | Bloom 明显但不吃细节 |
| 扫描线 | 不做 | 与纯 3D 沉浸方向矛盾 |
| 星空 | 程序化 Shader（带闪烁和流动） | 性能好，更像真实宇宙 |
| 架构方案 | 自定义 Shader + R3F 骨架 | 视觉天花板高 + 结构清晰；逐帧状态用 useRef/useFrame 管理，Redux 仅负责低频 UI 状态 |

---

## 3. 技术栈

| 技术 | 用途 |
|---|---|
| React 19 | UI 框架 |
| TypeScript | 类型安全 |
| Three.js 0.184+ | 3D 引擎核心 |
| React Three Fiber 9+ | React 绑定（组件结构和生命周期管理） |
| @react-three/drei | 仅用工具函数（useTexture、shaderMaterial），不依赖其组件 |
| @reduxjs/toolkit + react-redux | 状态管理（仅低频 UI 状态：输入模式、加载进度） |
| @mediapipe/hands | 手势识别 |
| postprocessing | 后处理效果（Bloom、Vignette、Noise） |
| GLSL | 所有自定义 Shader |

---

## 4. 架构设计

### 4.1 文件结构

```
src/
├── main.tsx                         # 入口
├── App.tsx                          # R3F Canvas + 全局 Provider
├── components/
│   ├── Scene.tsx                    # 场景编排器（组合所有子组件）
│   ├── earth/
│   │   ├── Earth.tsx                # 地球主体（球体 + ShaderMaterial）
│   │   ├── Atmosphere.tsx           # 大气层 Glow
│   │   ├── shaders/
│   │   │   ├── earth.vert           # 地球顶点着色器
│   │   │   ├── earth.frag           # 地球片段着色器
│   │   │   ├── atmosphere.vert      # 大气层顶点着色器
│   │   │   └── atmosphere.frag      # 大气层片段着色器
│   │   └── EarthLoader.tsx          # 纹理加载器（卫星图、夜景图）
│   ├── particles/
│   │   ├── ParticleField.tsx        # 粒子系统主组件（轨道粒子 + 漂浮尘埃）
│   │   ├── shaders/
│   │   │   ├── particles.vert
│   │   │   └── particles.frag
│   │   └── PulsePoints.tsx          # 地表脉冲闪烁点
│   ├── stars/
│   │   ├── StarField.tsx            # 程序化星空
│   │   └── shaders/
│   │       ├── stars.vert
│   │       └── stars.frag
│   ├── camera/
│   │   ├── CameraController.tsx     # 相机控制（鼠标 + 手势 + 空闲运镜）
│   │   └── IdleOrbit.tsx            # 空闲自动公转逻辑
│   ├── loading/
│   │   ├── LoadingSequence.tsx      # 加载秀场（粒子聚合动画）
│   │   └── shaders/
│   │       ├── loading.vert
│   │       └── loading.frag
│   └── postprocessing/
│       └── PostProcessing.tsx       # Bloom + Vignette + Noise
├── hooks/
│   ├── useHandGesture.ts            # MediaPipe 手势识别封装
│   ├── useSmoothing.ts              # 低通滤波平滑器
│   ├── useGestureCursor.ts          # 手势光标视觉效果
│   └── useInputPriority.ts          # 鼠标 / 手势优先级切换
├── stores/
│   ├── useCameraState.ts            # 逐帧相机状态（useRef + useFrame，不触发 re-render）
│   ├── useSceneState.ts             # 逐帧场景状态——地球自转等（useRef + useFrame）
│   ├── inputSlice.ts                # Redux Toolkit 输入模式状态 slice
│   ├── loadingSlice.ts              # Redux Toolkit 加载状态 slice
│   └── store.ts                     # Redux Toolkit store 配置（仅注册 input + loading）
├── utils/
│   ├── math.ts                      # 数学工具（插值、向量运算）
│   └── constants.ts                 # 常量（颜色、物理参数）
└── assets/
    └── textures/                    # 卫星图纹理文件
```

### 4.2 数据流

```
MediaPipe Camera → useHandGesture → useSmoothing → useInputPriority
                                                       ↓
Mouse Events ──────────────────────────────────→ useInputPriority
                                                       ↓
                                                 CameraController
                                                       ↓
                                                 Camera State (useRef)  ←── 不触发 re-render
                                                       ↓
                                                 useFrame → Three.js camera
```

### 4.3 渲染管线

```
每帧：
1. 输入系统更新（手势 / 鼠标 → 相机状态）
2. 场景图更新（地球自转、粒子运动、脉冲点更新）
3. 主渲染通道（地球 + 大气层 + 粒子 + 星空）
4. 后处理通道（Bloom → Vignette → Noise）
5. 输出到屏幕
```

---

## 5. 地球系统

### 5.1 纹理方案

| 层 | 来源 | 分辨率 | 用途 |
|---|---|---|---|
| Day map | NASA Blue Marble | 4096×2048 | 白天地表 |
| Night map | NASA Black Marble | 4096×2048 | 夜晚城市灯光 |
| 程序化叠加 | GLSL Shader | — | 大气散射、边缘高光、动态效果 |

纹理来源：NASA 公共域影像，无需授权。

### 5.2 地球 Shader

核心逻辑：

```glsl
void main() {
  // 双纹理日夜混合
  vec3 dayColor   = texture(dayMap, vUv);
  vec3 nightColor = texture(nightMap, vUv);

  // 日夜过渡：基于法线和光照方向
  float sunDot = dot(vNormal, uSunDirection);
  float dayFactor = smoothstep(-0.1, 0.3, sunDot);

  // 夜景增强发光
  vec3 surface = mix(nightColor * 3.0, dayColor, dayFactor);

  // Fresnel 边缘发光（冰蓝色）
  float fresnel = pow(1.0 - dot(vViewDir, vNormal), 3.0);
  surface += vec3(0.3, 0.7, 1.0) * fresnel * 0.6;

  // 程序化大气散射
  surface += atmosphereScattering(vNormal, vViewDir, uSunDirection);

  gl_FragColor = vec4(surface, 1.0);
}
```

### 5.3 大气层

- 一个略大于地球的半透明球体（半径 1.05× 地球半径）
- 纯 Fresnel Shader：边缘厚且明亮（冰蓝发光），正面完全透明
- 双面渲染（`side: THREE.DoubleSide`）
- 背面渲染创造"内发光"效果，正面渲染创造"外光晕"

### 5.4 地球参数

| 参数 | 值 |
|---|---|
| 球体半径 | 1.0（Three.js 单位） |
| 细分度 | 64×64 段 |
| 自转速度 | 0.02 rad/s |
| 轴倾斜 | 23.5°（真实倾角） |
| 相机初始距离 | 3.5 |
| 相机 FOV | 45° |
| 缩放范围 | 2.0（近） ~ 8.0（远） |

---

## 6. 粒子系统

### 6.1 轨道粒子（Orbital Particles）

| 参数 | 值 |
|---|---|
| 数量 | ~3000 |
| 行为 | 沿不同倾角的椭圆轨道围绕地球公转 |
| 视觉 | 发光小点，冰蓝色到白色渐变，大小随机（1-3px） |
| 渲染 | GPU `THREE.Points` + 自定义 Shader，单次 draw call |

每个粒子存储：初始角度、轨道倾角、轨道半径、公转速度、大小、亮度。

### 6.2 漂浮尘埃（Ambient Dust）

| 参数 | 值 |
|---|---|
| 数量 | ~3000 |
| 行为 | 布朗运动，缓慢漂浮在地球周围 |
| 视觉 | 极小极淡的点，透明度很低 |
| 作用 | 增加空间感和深度感 |

### 6.3 地表脉冲点（Surface Pulses）

| 参数 | 值 |
|---|---|
| 数量 | ~200 个同时存在 |
| 行为 | 地球表面随机位置周期性闪烁：亮起 → 衰减 → 消失 |
| 视觉 | 冰蓝色光点，有径向扩散 |
| 周期 | 每 0.5-2 秒产生新脉冲 |
| 实现 | `BufferAttribute` 动态更新位置和亮度 |

### 6.4 粒子 Shader

```glsl
// 片段着色器核心
float dist = length(gl_PointCoord - vec2(0.5));
float glow = exp(-dist * dist * 8.0);  // 高斯发光
vec3 color = mix(vec3(0.3, 0.7, 1.0), vec3(1.0), vBrightness);
float alpha = glow * vAlpha;
```

### 6.5 性能策略

- 所有粒子使用 `THREE.Points`（非独立 Mesh），总计 2-3 次 draw call
- 轨道粒子位置计算在 vertex shader 中完成（GPU 端）
- 漂浮尘埃使用 simplex noise 驱动（GPU 端）
- 脉冲点使用 `BufferAttribute.setUsage(THREE.DynamicDrawUsage)` 优化更新

---

## 7. 相机控制系统

### 7.1 三种模式

| 模式 | 触发条件 | 行为 |
|---|---|---|
| 鼠标模式 | 默认状态 | 拖拽 → 地球旋转，滚轮 → 缩放，带阻尼和惯性 |
| 手势模式 | 检测到手部 landmark | 手掌拖拽 → 旋转，捏合 → 缩放，强平滑滤波 |
| 空闲模式 | 3 秒无任何输入 | 相机缓慢自动公转 |

### 7.2 模式切换状态机

```
[鼠标模式] ──检测到手──→ [手势模式]
[手势模式] ──手离开帧──→ [鼠标模式]
[任意模式] ──3秒无输入──→ [空闲模式]
[空闲模式] ──任何输入──→ [最后活跃的模式]
```

切换时相机状态（位置、朝向、速度）平滑过渡，不产生跳变。

### 7.3 手势到旋转的映射

| 手势 | 映射 |
|---|---|
| 手掌 X 移动 | 地球 Y 轴旋转（水平拖 → 地球左右转） |
| 手掌 Y 移动 | 地球 X 轴旋转（上下拖 → 地球上下转） |
| 双指捏合距离变化 | 相机距离（缩放） |

### 7.4 平滑策略：双阶段滤波

**阶段 1 — 原始数据平滑（强）：**
- 对 MediaPipe 输出的 21 个手部 landmark 做低通滤波
- 截止频率 ~2Hz
- 消除追踪抖动

**阶段 2 — 运动平滑（中等）：**
- 平滑后的手势数据映射为旋转速度
- 再做一层阻尼平滑（`dampingFactor: 0.05`）
- 实现"慢单感"

**结果：** 地球旋转丝般顺滑，代价 ~150ms 延迟。对电影感体验可接受。

### 7.5 手势光标

检测到手时在 3D 场景中渲染：
- 从手掌中心投射半透明光线到地球表面
- 光标落点处产生冰蓝色涟漪效果
- 手离开时光标淡出（~0.3s 过渡）

---

## 8. 手势识别系统

### 8.1 MediaPipe Hands 配置

```typescript
const handsConfig = {
  maxNumHands: 1,           // 单手追踪
  modelComplexity: 1,       // 平衡精度和性能
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.5,
};
```

### 8.2 启动流程

1. 页面加载完成后自动请求摄像头权限
2. 获批后初始化 MediaPipe Hands
3. 开始后台帧处理（每帧分析，不阻塞渲染）
4. 检测到手部时自动激活手势模式
5. 用户拒绝权限或无摄像头：静默降级为纯鼠标模式，无任何错误提示

### 8.3 useHandGesture Hook

```typescript
interface HandGestureState {
  isDetected: boolean;          // 是否检测到手
  palmCenter: [number, number]; // 手掌中心归一化坐标 [0,1]
  pinchDistance: number;        // 捏合距离归一化值 [0,1]
  landmarks: Vector3[];         // 21 个关键点
}
```

---

## 9. 后处理管线

使用 `postprocessing` 库（非 drei EffectComposer），效果链：

```
场景渲染 → Bloom → Vignette → Noise → 输出
```

| 效果 | 参数 | 作用 |
|---|---|---|
| **Bloom** | intensity: 1.2, luminanceThreshold: 0.6, luminanceSmoothing: 0.3, mipmapBlur: true | 发光元素（Fresnel glow、粒子）产生光晕扩散；地球表面不受影响 |
| **Vignette** | darkness: 0.4, offset: 0.5 | 边缘变暗，视觉焦点集中在地球 |
| **Noise** | opacity: 0.02 | 极轻微噪点，模拟胶片质感 |

---

## 10. 程序化星空

### 10.1 实现方式

一个远大于地球的球面（或平面），用 fragment shader 程序化生成星空：

```glsl
// 伪随机哈希
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 星星生成
float star = hash(floor(uv * starDensity));
star = step(threshold, star);              // 稀疏化
star *= twinkle(sin(time * speed + offset)); // 闪烁
```

### 10.2 参数

| 参数 | 值 |
|---|---|
| 星星数量 | ~2000 颗 |
| 大小 | 随机（0.5-2px） |
| 亮度 | 随机，独立闪烁频率和相位 |
| 视差 | 相机移动时星空轻微偏移，增加深度感 |

---

## 11. 加载秀场

### 11.1 三阶段加载动画

| 阶段 | 时长 | 动画 | 触发条件 |
|---|---|---|---|
| 粒子聚合 | 0-3s | 粒子从屏幕四周飞向中心，逐渐形成球体轮廓 | 页面加载即开始 |
| 纹理显现 | 3-5s | 球体表面纹理从模糊渐变到清晰 | 纹理加载完成时触发 |
| 系统激活 | 5-6s | 大气层光晕亮起，后处理淡入，粒子进入轨道 | 所有资源就绪 |

### 11.2 加载资源清单

| 资源 | 预估大小 | 加载方式 |
|---|---|---|
| Three.js + R3F | ~500KB (gzip) | 打包在 bundle 中 |
| Day map 纹理 | ~5MB | 按需加载，渐进式 |
| Night map 纹理 | ~5MB | 按需加载，渐进式 |
| MediaPipe Hands WASM | ~5MB | 异步延迟加载（优先级低于纹理） |

总加载量约 15MB。首次加载后浏览器缓存可大幅减少后续访问时间。

---

## 12. 渲染器配置

### 12.1 WebGL 2 渲染器

```typescript
import { WebGLRenderer } from 'three';

const renderer = new WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
```

### 12.2 Shader 语言

- 所有自定义 Shader 使用 GLSL 300 es 编写
- 纹理采样使用 `texture()`（GLSL 300 es 语法，非 WebGL 1 的 `texture2D()`）
- 所有 Shader 在 WebGL 2 上下文中运行，无需维护双后端版本

---

## 13. 状态管理

### 13.1 设计原则：响应式 vs 可变

本项目的状态分为两类，用不同机制管理：

| 状态类型 | 管理机制 | 特点 | 适用数据 |
|---|---|---|---|
| **响应式状态** | Redux Toolkit | 变更时通过 useSelector 触发 React 组件 re-render | 输入模式、加载阶段等低频 UI 状态（切换频率 ≤ 几次/秒） |
| **可变状态** | `useRef` + `useFrame` | 永远不触发 re-render，在 R3F 帧循环中直接读写 ref.current | 相机位置/速度、地球自转角度等逐帧数据（60 次/秒） |

**跨系统通信**：在 `useFrame` 中需要读取 Redux 状态时，使用 `store.getState()` 直接读取，不使用 `useSelector`（避免 re-render）。

### 13.2 响应式状态（Redux Toolkit）

仅管理低频 UI 状态：

```typescript
// ---- store.ts ----
import { configureStore } from '@reduxjs/toolkit';
import inputReducer from './inputSlice';
import loadingReducer from './loadingSlice';

export const store = configureStore({
  reducer: {
    input: inputReducer,
    loading: loadingReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// ---- hooks.ts ----
import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from './store';

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

// ---- inputSlice.ts ----
type InputMode = 'mouse' | 'gesture' | 'idle';

interface InputState {
  mode: InputMode;
  lastInputTime: number;
  handDetected: boolean;
  palmPosition: [number, number] | null;
  pinchDistance: number | null;
}

// ---- loadingSlice.ts ----
type LoadingPhase = 'particles' | 'texture' | 'activate' | 'done';

interface LoadingState {
  phase: LoadingPhase;
  texturesLoaded: boolean;
  mediapipeReady: boolean;
}
```

### 13.3 可变状态（useRef + useFrame）

逐帧更新的数据，完全绕过 React 渲染循环：

```typescript
// ---- stores/useCameraState.ts ----
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface CameraMutableState {
  distance: number;
  theta: number;
  phi: number;
  velocity: { theta: number; phi: number; zoom: number };
}

const INITIAL_CAMERA: CameraMutableState = {
  distance: 3.5,
  theta: 0,
  phi: Math.PI / 2,
  velocity: { theta: 0, phi: 0, zoom: 0 },
};

/**
 * 逐帧相机状态 hook。
 * 返回的 ref 在 useFrame 中直接读写，永不触发 React re-render。
 */
export function useCameraState() {
  const state = useRef<CameraMutableState>({ ...INITIAL_CAMERA });

  useFrame(({ camera }, delta) => {
    const s = state.current;
    // 应用速度
    s.theta += s.velocity.theta * delta;
    s.phi += s.velocity.phi * delta;
    s.distance += s.velocity.zoom * delta;
    // 阻尼衰减
    s.velocity.theta *= 0.95;
    s.velocity.phi *= 0.95;
    s.velocity.zoom *= 0.95;
    // 范围约束
    s.phi = THREE.MathUtils.clamp(s.phi, 0.1, Math.PI - 0.1);
    s.distance = THREE.MathUtils.clamp(s.distance, 2.0, 8.0);
    // 写入 Three.js camera
    camera.position.set(
      s.distance * Math.sin(s.phi) * Math.cos(s.theta),
      s.distance * Math.cos(s.phi),
      s.distance * Math.sin(s.phi) * Math.sin(s.theta),
    );
    camera.lookAt(0, 0, 0);
  });

  return state;
}
```

```typescript
// ---- stores/useSceneState.ts ----
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

/**
 * 逐帧场景状态 hook（地球自转等）。
 * 同样用 ref 管理，不触发 re-render。
 */
export function useSceneState() {
  const state = useRef({
    earthRotation: 0,
    earthRotationSpeed: 0.02, // rad/s
  });

  useFrame((_, delta) => {
    state.current.earthRotation += state.current.earthRotationSpeed * delta;
  });

  return state;
}
```

---

## 14. 性能预算

| 指标 | 目标 |
|---|---|
| FPS | 稳定 60fps（桌面独立显卡） |
| Draw calls | < 15 |
| 三角形数 | < 500K |
| GPU 内存 | < 512MB（含纹理） |
| JS 主线程 | 每帧 < 8ms（留 8ms 给浏览器）。逐帧状态通过 useRef 直接操作，不经过 Redux dispatch |
| MediaPipe 处理 | 在 Worker 中运行，不阻塞渲染 |

---

## 15. 不做的事（MVP 范围排除）

- 后端、WebSocket、实时数据
- 登录系统、数据库
- GIS 功能
- 数据飞线
- HUD overlay
- 音效
- 扫描线效果
- 移动端适配
- 真实数据分析
- 商业逻辑

所有"数据"均为假数据，本质只是视觉特效。

---

## 16. 开发阶段

> 每个阶段设计为一次 LLM 上下文窗口内可完美完成的粒度。
> 原则：产出可验证、文件范围小（2~6 个）、概念内聚、依赖清晰。

### 阶段 1：项目骨架 + 空场景 ✅ 已完成（2026-06-02）

**做什么：** Vite 项目初始化、依赖安装、R3F Canvas 挂载、WebGL2 渲染器配置、基础文件结构

**产出文件：** `main.tsx`、`App.tsx`、`Scene.tsx`、`store.ts`、`constants.ts`、`package.json`、`vite.config.ts`

**验证：** `pnpm dev` 启动后看到一个黑色背景的空白 3D 场景

### 阶段 2：地球球体 + 纹理加载 ✅ 已完成（2026-06-02）

**做什么：** 地球几何体、卫星纹理加载系统（day map + night map）、占位 shader（先只显示白天纹理）

**产出文件：** `Earth.tsx`、`EarthLoader.tsx`、`earth.vert`、`earth.frag`、纹理资源

**验证：** 场景中看到一个贴了白天卫星图的球体，可以确认纹理加载成功

### 阶段 3：日夜混合 Shader ✅ 已完成（2026-06-02）

**做什么：** 完整的 day/night blending——基于光照方向的日夜过渡、夜景灯光增强

**产出文件：** `earth.frag`（重写）、`earth.vert`（完善）、`Earth.tsx`（添加 uSunDirection uniform）

**验证：** 地球同时呈现白天和夜晚面，过渡带自然，夜晚面有城市灯光

### 阶段 4：大气层光晕 ✅ 已完成（2026-06-02）

**做什么：** 大气层组件 + Fresnel shader——边缘冰蓝发光、正面透明、双面渲染

**产出文件：** `Atmosphere.tsx`、`atmosphere.vert`、`atmosphere.frag`

**验证：** 地球边缘有柔和的冰蓝色光晕，正面（中心）透明

### 阶段 5：程序化星空 ✅ 已完成（2026-06-02）

**做什么：** 星空组件 + 程序化 shader——伪随机星星、独立闪烁频率、相机视差

**产出文件：** `StarField.tsx`、`stars.vert`、`stars.frag`

**验证：** 背景出现闪烁的星空，移动相机时有轻微视差效果

### 阶段 6：鼠标相机控制 + 地球自转 ✅ 已完成（2026-06-02）

**做什么：** 球坐标系相机状态管理（useRef）、鼠标拖拽旋转、滚轮缩放、地球自转

**产出文件：** `CameraController.tsx`、`useCameraState.ts`、`useSceneState.ts`

**验证：** 鼠标拖拽可旋转地球，滚轮可缩放，地球持续缓慢自转

### 阶段 7：Bloom 后处理 ✅ 已完成（2026-06-02）

**做什么：** postprocessing 库集成、Bloom 效果配置（让发光元素产生光晕扩散）

**产出文件：** `PostProcessing.tsx`

**验证：** 大气层光晕有明显的发光扩散效果，地球表面不受影响

### 阶段 8：轨道粒子系统

**做什么：** ~3000 轨道粒子，不同倾角椭圆轨道，GPU vertex shader 计算位置，高斯发光片段着色器

**产出文件：** `ParticleField.tsx`（轨道部分）、`particles.vert`、`particles.frag`

**验证：** 看到冰蓝色发光粒子沿不同轨道围绕地球公转

### 阶段 9：漂浮尘埃 + 地表脉冲点

**做什么：** ~3000 漂浮尘埃（布朗运动 / simplex noise）+ ~200 地表脉冲闪烁点（BufferAttribute 动态更新）

**产出文件：** `ParticleField.tsx`（补全尘埃部分）、`PulsePoints.tsx`

**验证：** 地球周围有细小的尘埃浮动增加深度感，地表随机位置出现冰蓝色脉冲闪烁

### 阶段 10：Vignette + Noise 后处理

**做什么：** 在后处理链中添加 Vignette（边缘变暗）和 Noise（胶片噪点）

**产出文件：** `PostProcessing.tsx`（扩展）

**验证：** 画面边缘自然变暗，焦点集中在地球；极轻微胶片质感

### 阶段 11：空闲自动公转 + 惯性阻尼

**做什么：** 空闲检测（3 秒无输入 → 自动公转）、操作时的惯性和阻尼系统

**产出文件：** `IdleOrbit.tsx`、`CameraController.tsx`（扩展）、`inputSlice.ts`

**验证：** 停止操作 3 秒后相机自动缓慢公转；拖拽松手后地球惯性滑动并逐渐停下

### 阶段 12：MediaPipe 手势集成

**做什么：** MediaPipe Hands 初始化、摄像头权限管理、手部 landmark 检测、静默降级

**产出文件：** `useHandGesture.ts`

**验证：** 打开摄像头后，控制台输出手掌中心坐标和捏合距离；无摄像头时不报错

### 阶段 13：手势平滑 + 旋转映射

**做什么：** 双阶段低通滤波（原始数据平滑 + 运动阻尼）、手掌移动 → 地球旋转映射、捏合 → 缩放

**产出文件：** `useSmoothing.ts`、`CameraController.tsx`（扩展手势模式）

**验证：** 用手势拖动可旋转地球，动作丝滑但有约 150ms 的慢单感；捏合可缩放

### 阶段 14：输入优先级 + 手势光标

**做什么：** 鼠标/手势/空闲三模式自动切换、手势 3D 光标（手掌投射光线 + 落点涟漪）

**产出文件：** `useInputPriority.ts`、`useGestureCursor.ts`

**验证：** 检测到手时自动切手势模式，手离开切回鼠标；3D 场景中显示手势光标

### 阶段 15：加载状态管理 + 粒子聚合动画

**做什么：** loadingSlice Redux 状态、加载秀场第一阶段——粒子从四周飞向中心形成球体

**产出文件：** `loadingSlice.ts`、`LoadingSequence.tsx`、`loading.vert`、`loading.frag`

**验证：** 页面加载后看到粒子从四周飞向中心聚合为球体的动画

### 阶段 16：纹理显现 + 系统激活

**做什么：** 加载秀场第二/三阶段——纹理从模糊到清晰、大气层光晕亮起、后处理淡入

**产出文件：** `LoadingSequence.tsx`（扩展）、`Earth.tsx`（过渡动画）

**验证：** 粒子聚合完成后纹理逐渐清晰，然后大气层和后处理效果渐入

### 阶段 17：性能优化 + 视觉打磨

**做什么：** 性能审计（draw calls、FPS、内存）、视觉微调、多角度截图验证传播力

**产出文件：** 各文件的优化补丁

**验证：** 稳定 60fps，draw calls < 15，各角度截图看起来像科幻电影 UI
