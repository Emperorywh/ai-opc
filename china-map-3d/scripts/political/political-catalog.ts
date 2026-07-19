/**
 * 政治边界补充数据领域真值目录（TASK-006）—— 离线层再导出垫片。
 *
 * 真值定义已上移至契约层 src/geo-contracts/political-catalog.ts（单一定义点），
 * 使运行时数据访问层（src/lib/political-features 的主图渲染准备）、离线资产深度校验
 * （scripts/verify-assets/political-deep）、测试基线（tests/assets/political-asset）共用同一份
 * SPEC §6 红线点名清单，不存在第二套九段线段数 / 台湾东侧段序号 / 点名岛礁名常量。
 *
 * 本文件保留为离线层（scripts/）的再导出垫片，避免破坏 TASK-006 交付期已稳定的
 * `import { ... } from '../political/political-catalog'` 引用（political-deep、political-asset 测试）。
 * 新代码应直接从 src/geo-contracts 导入。
 */

export {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  POLITICAL_SOURCE_ID,
  REQUIRED_DISPUTED_REGIONS,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
} from '../../src/geo-contracts/political-catalog'
