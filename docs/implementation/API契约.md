# Boji API 与数据模型（schema 2 / workflow 0.2.0）

HTTP API 前缀为 `/api/v1`。当前 npm 包版本为 `0.2.0`，`boji_get_context` 返回 `schema_version: 2`、`workflow_version: "0.2.0"`。本文件描述仓库中的接口契约，不代表任一线上实例已部署或已通过宿主验收。

单用户实例以 SQLite 为规范账本，时间保存为 UTC ISO，日归属采用初始化时区（默认 Asia/Shanghai）。现有库改变时区会拒绝启动，须单独迁移历史日归属。

## 身份与权限

- Web 登录后使用 HttpOnly 会话 Cookie；读取 `GET /api/v1/session` 获得 `csrf_token`。修改请求须带 `X-CSRF-Token`，并通过来源校验。
- MCP 使用 OAuth 2.1 授权码与 PKCE S256，资源为 `<origin>/mcp`。读工具需要 `health.read`，写工具需要 `health.write`。动态注册不会自动授予健康数据权限。
- 设备使用各数据源独立的 Bearer token，只能向对应来源上传数据。

## 餐食与营养快照

`MealInput = {title, occurred_at, meal_type, notes, items}`。时间必须包含 UTC 偏移；餐别为 `breakfast|lunch|dinner|snack`；每餐包含 1–50 个食物条目。

餐食条目的字段为 `name, amount_g, consumed_fraction, nutrients, confidence, evidence, notes`，并可选带 `food_library_ref: {id, version}`。`amount_g` 描述本次端上/记录的整份重量；`nutrients` 也必须是本次整份的营养量。服务端仅计算 `nutrients × consumed_fraction` 一次，不能把已食用比例预先乘进营养值。

关联食物库时，创建餐食或为餐食新增/更换引用，必须引用当前仍活跃的最新食物库版本。修改旧餐时，如果原餐已含相同的 `{id, version}` 引用，可以保留该历史引用；否则过期版本或已归档条目会被拒绝。餐食自身保存名称、份量、营养和引用版本快照，后续修改或归档食物库不会重算或改写既往餐食。

营养字段为 `energy_kcal`、`protein_g`、`carbs_g`、`fat_g`、`fiber_g`、`sugar_g`、`sodium_mg`、`saturated_fat_g`。未知用 `null`，确认没有才用 `0`。合计是已知字段的小计，同时返回 `unknown_counts`；已知部分不能冒充完整摄入量。

餐食 `evidence` 为 `vision|label|weighed|database|manual`；`confidence` 为 `low|medium|high`。照片估算不能被描述成标签、数据库或官方数值。估算假设与范围写入 `notes`。

餐食返回 `id, version, totals, unknown_counts, deleted_at, created_at, updated_at`。营养值非负，全部未知的字段合计仍为 `null`；`amount_g` 不会再次乘入营养。

## 个性化食物库

食物库条目的写入字段为：

| 字段 | 类型与含义 |
| --- | --- |
| `kind` | `food` 或 `dish` |
| `name` | 食物或菜品名称 |
| `aliases` | 可选别名数组，最多 20 项 |
| `restaurant_name` | 餐厅/品牌名；独立食物可为 `null` |
| `variant` | 规格、口味或做法变体 |
| `serving_label` | 必填的参考份量描述，默认 `1份` |
| `amount_g` | 参考份量的克重；未知为 `null` |
| `nutrients` | 上述八个字段，描述一个 `serving_label` 的整份营养；未知为 `null` |
| `confidence` | `low\|medium\|high`，表示基线可信程度，不是统计概率 |
| `evidence` | `vision\|label\|weighed\|database\|manual\|web_research\|restaurant_menu` |
| `notes` | 研究摘要、来源说明、估算方法与限制，最多 2000 字符 |
| `source_urls` | 最多 10 个无凭证的 HTTP(S) 来源链接；网络查证或餐厅菜单依据至少需要一个链接 |
| `verified_at` | 最近核实时间，含时区；未知为 `null` |

服务端额外返回 `id, version, archived_at, created_at, updated_at`。`archived_at: null` 表示活跃条目。库条目只提供候选基线；每次记录仍须核对餐厅/品牌、规格、做法、参考份量、核实时间和来源。只有匹配时才能复用，并先把基线营养换算成本次整份的营养。

库条目 `evidence` 中的 `vision` 表示视觉估算来源，不表示官方营养数据。`web_research` 与 `restaurant_menu` 必须同时保存来源 URL；可核实的营养值才填写数字，不确定字段保留 `null`。MCP 不做网络检索或模型推理；检索由宿主完成，研究摘要写入 `notes`。

活跃条目身份按 `kind + normalized(name) + normalized(restaurant_name) + normalized(variant) + normalized(serving_label)` 判断。身份字段先做 NFKC、大小写与空白规范化，保留小数点和其他有意义的标点。相同身份的活跃条目创建或更新时，REST 返回 `409 duplicate_food`，MCP 返回 `isError:true` 与 `error.code: duplicate_food`，应先搜索并读取现有条目再更新。版本不匹配返回 `409 version_conflict`；新餐食引用的库条目版本已变化或已归档时返回 `409 food_library_version_conflict`。无效引用版本返回 `400 invalid_food_reference`。

创建、更新、归档、恢复都保留条目历史。归档为软状态变更，更新或归档不会影响已有餐食快照；恢复时若活跃库中已有相同身份条目，也会因重复而拒绝。

## HTTP 路由

下表路径均以 `/api/v1` 为前缀，并由 Web 会话认证；修改还须通过 CSRF 校验。

| 方法 | 路径 | 请求或结果 |
| --- | --- | --- |
| GET | `/context` | 当前时间、时区、日期、`schema_version`、`workflow_version`、工作流提示 |
| GET | `/meals?date=YYYY-MM-DD&deleted=false&limit=100&offset=0` | 分页餐食 `items/total/has_more/next_offset` |
| POST | `/meals` | `{idempotency_key, meal}` → `{persisted, meal, data_revision}` |
| GET | `/meals/:id` | `{meal}`，含版本和删除状态 |
| PUT | `/meals/:id` | `{idempotency_key, expected_version, meal}`，完整替换并保留历史 |
| POST | `/meals/:id/delete`、`/restore` | `{idempotency_key, expected_version}`，软删除或恢复 |
| GET | `/meals/:id/history` | 餐食修订快照与操作者 |
| GET | `/summary?date=YYYY-MM-DD` | 已记录营养合计、缺测及健康来源数据 |
| GET | `/trends?days=7` | 最近 1–90 天记录；无记录日期为 `null` |
| GET | `/foods?query=&archived=false&limit=20&offset=0` | 搜索并分页返回 `items/total/has_more/next_offset` |
| GET | `/foods/:id` | `{item}` 当前库条目和版本 |
| GET | `/foods/:id/history` | 条目修订历史及每版快照 |
| POST | `/foods` | `{idempotency_key, item}` → `{persisted, item, data_revision}` |
| PUT | `/foods/:id` | `{idempotency_key, expected_version, item}`，完整替换并保留历史 |
| POST | `/foods/:id/delete`、`/restore` | `{idempotency_key, expected_version}`，归档或恢复 |
| GET | `/export` | JSON 导出，包含餐食与历史、食物库与历史、健康数据 |

`/foods` 的 `query` 可空，`kind` 可选为 `food|dish`，`restaurant_name` 可选，`archived` 默认为 `false`，`limit` 为 1–50（默认 20），`offset` 为 0–100000 的整数分页偏移（默认 0）。省略可选筛选字段，不用空字符串代替 `kind` 或 `restaurant_name`。归档条目通过 `archived=true` 查询。

## MCP 工具与幂等

既有十个餐食/健康工具为：`boji_get_context`、`boji_record_meal`、`boji_get_meal`、`boji_list_meals`、`boji_update_meal`、`boji_delete_meal`、`boji_restore_meal`、`boji_get_summary`、`boji_get_source_status`、`boji_get_trends`。v0.2.0 食物库核心契约新增六个工具，合计 16 个核心工具：

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `boji_search_food_library` | `health.read` | 按名称/别名、类型、餐厅和归档状态搜索；`limit` 默认为 20 |
| `boji_get_food_library_item` | `health.read` | 按 `id` 读取当前版本；修改前先读取 |
| `boji_record_food_library_item` | `health.write` | 新增基线，参数为 `{idempotency_key, item}` |
| `boji_update_food_library_item` | `health.write` | 更新基线，参数含 `id, expected_version, idempotency_key, item` |
| `boji_delete_food_library_item` | `health.write` | 用户明确要求时归档，参数含 `id, expected_version, idempotency_key` |
| `boji_restore_food_library_item` | `health.write` | 恢复归档条目，参数含 `id, expected_version, idempotency_key` |

`boji_search_food_library` 参数为 `{query?, kind?, restaurant_name?, archived?, limit?, offset?}`：`query` 可空且默认 `""`，`kind` 可选为 `food|dish`，`restaurant_name` 可选，`archived` 默认 `false`，`limit` 为 1–50、默认 20，`offset` 为 0–100000、默认 0；`boji_get_food_library_item` 参数为 `{id}`。ID 为 UUID，版本为正整数。

当前 MCP 共暴露 16 个工具；食物库历史可从 Web 查看或调用 REST `GET /foods/:id/history`。工具回执同时提供文本和结构化结果，错误须检查 `isError` 与结构化错误码；上文 400/409 是 REST HTTP 状态，MCP 返回对应领域错误码。入口不提供 SQL、Shell 或任意文件访问。主动调度、`run_checkin`、`complete_checkin`、原图传输与 iOS 尚未实现。

所有写入使用 `idempotency_key`，同一 key 只能重试相同内容；同键不同内容返回冲突。每次新逻辑写入使用新 key。`expected_version` 必须来自刚读取的当前版本；冲突后重新读取并合并，不用旧草稿覆盖。只有 `persisted: true` 才表示写入已持久化。

## 迁移、导出与备份

schema 2 新增 `food_library` 和 `food_library_history`，条目历史包含版本、操作、操作者、时间与快照。JSON `/export` 导出活跃和已归档条目及其历史。`npm run backup` 通过 SQLite 在线备份 API 生成一致数据库快照，因此也包含食物库与全部历史；不能在服务运行时只复制主 DB 文件。备份可能包含健康数据、授权记录和个人食物记录，应限制访问。

迁移表记录 schema 版本；认证和健康模块分别使用 `auth_*` 与 `health_*` 表。升级前先备份并验证恢复，破坏性 schema 变更须新增迁移。JSON 导出不包含密码或认证 token，用于可读迁出；当前没有 JSON 全库恢复工具。SQLite 备份包含授权记录，恢复到不同公开域名须重新授权。
