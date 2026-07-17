/*
 * 共享类型原语（domain 层，SPEC 2.2 / 5.1）。
 *
 * 信任边界定位：
 *   - NodeType / EdgeType 同时被 raw DTO（adapters 层）与领域模型（domain 层）
 *     消费。domain 是依赖图根，把它们定义在此处，使上下游共用同一份字面量联合，
 *     避免重复声明导致的类型漂移。
 *
 * 关键不变量（SPEC 2.2 / 5.1）：
 *   - 节点类型只允许四个固定值；样本不存在的旧类型（warehouse / shelf 等）
 *     不属于本联合，遇到时必须报错，禁止给默认样式。
 *   - 边类型只允许两个固定值；判别联合由 edgeType 字段决定。
 *   - 这两个联合是闭合集合，任何扩展都必须先修改 SPEC 再修改本文件。
 */

/*
 * 节点类型联合：覆盖样本全部四类节点。
 * 未知字符串不属于本联合，解析边界必须以 MAP_ENTITY_INVALID 拒绝。
 */
export type NodeType = 'node' | 'work' | 'park' | 'charge'

/*
 * 边类型联合：LINE 与 BEZIER 的判别标签。
 * 控制点字段的合法形态由该标签决定（SPEC 5.3 第 8 项）。
 */
export type EdgeType = 'LINE' | 'BEZIER'
