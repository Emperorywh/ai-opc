/**
 * MediaPipe 手势识别 Hook（阶段 12）
 *
 * 设计规格 §8：
 * 1. 页面加载完成后自动请求摄像头权限
 * 2. 获批后初始化 MediaPipe Hands
 * 3. 开始后台帧处理（每帧分析，不阻塞渲染）
 * 4. 检测到手部时更新 Redux 状态（handDetected / palmPosition / pinchDistance）
 * 5. 用户拒绝权限或无摄像头：静默降级为纯鼠标模式，无任何错误提示
 *
 * 手势数据：
 * - 手掌中心：Wrist(0) + Middle MCP(9) 的平均值
 * - 捏合距离：Thumb tip(4) ↔ Index tip(8) 的欧氏距离
 *
 * 实现说明：
 * - 使用 @mediapipe/tasks-vision（当前推荐的 MediaPipe API）
 * - 动态 import 实现代码分割，不影响首屏加载
 * - WASM + 模型文件从 CDN 加载
 * - VIDEO 运行模式，detectForVideo() 同步返回结果
 */
import { useEffect, useRef } from 'react'
import { store } from '../stores/store'
import { setHandDetected, setPalmPosition, setPinchDistance } from '../stores/inputSlice'

// ── 类型 ──────────────────────────────────────────────

export interface HandGestureState {
  /** 是否检测到手 */
  isDetected: boolean
  /** 手掌中心归一化坐标 [0,1] */
  palmCenter: [number, number]
  /** 捏合距离归一化值 */
  pinchDistance: number
  /** 21 个手部关键点 */
  landmarks: { x: number; y: number; z: number }[]
}

// ── MediaPipe 配置（规格 §8.1） ──────────────────────

/** 对应规格 maxNumHands: 1 */
const NUM_HANDS = 1
/** 对应规格 modelComplexity: 1（平衡精度和性能） */
const DELEGATE = 'GPU'
/** 对应规格 minDetectionConfidence: 0.7 */
const MIN_DETECTION_CONFIDENCE = 0.7
/** 对应规格 minTrackingConfidence: 0.5 */
const MIN_TRACKING_CONFIDENCE = 0.5

// ── WASM / 模型 CDN 路径 ────────────────────────────

const WASM_CDN_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'

const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/**
 * MediaPipe 手势识别 Hook
 *
 * 自动初始化摄像头 + MediaPipe HandLandmarker，
 * 每帧分析视频流并更新 Redux 状态。
 *
 * 返回 latestResult ref（供阶段 13 手势平滑使用），
 * 当前阶段验证方式：控制台输出 palmCenter 和 pinchDistance。
 */
export function useHandGesture() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const landmarkerRef = useRef<ReturnType<typeof Object> | null>(null)
  const animFrameRef = useRef<number>(0)
  const latestResult = useRef<HandGestureState | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // §8.2 步骤 5：检查 API 可用性，不可用则静默降级
        if (!navigator.mediaDevices?.getUserMedia) {
          console.log('[HandGesture] 摄像头 API 不可用，静默降级为鼠标模式')
          return
        }

        // §8.2 步骤 1：自动请求摄像头权限
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        })

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        // 创建隐藏 video 元素用于帧捕获
        const video = document.createElement('video')
        video.srcObject = stream
        video.setAttribute('playsinline', '')
        video.muted = true
        await video.play()
        videoRef.current = video

        // §8.2 步骤 2：初始化 MediaPipe（动态 import 实现代码分割）
        const { HandLandmarker, FilesetResolver } = await import(
          '@mediapipe/tasks-vision'
        )

        if (cancelled) return

        const vision = await FilesetResolver.forVisionTasks(WASM_CDN_PATH)

        if (cancelled) return

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: DELEGATE,
          },
          runningMode: 'VIDEO',
          numHands: NUM_HANDS,
          minHandDetectionConfidence: MIN_DETECTION_CONFIDENCE,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
        })

        if (cancelled) {
          handLandmarker.close()
          return
        }

        landmarkerRef.current = handLandmarker
        console.log('[HandGesture] MediaPipe HandLandmarker 初始化完成')

        // §8.2 步骤 3：开始后台帧处理
        let lastTimestamp = -1

        function processFrame() {
          if (cancelled) return

          const video = videoRef.current
          const landmarker = landmarkerRef.current

          if (video && video.readyState >= 2 && landmarker) {
            const now = performance.now()
            // VIDEO 模式要求时间戳单调递增
            if (now > lastTimestamp) {
              lastTimestamp = now
              try {
                const results = (landmarker as any).detectForVideo(video, now)
                handleResults(results)
              } catch {
                // 忽略单帧处理错误，下一帧继续
              }
            }
          }

          animFrameRef.current = requestAnimationFrame(processFrame)
        }

        processFrame()
      } catch {
        // §8.2 步骤 5：静默降级为纯鼠标模式
        console.log('[HandGesture] 摄像头不可用，使用纯鼠标模式')
      }
    }

    /**
     * 处理 MediaPipe 检测结果
     * 提取手掌中心和捏合距离，更新 Redux store
     */
    function handleResults(results: {
      landmarks: { x: number; y: number; z: number }[][]
    }) {
      if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0]

        // 手掌中心：Wrist(0) + Middle MCP(9) 的平均值
        const wrist = landmarks[0]
        const middleMCP = landmarks[9]
        const palmCenterX = (wrist.x + middleMCP.x) / 2
        const palmCenterY = (wrist.y + middleMCP.y) / 2

        // 捏合距离：Thumb tip(4) ↔ Index tip(8) 的欧氏距离
        const thumbTip = landmarks[4]
        const indexTip = landmarks[8]
        const dx = thumbTip.x - indexTip.x
        const dy = thumbTip.y - indexTip.y
        const dz = thumbTip.z - indexTip.z
        const pinchDist = Math.sqrt(dx * dx + dy * dy + dz * dz)

        const state: HandGestureState = {
          isDetected: true,
          palmCenter: [palmCenterX, palmCenterY],
          pinchDistance: pinchDist,
          landmarks,
        }

        latestResult.current = state

        // 更新 Redux store
        store.dispatch(setHandDetected(true))
        store.dispatch(setPalmPosition([palmCenterX, palmCenterY]))
        store.dispatch(setPinchDistance(pinchDist))
      } else {
        // 手离开画面
        latestResult.current = null
        store.dispatch(setHandDetected(false))
        store.dispatch(setPalmPosition(null))
        store.dispatch(setPinchDistance(null))
      }
    }

    init()

    // ── 清理 ────────────────────────────────────────
    return () => {
      cancelled = true
      cancelAnimationFrame(animFrameRef.current)

      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream
        stream.getTracks().forEach((t) => t.stop())
        videoRef.current = null
      }

      if (landmarkerRef.current) {
        ;(landmarkerRef.current as any).close()
        landmarkerRef.current = null
      }
    }
  }, [])

  return latestResult
}
