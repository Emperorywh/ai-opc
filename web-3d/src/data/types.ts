/**
 * 领域类型骨架（SPEC §4.1）。
 *
 * ⚠️ Task 01 仅占位；Country/River/Label 的完整字段在对应 Task
 *    （M4 标签 / M6 边界 / M10 河流）随二进制数据格式确定。
 */

/** 国家（M6 边界数据 pipeline 填充完整字段）。 */
export type Country = {
  id: number
  isoA3: string
  continent: string
}

/** 河流（M10 河流数据 pipeline 填充完整字段）。 */
export type River = {
  id: number
  name: string
}

/** 标签（M4 标签数据 pipeline 填充完整字段）。 */
export type Label = {
  id: string
  zhName: string
  kind: 'continent' | 'ocean' | 'country' | 'city'
  lon: number
  lat: number
  priority: number
}
