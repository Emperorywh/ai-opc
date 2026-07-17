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
}
