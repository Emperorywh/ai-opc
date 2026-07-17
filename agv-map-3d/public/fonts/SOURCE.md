# NotoSansSC-Bold.sample.woff — 字体来源与子集记录

本文件是 `public/fonts/NotoSansSC-Bold.sample.woff` 的可审计来源记录（SPEC 11.1）。
任何升级源字体或扩展子集范围的操作都必须先更新 `scripts/font-source.mjs`，再重新运行
`node scripts/build-font-subset.mjs`，并把更新的产物与本记录一并提交。

## 来源身份

| 项 | 值 |
|---|---|
| 字族 | Noto Sans SC |
| weight | 700（Bold） |
| 分发渠道 | Google Fonts (gstatic) |
| 许可证 | SIL Open Font License 1.1 |
| 上游仓库 | https://github.com/notofonts/noto-cjk |
| 固定下载 URL | https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf |
| 源二进制 SHA-256 | `0066A522A1AC007C1D72BC4FCCB114F80FF7294641C78CEAD9715BD14D43B9EA` |

源二进制通过 Google Fonts CSS API（weight=700）解析出的 gstatic 直链获取。
URL 中的 `v40` 与文件名哈希共同锁定字节级身份；下载后必须与上述 SHA-256 一致。

## 子集范围

- ASCII 可打印区：U+0020–U+007E（95 个码点）。
- 样本中文字符集合：丝充制口抛桩点电碱站绒网门（13 个码点）。
- 子集合计码点数：108。
- 输出格式：WOFF（Troika 明确支持；SPEC 11.1 禁止 woff2）。

## 码点清单

完整码点清单见同目录 `glyphs.json`。

## 生成方式（一次性，非构建依赖）

```sh
pip install fonttools brotli      # 一次性生成工具，不进入构建依赖
node scripts/build-font-subset.mjs
```

脚本固定调用 `pyftsubset --flavor=woff --no-hinting --desubroutinize`，
码点来自 `scripts/font-source.mjs` 的 `computeSubsetCodePoints()`。

## 产物校验

| 产物 | 路径 | SHA-256 |
|---|---|---|
| 子集字体 | `public/fonts/NotoSansSC-Bold.sample.woff` | `896DFECA90A19E46BF5DC0C1CC7B1B567256BD874DDF8699D702925D787F6EDE` |
| 字形清单 | `public/fonts/glyphs.json` | — |
| 许可证 | `public/fonts/LICENSE` | — |

生成时间（UTC）：2026-07-17T16:35:42.305Z
