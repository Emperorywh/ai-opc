# public/fonts — 本地字体子集

本目录随项目打包 SPEC 11.1 要求的本地字体资产、字形清单、许可证与可审计来源记录。
运行时（浏览器）只通过同源 URL `/fonts/NotoSansSC-Bold.sample.woff` 请求本地字体，
不使用任何远端字体、系统字体 fallback、Unicode CDN 或 WOFF2。

## 文件

| 文件 | 作用 |
|---|---|
| `NotoSansSC-Bold.sample.woff` | Noto Sans SC Bold 子集（ASCII U+0020–U+007E ∪ 样本中文集合），Troika 预加载的唯一本地字体。 |
| `glyphs.json` | 子集字形清单（码点 + 字符 + 来源身份 + 子集范围），是构建期字形门禁与运行时审计的唯一码点来源。 |
| `LICENSE` | SIL Open Font License 1.1（Noto 项目分发许可证）。 |
| `SOURCE.md` | 可审计来源记录：固定下载 URL、源二进制 SHA-256、子集范围与生成方式。 |

## 不变量（SPEC 11.1 / 14.1）

- 子集至少覆盖 ASCII `U+0020–U+007E` 与样本中文集合 `丝充制口抛桩点电碱站绒网门`。
- 构建期逐 code point 校验全部 4,810 个名称都在 `glyphs.json` 中；缺字直接失败为 `FONT_GLYPH_MISSING`。
- 运行时字体预加载显式传入本地 `.woff` URL 和全部去重名称字符；只有成功回调才发出字体就绪信号，
  失败统一映射为 `FONT_ASSET_FAILED`，不切换系统/远端字体。

## 重新生成（一次性，非构建依赖）

升级源字体或扩展子集范围时执行（正常 `npm run build` 不触发）：

```sh
pip install fonttools brotli      # 一次性生成工具
node scripts/build-font-subset.mjs
```

来源身份、子集范围与生成参数全部固定在 `scripts/font-source.mjs`，产物随项目提交。
