/**
 * 页面静态文案唯一事实源（SPEC §3.8 附图标注 + §8 合规角标 + 页面标题区）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时领域层（src/lib），只依赖 TypeScript 自身——不依赖 React / Three.js /
 *   契约层 / 任何资产。页面组件（src/App.tsx 与后续 TASK 的南海附图、合规角标）、离线字体
 *   生产脚本（scripts/fonts/build-font-subset.ts）、资产校验（scripts/verify-assets/fonts-deep.ts）
 *   与测试基线都从这里取同一份文案，任何中文静态文案不得在其他地方维护第二份副本。
 * - 字体子集覆盖闭环：本模块的全部字符串经 collectStaticCopyStrings 汇入「字体子集必须覆盖
 *   的必需字符串集合」（src/lib/label-font.ts 的 collectRequiredLabelFontStrings），
 *   verify:assets 的 fonts scope 与 tests/assets/font-asset.test.ts 断言字体清单字符集合
 *   ⊇ 该集合——新增任何页面静态中文文案时只能在本模块追加，缺字会被确定性检出。
 *
 * 文案边界（本 TASK 只承载 SPEC §3.7 字体子集所需的静态文案）：
 * - 页面标题区（§3.4 骨架）、南海附图标题（§3.8）、合规角标（§8：审图号占位 + 数据源署名 +
 *   免责声明原文）。海拔色阶图例（§9）等后续 UI 的文案由对应 TASK 在本模块追加并重新生产
 *   字体子集（确定性管线，tests/fonts/build-font-subset.test.ts 保证重产逐字节一致）。
 */

/** 页面主标题（大屏骨架标题区，SPEC §3.4）。 */
export const PAGE_TITLE = '中国 3D 地势图'

/** 页面副标题（标题区下的一行定位说明）。 */
export const PAGE_SUBTITLE = '真实地形版图大屏'

/**
 * 南海诸岛 2D 附图标题（SPEC §3.8「南海诸岛岛礁点、标注」）。
 * 标准地图附图惯例：附图内标注「南海诸岛」四字；岛礁名称标注来自政治边界契约
 * （islandOrReefPoint.name），不在本模块重复维护。
 */
export const SOUTH_CHINA_SEA_INSET_TITLE = '南海诸岛'

/**
 * 合规角标免责声明（SPEC §8 原文，逐字不得改动）：
 * 「注明……直至取得审图号」。取得自然资源主管部门审图号前必须常驻页面。
 */
export const COMPLIANCE_DISCLAIMER =
  '本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版/发布用途'

/** 合规角标审图号字段名（SPEC §8「预留审图号占位」）。 */
export const COMPLIANCE_REVIEW_NUMBER_LABEL = '审图号'

/**
 * 合规角标审图号占位值（SPEC §8「文字如 GS(202x)xxxx 号，发布前由审图流程填入」）。
 * 未取得审图号时以此占位，取得后由审图流程替换为真实编号。
 */
export const COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER = 'GS(202x)xxxx 号（待取得）'

/** 合规角标数据源署名的引导词（SPEC §8「数据源署名（角标）」）。 */
export const COMPLIANCE_ATTRIBUTION_LEAD = '数据来源'

/**
 * 合规角标数据源署名条目（SPEC §8「标注 DEM（Copernicus DEM GLO-30）、边界（DataV.GeoAtlas）、
 * 九段线/岛礁（项目补充，非官方）来源」）。数组顺序即角标呈现顺序，固定以保证确定性。
 */
export const COMPLIANCE_ATTRIBUTION_ITEMS: readonly string[] = [
  'DEM：Copernicus DEM GLO-30',
  '边界：DataV.GeoAtlas',
  '九段线/岛礁：项目补充（非官方审图数据）',
]

/**
 * 收集全部页面静态文案字符串（扁平、顺序固定）。
 *
 * 这是「静态文案 → 字体子集覆盖集合」的唯一汇入口：离线字体生产脚本与覆盖校验都从这里取
 * 同一组字符串，字段顺序固定使字体清单（sourceStrings.staticCopy）可逐字节重产。
 * 在本模块新增文案常量后必须把它追加到本函数返回值（覆盖校验会强制提醒缺字）。
 */
export function collectStaticCopyStrings(): readonly string[] {
  return [
    PAGE_TITLE,
    PAGE_SUBTITLE,
    SOUTH_CHINA_SEA_INSET_TITLE,
    COMPLIANCE_DISCLAIMER,
    COMPLIANCE_REVIEW_NUMBER_LABEL,
    COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER,
    COMPLIANCE_ATTRIBUTION_LEAD,
    ...COMPLIANCE_ATTRIBUTION_ITEMS,
  ]
}
