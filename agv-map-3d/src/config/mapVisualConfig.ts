/*
 * 唯一视觉与渲染资源常量表（config 层，SPEC 7.1 / 7.3 / 7.4）。
 *
 * 定位（TASK-014）：
 *   - 本模块是 SPEC 第 7 章视觉常量、材质参数、深度策略与提交顺序的唯一数据来源。
 *   - rendering 层（资源适配）与后续 scene 层（图层装配）都只消费本模块导出的常量，
 *     禁止在适配器与场景层各定义一份同义配置（SPEC 7.1 / 任务约束）。
 *   - 本层是纯数据：不依赖 React / Three / R3F / 浏览器 API，只表达数值与结构化参数，
 *     由上层映射到具体 Three 对象属性。
 *
 * 与 geometry 层常量的关系（SPEC 7.1 / 8 / 9 / 10）：
 *   - geometry 层为生成实例矩阵 / 颜色 / bounds 自身引用同一 SPEC 来源（如节点半径、层高），
 *     这是本工程既定的“各层各自引用同一 SPEC 来源、不形成第二套语义”约定。
 *   - 本模块不替代 geometry 层契约常量，而是作为渲染资源参数与提交顺序的统一入口；
 *     两层引用同一 SPEC，值由 SPEC 第 7 章唯一决定。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，外部仅允许 Node 内置；常量是纯数据。
 */

/*
 * SPEC 7.1：世界尺度。一米对应一个 Three.js 世界单位。
 * 仅作为可读契约常量；渲染层不据此做额外缩放（实例矩阵已直接携带场景坐标）。
 */
export const WORLD_UNIT_METERS = 1

/*
 * SPEC 7.1 / 8.1：节点共享基准圆柱几何参数。
 *   - radiusTop / radiusBottom = 1：基准圆柱半径为 1，实例矩阵按节点半径缩放 X/Z。
 *   - height = 0.05m：节点高度；实例中心 Y 0.035 时底面 0.010、顶面 0.060。
 *   - radialSegments = 24：圆柱分段。
 * CylinderGeometry(1, 1, 0.05, 24) 由 rendering 层据此构造一次，全部节点实例共享。
 */
export const NODE_BASE_CYLINDER = {
  radiusTop: 1,
  radiusBottom: 1,
  height: 0.05,
  radialSegments: 24,
} as const

/*
 * SPEC 7.1：各渲染层固定高度 worldY（米）。
 *   - ribbon / 两类箭头的 Y 已烘焙进各自实例矩阵或 Mesh 平移；本表是统一来源，
 *     rendering 层消费 ribbon（Mesh 平移），其余供后续 scene / labels 层与诊断对齐。
 *   - 高度始终使用单独的 worldY，禁止把地图 y 与 Three y 混用（SPEC 6.2）。
 */
export const LAYER_Y = {
  ground: 0.0,
  ribbon: 0.006,
  edgeArrow: 0.014,
  nodeBottom: 0.01,
  nodeTop: 0.06,
  nodeArrow: 0.066,
  labelAnchor: 0.25,
} as const

/*
 * SPEC 7.3：ribbon 材质参数（MeshBasicMaterial）。
 *   - vertexColors 由 rendering 层在材质构造时直接置 true（顶点色专属开关，非可调常量）。
 *   - toneMapped = false：基础材质不受色调映射，复刻稳定像素。
 *   - polygonOffset = true / factor = -1 / units = -1：避免与同高度实体共面闪烁
 *     （SPEC 7.3 Ribbon polygonOffset）。
 */
export const RIBBON_MATERIAL_PARAMS = {
  toneMapped: false,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
} as const

/*
 * SPEC 7.3：两类箭头材质公共参数（MeshBasicMaterial）。
 *   - 白色 base color 由 rendering 层在材质构造时给出，乘 InstancedMesh.instanceColor。
 *   - toneMapped = false：基础材质不受色调映射；节点箭头与边箭头共用本参数。
 */
export const ARROW_MATERIAL_PARAMS = {
  toneMapped: false,
} as const

/*
 * SPEC 7.3：节点材质参数（MeshStandardMaterial）。
 *   - 白色 base color 由 rendering 层给出，乘 InstancedMesh.instanceColor。
 *   - roughness = 0.8、metalness = 0：受光的哑光圆柱。
 */
export const NODE_MATERIAL_PARAMS = {
  roughness: 0.8,
  metalness: 0,
} as const

/*
 * SPEC 7.3：深度策略。
 *   - 所有实体保留 depthTest = true（Three 默认，此处仅作统一来源说明）。
 *   - 节点箭头 depthWrite = false：避免与圆柱顶面争夺深度（SPEC 7.3 Node Arrow）。
 *   - 两类箭头与其余实体保持默认 depthWrite = true。
 */
export const DEPTH_POLICY = {
  allDepthTest: true,
  nodeArrowDepthWrite: false,
} as const

/*
 * SPEC 7.4：提交顺序 renderOrder（仅规定绘制提交顺序，不替代深度测试）。
 *   - Ground / Label 不由本 TASK 创建，但顺序值在此统一登记，供后续 scene 层装配时引用。
 *   - rendering 层为 ribbon / 两类箭头 / 节点 / 节点箭头设置对应 renderOrder。
 */
export const RENDER_ORDER = {
  ground: 0,
  ribbon: 10,
  edgeArrow: 20,
  node: 30,
  nodeArrow: 40,
  label: 50,
} as const

/*
 * SPEC 7.2 / 7.3：场景环境与渲染器常量（scene 装配层 / app-root 的唯一数据来源）。
 *
 * 定位（TASK-018）：
 *   - 背景色、地面色、地面材质参数、半球光 / 方向光参数与渲染器 DPR 范围全部集中在此，
 *     scene 装配层与 app-root 只消费本表，禁止在组件内出现同义魔法数字（SPEC 7.1 唯一常量表）。
 *   - 这些常量描述“静态环境”，不随数据变化；节点 / 边颜色仍由 geometry 层一次性线性化后
 *     写入 typed array，本表不重复定义那部分业务色。
 *
 * 无阴影不变量（SPEC 7.3 / 任务约束）：
 *   - v1 不启用阴影、不创建 shadow map；方向光 castShadow 恒为 false（由 scene 装配层固定）。
 */
export const BACKGROUND_COLOR = '#111318'

/*
 * SPEC 7.2：有限地面颜色。
 */
export const GROUND_COLOR = '#1A1A1A'

/*
 * SPEC 7.3：地面材质参数（MeshStandardMaterial）。
 *   - roughness = 1、metalness = 0：纯哑光有限平面，受半球光 / 方向光柔和照亮。
 */
export const GROUND_MATERIAL_PARAMS = {
  roughness: 1,
  metalness: 0,
} as const

/*
 * SPEC 7.3：半球光参数。
 *   - 天空色 #FFFFFF、地面色 #202020、强度 0.8。
 *   - 半球光为场景提供自上而下的环境光，使受光节点圆柱呈现稳定明暗。
 */
export const HEMISPHERE_LIGHT_PARAMS = {
  skyColor: '#FFFFFF',
  groundColor: '#202020',
  intensity: 0.8,
} as const

/*
 * SPEC 7.3：方向光参数。
 *   - 白色、强度 1.0、位置 (80, 120, 60)。
 *   - 方向光为节点圆柱提供方向性高光与明暗差；v1 不投射阴影（castShadow = false）。
 */
export const DIRECTIONAL_LIGHT_PARAMS = {
  color: '#FFFFFF',
  intensity: 1.0,
  position: [80, 120, 60] as readonly [number, number, number],
} as const

/*
 * SPEC 7.3：渲染器 DPR 夹取范围。
 *   - Canvas DPR 固定夹在 [1, 1.5]，禁止直接使用无限制设备 DPR。
 *   - 由 app-root 的 <Canvas dpr={RENDERER_DPR_RANGE}> 消费，避免在高 DPR 设备上过度采样。
 */
export const RENDERER_DPR_RANGE: readonly [number, number] = [1, 1.5]

/*
 * SPEC 7.2：实体显示色（sRGB hex），供 UI 图例与诊断只读展示。
 *
 * 定位（TASK-018）：
 *   - 这些 hex 是 SPEC §7.2 明文给出的显示色；geometry 层在更早 TASK 已用其一次性线性化后
 *     写入 typed array，本表不替代那条数据通路，只为 UI 图例与文档提供与 SPEC 同源的只读色值。
 *   - ui 层（图例）只依赖 config，故实体色必须在此暴露；不在 ui 层重复定义第二套 hex。
 */
export const ENTITY_DISPLAY_COLORS = {
  node: '#78909C',
  work: '#2196F3',
  park: '#F44336',
  charge: '#8BC34A',
  edgeForward: '#BDBDBD',
  edgeBack: '#E57373',
  label: '#FFFFFF',
} as const
