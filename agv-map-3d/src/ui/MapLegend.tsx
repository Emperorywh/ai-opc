/*
 * 静态颜色图例与操作说明（ui 层，SPEC 7.2 / 12.5 / 13 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 呈现 SPEC §7.2 实体显示色与纯文本操作说明，作为只读静态地图的常驻参考。
 *   - 色值来自 config ENTITY_DISPLAY_COLORS（唯一来源）；本组件不重复定义 hex、不接触 Three。
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
 * 静态颜色图例与操作说明主组件。
 * 无 props：内容全部来自 SPEC 与 config，不随加载状态变化。
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
    </aside>
  )
}
