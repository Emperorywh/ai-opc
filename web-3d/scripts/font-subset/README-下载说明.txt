字体子集化源字体获取说明（Task 12 · M4）
================================================

同 GEBCO 模式：原始字体资产（~17MB Noto Sans SC 可变字体）不进 git，
仅子集化产物 public/fonts/map-zh.woff2（数 KB）进 git。

1. 源字体：Noto Sans SC（思源黑体简体，SIL OFL 许可）
   官方来源：google/fonts GitHub 仓库（可变字体，wght 100–900，含完整简中字库）
   URL: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
   体积：约 17MB

2. 自动下载（推荐）：
   pnpm gen:font:fetch
   → 下载到 scripts/font-subset/raw/NotoSansSC[wght].ttf
   → raw/ 已 .gitignore，不进版本控制

3. 子集化：
   pnpm gen:font
   → 读 raw/ 源字体 + charset（七大洲四大洋中文名 + ASCII + 标点，见 charset.mjs）
   → subset-font（harfbuzz hb-subset）提取所需字形，pin wght=400 固化为 Regular 静态子集
   → 产出 public/fonts/map-zh.woff2（< 100KB，进 git）

4. 许可与署名：
   Noto Sans SC 为 SIL Open Font License (OFL)，可自由使用 / 子集化 / 再分发。
   子集化产物 map-zh.woff2 继承 OFL。
   字体 OFL 署名入口：M5 Task 18 数据来源/许可弹窗（与 Natural Earth / Copernicus / REMA 一同常驻）。

raw/ 不进 git 的理由：原始字体 ~17MB 远超仓库可接受体积；
子集化后仅保留所需字形（M4 数十字），产物数 KB，无需提交原始资产。
任何人 clone 仓库后跑 `pnpm gen:font:fetch && pnpm gen:font` 即可复现。
