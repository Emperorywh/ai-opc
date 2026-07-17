/*
 * 本地字体运行时常量（config 层，SPEC 11.1 / 14.1）。
 *
 * 定位（TASK-015）：
 *   - 本模块是 SPEC 11.1 中与字体预加载相关的运行时常量唯一来源：
 *     本地字体 URL、Troika SDF 字形尺寸。
 *   - 标签文本、glyphs.json 清单与许可证等构建期数据不属于本模块；
 *     它们由 scripts/font-source.mjs 与 public/fonts/ 持有，构建期与运行时各自取用。
 *
 * 无 fallback 不变量（SPEC 11.1 / 任务约束）：
 *   - fontUrl 固定为同源本地 .woff，禁止远端、系统字体、Unicode CDN、WOFF2 或运行时替换。
 *   - sdfGlyphSize 固定 64，与 Troika Text 渲染参数一致，保证预加载与正式渲染使用同一 SDF 分辨率。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，外部仅允许 Node 内置；常量是纯数据。
 */

/*
 * SPEC 11.1：运行时本地字体 URL。
 * Vite 把 public/ 下文件原样映射到根路径，故同源 URL 为 /fonts/...；
 * 该 URL 与 scripts/font-source.mjs 的 FONT_RUNTIME_URL 同源 SPEC，运行时禁止改为远端。
 */
export const LABEL_FONT_URL = '/fonts/NotoSansSC-Bold.sample.woff'

/*
 * SPEC 11.1：Troika Text SDF 字形尺寸。
 * 预加载与正式 Text 渲染共用同一 SDF 分辨率（64），保证 preloadFont 产出的 SDF 缓存可直接复用。
 */
export const LABEL_FONT_SDF_GLYPH_SIZE = 64
