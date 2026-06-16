/**
 * R3F 场景内容根（SPEC §4.1 / §4.3 渲染管线）。
 *
 * Task 01：最小占位（背景色），确保空 Canvas 无 console error。
 * 后续 Task 依次填充：Terrain(04) → Ocean(06) → Labels(14) → Atmosphere(16) → ...
 */
export function Scene() {
  return (
    <>
      <color attach="background" args={['#0e1014']} />
      {/* TODO(Task 04): <Terrain /> */}
      {/* TODO(Task 06): <Ocean /> */}
    </>
  )
}
