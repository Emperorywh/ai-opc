/*
 * 样本运行时入口（workers 层，SPEC 2.1 / 3.1 / 4.1）。
 *
 * 浏览器运行时唯一允许请求的样本地址固定为 /generated/sampleMap.json：
 *   - 该文件由 predev / prebuild 在 SHA-256 校验通过后按原始字节生成，
 *     位于被 .gitignore 忽略的 public/generated 目录；
 *     生成物所有权属于供应链脚本，不可手工维护、不可提交，也不是第二事实来源。
 *   - 不存在远程 API、备用 URL、内嵌小样本或失败后的降级地图；
 *     任何对 data 下源样本的直接 import 或备用地址都违反运行时契约。
 *
 * 不可降级不变量：
 *   - 本常量是 src 中唯一允许出现的样本引用形式；
 *     字体与样本的远程入口由后续 TASK 在 CSP 层一并封堵。
 *   - 本层不解析、不校验样本内容；身份校验全部由构建前供应链完成。
 */
export const SAMPLE_RUNTIME_URL = '/generated/sampleMap.json' as const
