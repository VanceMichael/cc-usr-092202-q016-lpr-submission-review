# LPR报价报送审查

全国银行间同业拆借中心侧的报价报送审查后台领域逻辑：分别受理一年期与五年期以上报价，保存机构资格、报送窗口、数据来源说明、修订理由与审核意见；截止前更正形成新版本，截止后补报不进入当期计算；缺报、重复报送和单位错误阻断冻结；剔除与恢复双人确认并留下当时规则；机构只能查看自身材料。最终冻结包完整列出纳入范围、排除理由与签署记录，使正式报价形成过程可复核，且不提前泄露其他机构数据。

## 业务规则要点

- **分期限保存**：`1Y`（一年期）与 `5Y+`（五年期以上）分别建槽，每条报送保存数值、单位、来源说明、来件渠道与时间。
- **报送窗口**：窗口开启前来件拒收；截止前内容变更须填修订理由并生成新版本，旧版本留痕；截止后来件一律登记为 `late-registered`，不进入当期计算，也不能补齐缺报。
- **格式校验**：仅接受百分数（如 `3.10`），基点（`310bp`）、小数（`0.031`）、非 0.05 步长、越界、缺来源说明均标记错误码；格式错误版本会阻断冻结，截止前更正可解除。
- **重复报送**：同一机构同一期限内容完全相同的再次来件挂为 `duplicate`，阻断冻结，须双人认定作废（`VOID_DUPLICATE`）后才放行。
- **异常提示**：以同期限当前有效报价中位数为基准，偏离达阈值仅提示（warn/severe），不自动剔除；剔除须核实理由并双人确认。
- **回避分派**：审核员登记其利害关系机构，`suggestReviewerPair` 只分派无利害关系的两人；提出与确认不得为同一人。
- **双人确认**：剔除（`EXCLUDE`）、恢复（`RESTORE`）、重复作废（`VOID_DUPLICATE`）均经“提出—另一人确认”，记录理由、时间、签署人和**当时规则快照版本**。
- **冻结阻断**：缺报、单位/格式错误、重复未认定、待确认处置、法定数量不足均返回阻断项清单，无法冻结；冻结后拒绝一切变更。
- **隔离**：`institutionView` 只返回本机构版本、审核意见与备查登记；无资格机构来件进入隔离登记，不产生任何机构材料；冻结包（含其他机构数据、摘要）仅中心审核与审计可取。
- **冻结包**：含周期、规则快照、法定数量核对、纳入清单、排除清单（逐类理由码）、异常提示、全版本审计轨迹、签署台账和 SHA-256 规范序列化摘要。

排除理由码：`SUPERSEDED_BY_REVISION`、`FORMAT_ERROR_SUPERSEDED`、`REVIEW_EXCLUDED`、`DUPLICATE_VOIDED`、`AFTER_DEADLINE_REGISTER_ONLY`。

## 目录说明

- `src/rules.js` — 期限、单位、精度、区间、异常阈值、法定数量等**当期规则快照**与单条报价格式校验。
- `src/review.js` — 审查会话：受理、版本、窗口、重复/补报隔离、异常提示、回避分派、双人确认、冻结阻断、冻结包与机构视角。
- `src/load-sample.js` — 按来件时间回放公开样例（邮件与表格统一入口）。
- `src/records.js` — 共享领域资料读取与基本结构校验。
- `fixtures/context.json` — 领域角色、事实、约束与记录种类（公开资料，无真实数据）。
- `fixtures/quote-sample.json` — 报价周期样例：13 家虚拟机构，覆盖正常报送、单位错误截止前更正、邮件/表格重复、异常值双人剔除、截止后补报、无资格与不明期限来件。
- `contracts/domain.schema.json`、`contracts/quote-sample.schema.json` — 领域资料与报价样例的字段契约。
- `test/` — 25 项测试：格式校验、受理/窗口/版本、回避与双人确认、各类冻结阻断、冻结包可复核性、机构隔离、样例端到端回放。

样例与测试均为虚拟数据，不含账号、密钥或连接凭据。

## 本地检查

```bash
npm test
```

## 最小用法

```js
import { createReviewSession } from './src/review.js';

const session = createReviewSession({ cycle, roster, reviewers });
session.submit({ institutionId: 'BANK01', tenor: '1Y', value: 3.1, unit: 'percent', sourceDescription: 'FTP模型' });
const blockers = session.freezeBlockers();          // 阻断项清单
const { frozen, package: pkg } = session.freeze({ operatorId: 'rv-zhang' });
const own = session.institutionView('BANK01');      // 机构仅见自身材料
```
