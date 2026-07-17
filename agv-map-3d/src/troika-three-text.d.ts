/*
 * troika-three-text 模块类型声明（app-root 层，SPEC 11.1 / 3.3 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - troika-three-text 0.52.4 未随包发布 TypeScript 类型；本声明为 app-root 的
 *     mapRuntimePorts.ts 包装 preloadFont 提供最小可用类型，避免隐式 any。
 *   - 仅声明本工程实际消费的 preloadFont；其余导出（Text 等）由后续标签 TASK 按需扩充。
 *
 * 依赖方向（SPEC 3.3）：app-root（src 根 .d.ts）；不引入运行时 import，不影响分层扫描。
 *   labels 层仍禁止直接 import troika（SPEC 3.3），Troika 调用唯一经 LabelFontPreloadPort 注入。
 */
declare module 'troika-three-text' {
  // ambient module 内引用 three.Object3D 作为 Text 基类（不引入顶层 import，保持文件为脚本）。
  import { Object3D as ThreeObject3D } from 'three'
  /*
   * 预加载本地字体（SPEC 11.1）。
   * options.font：本地字体 URL；options.characters：去重名称字符；options.sdfGlyphSize：SDF 尺寸。
   * callback：预加载完成回调；Troika 在成功时调用，失败时可能仅 console.error 不回调
   *   （由 mapRuntimePorts 的端口实现用超时收敛为 onDone(err)）。
   */
  export function preloadFont(
    options: {
      readonly font: string
      readonly characters: string
      readonly sdfGlyphSize: number
    },
    callback: (result?: unknown) => void,
  ): void

  /*
   * Troika 文本对象（SPEC 11.1 / 11.4，TASK-022 按需标签）。
   *
   * 定位（TASK-022）：
   *   - Text 是 three 的 Object3D 子类，承载 position / quaternion / scale 与 renderOrder，
   *     由 scene 层 LazyLabelLayer 以 <primitive> 挂入场景。继承 three.Object3D 全部可变属性。
   *   - 标签参数（fontSize / sdfGlyphSize / gpuAccelerateSDF / whiteSpace / color / font /
   *     anchorX / anchorY / depthTest / depthWrite / toneMapped）固定由 labelText 工厂一次性写入，
   *     与 SPEC §11.1 视觉契约一致；本类型只声明工程实际消费的 Text 专属字段。
   *
   * sync(callback)：触发一次文本布局 / SDF 同步；Troika 内部异步处理（已 preloadFont 时复用缓存），
   *   完成后调用 callback。demand 帧模式下由调用方在 callback 内 invalidate 请求一次渲染。
   * dispose()：释放该 Text 的 SDF / 几何等 GPU 资源，幂等；由创建方成对调用。
   */
  export class Text extends ThreeObject3D {
    text: string
    font: string | null
    fontSize: number
    sdfGlyphSize: number
    gpuAccelerateSDF: boolean
    whiteSpace: string
    color: number | string
    anchorX: string | number
    anchorY: string | number
    depthTest: boolean
    depthWrite: boolean
    toneMapped: boolean
    sync(callback?: () => void): void
    dispose(): void
  }
}
