/*
 * 单个已挂载标签的 R3F 装配（scene 装配层，SPEC 11.1 / 11.4 / 13 / 4.3 / 任务约束）。
 *
 * 信任边界定位（TASK-022）：
 *   - 本组件只装配“一个已进入可见集的标签”：用 createLabelText 创建 Troika Text、经 <primitive> 挂入场景、
 *     在卸载时 dispose。不计算可见集、不写朝向、不解析数据（任务约束）。
 *   - 朝向（quaternion）与逐帧屏幕偏移位姿由 LazyLabelLayer 的单一帧协调器批量写入 Text 对象；
 *     本组件不注册 useFrame、不嵌套 <Billboard>（SPEC 11.4 / 任务“禁止每个标签各自注册帧回调”）。
 *
 * 资源所有权不变量（SPEC 4.3 / 任务“文字对象由创建方成对释放”）：
 *   - Text 在 useLayoutEffect 内创建并在同一 effect 的 cleanup 内 dispose，使“每次创建必有一次释放”成立。
 *   - StrictMode 下 setup→cleanup→setup 产生两份 Text：cleanup 各自 dispose，卸载时再 dispose 第二份，
 *     全程无悬挂资源（SPEC 4.3 幂等 / 15.3 计数不单调增长）。
 *   - 不得在渲染阶段创建 Text：StrictMode 会丢弃首次渲染阶段结果，被丢弃的 Text 永不 dispose（SPEC 4.3）。
 *
 * 字体门禁接入不变量（SPEC 11.1 / 任务约束）：
 *   - 本组件只由 LazyLabelLayer 在 fontReady 后为可见集中的标签渲染；字体预加载已由 application 层门禁完成，
 *     text.sync() 复用 preloadFont 的 SDF 缓存，不触发远端 / Unicode CDN 补字。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - text.sync 完成回调内 invalidate 请求一次 demand 帧，使文字 SDF 就绪后必有一次渲染。
 *
 * 依赖方向（SPEC 3.3）：本层（labelText 工厂）+ labels（LabelDescriptor 类型）+ r3f + react + troika（经工厂）。
 */
import { useLayoutEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import type { LabelDescriptor } from '../labels/labelDescriptor'
import { createLabelText } from './labelText'
import type { Text } from 'troika-three-text'

/*
 * 单标签入参。
 *   - descriptor：该标签的不可变描述符（锚点 / 局部偏移 / 文本 / 类别）。
 *   - fontUrl：本地字体 URL（与预加载同源）。
 *   - onTextReady：Text 创建后回调，供帧协调器登记到批量朝向写入表（注册后即可被每帧同步）。
 *   - onTextDestroy：Text 销毁前回调，供帧协调器从登记表移除，避免写入已释放对象。
 */
export interface LabelTextItemProps {
  readonly descriptor: LabelDescriptor
  readonly fontUrl: string
  readonly onTextReady: (id: string, text: Text) => void
  readonly onTextDestroy: (id: string) => void
}

/*
 * 单标签装配组件。
 *
 * Text 经 state 暴露给渲染：首次渲染时尚未创建（返回空片段），layout effect 创建后 setState 同步触发
 *   重渲染挂入 <primitive>，使文字在首次绘制前进入场景。与 GroundLayer / SceneEnvironmentLayer 共用
 *   同一资源所有权模式（effect 内创建 / cleanup dispose），保证 StrictMode 下计数平衡。
 */
export function LabelTextItem({
  descriptor,
  fontUrl,
  onTextReady,
  onTextDestroy,
}: LabelTextItemProps): React.JSX.Element {
  // invalidate 经 useThree 取自 R3F store；用于 text.sync 完成后请求一次 demand 帧。
  const invalidate = useThree((s) => s.invalidate)
  // Text 经 state 暴露；初值为 null（首帧不装配 primitive，layout effect 创建后挂入）。
  const [text, setText] = useState<Text | null>(null)

  useLayoutEffect(() => {
    // 资源创建唯一在 layout effect 内发生：StrictMode 下每份 Text 都被自身 cleanup dispose（SPEC 4.3）。
    const created = createLabelText({ descriptor, fontUrl })
    // 登记到帧协调器的批量朝向表：注册后即可被每帧 quaternion / position 写入（SPEC 11.4）。
    onTextReady(descriptor.id, created)
    setText(created)
    // 触发文本布局 / SDF 同步（复用 preloadFont 缓存）；完成回调内 invalidate 请求一次渲染（SPEC 13）。
    created.sync(() => {
      invalidate()
    })
    return () => {
      // cleanup 与创建一一配对：先从协调器表移除（避免写入已释放对象），再 dispose 释放 GPU 资源。
      onTextDestroy(descriptor.id)
      created.dispose()
    }
    // descriptor / fontUrl 稳定（可见集内同一标签的描述符不可变、字体 URL 固定）；
    // onTextReady / onTextDestroy 由父层稳定回调提供（useCallback），不引发重复创建。
  }, [descriptor, fontUrl, onTextReady, onTextDestroy, invalidate])

  // 资源尚未创建时（首帧 / StrictMode 重建间隙）渲染空片段；创建完成后挂入 Troika Text。
  return <>{text === null ? null : <primitive object={text} />}</>
}
