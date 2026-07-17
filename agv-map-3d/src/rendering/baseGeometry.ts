/*
 * 共享基准几何顶点（rendering 层，SPEC 8.2 / 10.1）。
 *
 * 定位（TASK-014）：
 *   - 本模块定义节点箭头与边箭头各自共享的单位三角形顶点，供 rendering 层构造
 *     非索引 BufferGeometry；全部对应实例共享一个几何，不得按实体或类型拆分。
 *   - 节点圆柱基准几何使用 THREE.CylinderGeometry 直接构造（参数来自 config），不在本模块表达。
 *
 * 与 geometry 层基准几何的关系（SPEC 8.2 / 10.1）：
 *   - geometry 层的 NODE_ARROW_VERTICES / EDGE_ARROW_VERTICES 用于纯数值 bounds 推导；
 *     本模块的同名常量用于渲染层 BufferGeometry 构造。两者引用同一 SPEC 来源，
 *     是本工程“各层各自引用同一 SPEC 来源、不形成第二套语义”既定约定的体现。
 *   - 一致性由自动化测试交叉比对（tests/unit/mapResources.test.ts），任一侧被改动
 *     而另一侧未同步会立刻失败，杜绝绕序 / 顶点漂移。
 *
 * 绕序不变量（SPEC 8.2 / 10.1）：
 *   - 两类三角形均位于 XZ 平面、局部朝 +X，从 +Y 观察为逆时针（正面朝上）。
 *   - 顶点本身不携带任何节点角度或边方向；每个实例只在矩阵中旋转一次（SPEC 8.2 / 10.2）。
 *
 * 依赖方向（SPEC 3.3）：本层自身，无内部依赖；不依赖 Three（仅导出纯数值数组）。
 */

/*
 * SPEC 8.2：节点箭头共享基准三角形（局部朝 +X，位于 XZ 平面）。
 * 顶点顺序 [tip, back-left, back-right] 从 +Y 观察为逆时针，正面朝上：
 *   - tip   = ( 0.5, 0,  0.0)：箭尖位于局部 +X。
 *   - back1 = ( 0.0, 0, -0.5)：左后角位于 -Z。
 *   - back2 = ( 0.0, 0,  0.5)：右后角位于 +Z。
 * 三角形为“单位尺度”，具体尺寸由实例矩阵的 X/Z 缩放（节点半径）赋予。
 */
export const NODE_ARROW_VERTICES: readonly number[] = [
  0.5, 0, 0.0,
  0.0, 0, -0.5,
  0.0, 0, 0.5,
]

/*
 * SPEC 10.1：边箭头共享基准三角形（局部朝 +X，位于 XZ 平面）。
 * 顶点顺序 [tip, right, left] 从 +Y 观察为逆时针，正面朝上：
 *   - tip   = ( 0, 0,  0.00)：箭尖位于局部原点，实例平移即 tip 世界坐标。
 *   - right = (-1, 0, -0.55)：右后角，箭身沿 -X 后伸、-Z 侧。
 *   - left  = (-1, 0,  0.55)：左后角，箭身沿 -X 后伸、+Z 侧。
 * 三角形为“单位尺度”（箭身长 1、半宽 0.55），LINE 与 BEZIER 共用同一几何；
 * 具体尺寸由实例矩阵的 X/Z 缩放（箭头长度 L）赋予。
 */
export const EDGE_ARROW_VERTICES: readonly number[] = [
  0, 0, 0,
  -1, 0, -0.55,
  -1, 0, 0.55,
]
