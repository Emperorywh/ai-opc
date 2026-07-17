---
id: TASK-002
title: 建立可信样本供应链
---

## 任务描述

### 可验证结果

真实地图样本在进入开发或构建流程前必经 SHA-256 身份校验，并以原始字节生成唯一的本地运行副本。源样本、生成副本和浏览器运行时入口之间没有第二事实来源、备用地址或静默降级。

### 输入

- SPEC 第 2.1、3.1、4.1、14.1、15.1 和 16 章。
- `data/sampleMap.json` 及其固定字节数、行数和 SHA-256。
- TASK-001 交付的 npm 工程、验证命令、依赖边界和 Git checkpoint。

### 输出

- `predev` 与 `prebuild` 均执行的样本同步能力：先校验固定 SHA-256，再按原始字节复制到 SPEC 规定的本地生成路径。
- 生成副本被 Git 忽略，不可手工维护、不可提交，也不被视为新的事实来源。
- 应用运行时唯一允许请求 SPEC 规定的 `/generated/sampleMap.json`；不存在远程 API、备用 URL、内嵌样本或失败后的降级地图。
- 样本缺失、不可读或哈希不符时，以稳定错误语义和非零退出码阻止开发或构建继续执行；哈希不符必须使用 `SAMPLE_HASH_MISMATCH`。
- 覆盖成功复制、缺失文件、损坏内容和旧生成物不得被误用的自动化验证。

### 实现约束

- `data/sampleMap.json` 是唯一可编辑地图样本，校验值固定为 `DCE8427D3516E2F8F571AB66CF97D4A645939EE13CC62C7EB1A04846B376B813`。
- 复制必须保持字节完全一致，禁止解析后重新序列化、换行转换、压缩、格式化或字符编码重写。
- 哈希校验必须发生在复制之前；失败时不得保留或继续使用看似有效的旧生成副本。
- 供应链模块只负责身份校验和字节同步，不得顺带实现领域解析、几何推导或 UI fallback。
- 不得引入远程下载、备用样本、测试小样本替代真实样本或构建失败后的跳过开关。
- 新增或修改的代码必须使用多行简体中文注释说明源/生成物所有权、失败原子性和不可降级不变量；不得主动格式化无关代码。
- 自动化验证不得启动浏览器；运行时 URL 通过构建产物或静态契约检查验证。

### 验证方式

在 `C:\code\ai-opc\agv-map-3d` 中执行：

```powershell
$expected = 'DCE8427D3516E2F8F571AB66CF97D4A645939EE13CC62C7EB1A04846B376B813'
$source = (Get-FileHash -LiteralPath '.\data\sampleMap.json' -Algorithm SHA256).Hash
if ($source -ne $expected) { throw "源样本哈希不匹配：$source" }
npm test -- --run
npm run predev
npm run build
$generated = (Get-FileHash -LiteralPath '.\public\generated\sampleMap.json' -Algorithm SHA256).Hash
if ($generated -ne $expected) { throw "生成副本哈希不匹配：$generated" }
git -C .. check-ignore 'agv-map-3d/public/generated/sampleMap.json'
$tracked = git -C .. ls-files -- 'agv-map-3d/public/generated/sampleMap.json'
if ($tracked) { throw '生成副本不得被 Git 跟踪' }
```

正常路径：

- 源样本和构建生成副本哈希均与固定值一致。
- 构建成功且只生成本地运行副本。
- `git check-ignore` 成功，Git 跟踪查询返回空结果，证明生成副本未被跟踪。
- 自动化测试证明运行时入口只有 `/generated/sampleMap.json`。

关键异常路径：

- 自动化测试在临时数据中模拟单字节篡改、源文件缺失和不可读输入，预期同步及构建门禁非零退出；单字节篡改稳定报告 `SAMPLE_HASH_MISMATCH`。
- 预先放置旧生成副本后再模拟源样本哈希失败，预期旧副本不能使流程成功，也不能被当作可运行地图。
- 检测到备用 URL、内嵌地图或远程请求入口时，契约验证必须失败。

明确预期结果：只有通过固定哈希的源样本才能产生字节一致的本地副本；任何身份失败都在业务解析前终止流程。

### 完成标准

- 可信样本供应链及其异常闭环已经交付。
- 哈希、原始字节复制、生成物忽略和唯一运行时 URL 均有自动化证据。
- TASK-001 的安装、检查、测试和构建行为继续通过。
- 没有远程入口、备用数据、旧生成物复用、临时跳过或第二事实来源。
- 当前代码状态可在父级 Git 中仅以 `agv-map-3d` 子目录创建独立 checkpoint。
- 代码库可以安全进入 TASK-003。

### 回退边界

回退本 TASK 的 Git checkpoint 时，只移除样本哈希校验、同步与唯一运行入口契约；TASK-001 的工程基线保持可安装、可测试、可构建。被忽略的生成副本不属于 checkpoint，也不能影响此前状态。
