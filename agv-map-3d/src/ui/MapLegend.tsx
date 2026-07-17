/*
 * 静态颜色图例与操作说明（ui 层，SPEC 7.2 / 12.5 / 13 / 任务约束）。
 *
 * 定位（TASK-018 / TASK-020）：
 *   - 呈现 SPEC §7.2 实体显示色与纯文本操作说明，作为只读静态地图的常驻参考。
 *   - 色值来自 config ENTITY_DISPLAY_COLORS（唯一来源）；本组件不重复定义 hex、不接触 Three。
 *   - TASK-020 增补纯文本操作说明（SPEC §12.5“纯文本操作说明”）：键位映射只在本组件静态展示，
 *     与 MapCameraController 的实际键位判定同源（camera/keyboardIntent），不维护人工同步副本。
 *
 * 依赖方向（SPEC 3.3）：config（显示色）+ 本层自身 + react；外部仅 react。
 *   不依赖 three / r3f / application / workers；纯静态展示。
 */
import { ENTITY_DISPLAY_COLORS } from '../config/mapVisualConfig'

/*
 * 图例条目：颜色色块 + 文本说明。
 */
interface LegendItem {
  readonly color: string
  readonly label: string
}

/*
 * SPEC §7.2 实体显示色图例条目（顺序：节点四类 → 边两类 → 标签）。
 */
const LEGEND_ITEMS: readonly LegendItem[] = [
  { color: ENTITY_DISPLAY_COLORS.node, label: '普通节点 node' },
  { color: ENTITY_DISPLAY_COLORS.work, label: '作业节点 work' },
  { color: ENTITY_DISPLAY_COLORS.park, label: '停车节点 park' },
  { color: ENTITY_DISPLAY_COLORS.charge, label: '充电节点 charge' },
  { color: ENTITY_DISPLAY_COLORS.edgeForward, label: '正向边 isBackEdge=false' },
  { color: ENTITY_DISPLAY_COLORS.edgeBack, label: '反向边 isBackEdge=true' },
  { color: ENTITY_DISPLAY_COLORS.label, label: '标签文字' },
]

/*
 * 纯文本操作说明条目（SPEC §12.5）。键位与 camera/keyboardIntent 的 interpretKey 同源；
 * 文本为面向用户的简体中文描述，不在此重复定义数值常量。
 */
const OPERATION_ITEMS: readonly { readonly key: string; readonly action: string }[] = [
  { key: '方向键', action: '沿视图平移' },
  { key: '+ / -', action: '缩放' },
  { key: 'Q / E', action: '绕目标旋转' },
  { key: 'Home', action: '复位到初始视角' },
]

/*
 * 静态颜色图例与操作说明主组件。
 * 无 props：内容全部来自 SPEC 与 config，不随加载状态变化、不回读样本 JSON。
 */
export function MapLegend(): React.JSX.Element {
  return (
    <aside className="map-legend" aria-label="地图图例与操作说明">
      <ul className="map-legend__items">
        {LEGEND_ITEMS.map((item) => (
          <li key={item.label} className="map-legend__item">
            <span
              className="map-legend__swatch"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="map-legend__label">{item.label}</span>
          </li>
        ))}
      </ul>
      {/*
        纯文本操作说明（SPEC §12.5）：静态展示键位映射，辅助技术与键盘用户均可读取。
        图例容器 pointer-events: none，不抢夺地图容器的键盘焦点。
      */}
      <ul className="map-legend__operations" aria-label="键盘操作说明">
        {OPERATION_ITEMS.map((item) => (
          <li key={item.key} className="map-legend__operation">
            <span className="map-legend__key" aria-hidden="true">
              {item.key}
            </span>
            <span className="map-legend__action">{item.action}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
