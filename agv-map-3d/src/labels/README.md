# labels — 标签描述符、字体门禁与可见集层

## 职责
- 生成节点、LINE、BEZIER 三类 `LabelDescriptor`（节点标签与边标签定位由两个独立纯函数实现）。
- 维护 4m uniform-grid 空间索引，基于视锥、投影字号、10/8px hysteresis 与 400 上限计算可见集。
- 本地字体字形门禁与预加载边界（TASK-015）：消费标签文本契约，校验字形覆盖、
  以依赖注入端口调用本地 WOFF 预加载，产出字体就绪 / `FONT_GLYPH_MISSING` / `FONT_ASSET_FAILED` 契约。

## 模块（TASK-015 新增字体能力）
- `fontGlyphGate.ts`：字形覆盖纯门禁 + 按 Unicode code point 去重名称字符。
- `glyphManifest.ts`：glyphs.json 原始结构 → 只读码点集合的纯解析器。
- `fontPreload.ts`：预加载编排入口；通过 `LabelFontPreloadPort` 依赖注入隔离 troika，
  不创建 Text 对象、不访问远端、不 fallback 系统字体。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、本层自身。
- 允许的外部包：仅 Node 内置。
- 禁止依赖 React、R3F、Three、Troika、浏览器 API 或更上层模块。
  Troika `preloadFont` 由调用方（后续 scene / app-root 装配层）包装为 `LabelFontPreloadPort` 注入。

## 关键不变量
- 启动时只建立 `LabelDescriptor` 与空间索引，不创建任何 Troika Text。
- 候选截断顺序固定：work/park/charge 节点 → 普通节点 → 边；同级按屏幕距离再按 ID 字典序。
- 字号投影使用 camera world quaternion 把局部 `+Y` 转为 `cameraScreenUp`，禁止用固定世界 `+Y`。
- 字体预加载只消费标签文本与 glyphs.json 清单码点；不读取样本原始 JSON、不重建标签描述符。
- 字形门禁先于预加载：缺字直接 `FONT_GLYPH_MISSING`，阻止 Troika 联网补字；
  端口失败统一 `FONT_ASSET_FAILED`，不切换系统/远端字体、不用 WOFF2。
