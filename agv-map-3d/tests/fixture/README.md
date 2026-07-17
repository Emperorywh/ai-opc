# fixture — 固定回归样本

存放 SPEC 第 2 章样本身份黄金值与第 2.6 节固定回归样例的 ID、坐标、期望值等数据。

- `sampleBaseline.ts`：集中存放 SPEC 2.1–2.6 的固定身份常量（响应元数据、数量、类型分布、source bounds、数据质量基线、中文字符集合与第 2.6 节固定实体）。回归测试从受校验数据推导实际值，再与这些黄金值交叉比对，禁止硬编码伪造通过结果。
- 单元测试通过完整 ID 与数据特征交叉查询，禁止依赖数组下标。
- SHA-256 哈希常量不在此处，由构建期 `scripts/sample-supply-chain.mjs` 的 `EXPECTED_SAMPLE_SHA256` 提供，测试直接导入。
- SPEC 2.4 重合轨迹/双车道计数依赖轨迹 canonical 分组算法，待后续几何 TASK 落地后补齐对应 fixture。
