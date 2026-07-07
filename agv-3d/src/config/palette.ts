// ============================================================================
// 调色板：深色工业风集中配色（SPEC §6）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 所有颜色统一存为 string（hex 或 rgba 原样字符串），不在本文件解析；
//    three 的 Color / troika 文字描边等各使用点按需自行解析，便于整体换肤。
// 2. 仅导出数据对象，无任何运行时副作用，天然满足 erasableSyntaxOnly。
// 3. 命名按「语义」而非「色值」组织（如 edgeForward / nodeWork），
//    下游直接按 isBackEdge / NodeType 取色，不关心具体十六进制。
// ============================================================================
export const palette = {
  // 背景：深色工业风底色，场景铺满该色（MapView 的 <color attach="background">）
  background: '#0a0e1a',

  // 路径配色：按 isBackEdge 二分色（SPEC §4.3）
  // 正向边：青绿荧光
  edgeForward: '#00e5a8',
  // 反向边：暖橙红
  edgeBack: '#ff6b6b',

  // 方向箭头配色：比所属边略亮一档（SPEC §4.5）
  arrowForward: '#38ffc1',
  arrowBack: '#ff8e8e',

  // 节点 5 类配色：按 type 区分语义（SPEC §5.2）
  // work：作业点（亮蓝）
  nodeWork: '#4dabf7',
  // charge：充电点（能量黄）
  nodeCharge: '#ffd43b',
  // park：停放点（中性灰）
  nodePark: '#868e96',
  // warehouse：仓储点（仓储紫）
  nodeWarehouse: '#b197fc',
  // node：普通节点（浅灰，未知 type 也归入此色）
  nodeNode: '#ced4da',

  // 标签文字与描边（SPEC §6）
  // 文字主色：近白，深底高对比
  labelText: '#e9ecef',
  // 描边：半透明黑，给文字加底缘避免在亮路径上糊掉
  // 注意是非 hex 的 rgba 字符串，由 troika <Text> 的描边参数自行消费
  labelStroke: 'rgba(0,0,0,0.6)',
} as const
