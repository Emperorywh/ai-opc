import type { ActiveStage } from '../application/loadState'

/**
 * 加载阶段的用户可见展示文案（SPEC §10.1、§10.2、TASK-008）。
 *
 * 该模块位于展示层，把状态机的活跃阶段字面量映射为简体中文展示名称，供加载界面
 * 与错误界面统一引用。文案只表达"当前在做什么"的阶段语义，不混入错误码、百分比
 * 或业务叠层信息（SPEC §10.1：UI 只显示阶段名称和整数百分比）。
 *
 * 不变量：
 * - 与状态机阶段封闭：覆盖 ActiveStage 全部成员，新增阶段时必须同步补充文案，
 *   否则 getLoadingDisplay 会因缺键得到 undefined（测试强制该完整性）。
 * - 纯数据：不依赖 React、Three.js 或浏览器对象，可在 Node 环境完整验证。
 * - 与 ERROR_CODE_MESSAGE 区分：后者是错误码对应的中文说明（如"地图资产下载失败"），
 *   本表是阶段名称（如"下载地图资产"），二者语义不同、不互相替代。
 */

/**
 * 各活跃阶段对应的简体中文展示名称。
 *
 * 阶段名尽量短且可辨识，避免在加载卡片中换行；创建场景资源与场景淡入属于 preparing
 * 状态，仍由加载界面展示（场景资源尚未上屏渲染，TASK-008 范围内不呈现画布）。
 */
export const STAGE_DISPLAY_LABELS: Readonly<Record<ActiveStage, string>> = {
  downloading: '下载地图资产',
  parsing: '解析地图数据',
  validating: '校验地图数据',
  'compiling-nodes': '编译节点几何',
  'compiling-paths': '编译路径几何',
  'creating-scene': '创建场景资源',
  fading: '场景淡入',
}
