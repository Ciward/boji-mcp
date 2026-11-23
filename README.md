# Boji · 个人饮食与健康账本

把午餐照片发给你常用的 AI，告诉它「米饭只吃了一半」，再打开 Boji 的网页，就能看到这顿饭记了哪些食物、按多少份量计算。第二天吃同一款便当时，助手可以查到你上次核实的规格和营养标签。

Boji 是单人自托管服务。你可以只用网页记餐，也可以把支持远程 MCP 和 OAuth 的 AI 客户端接进来。客户端负责看图、读标签和估算，Boji 负责保存记录、修订历史和按日汇总。当前仓库包版本为 `0.2.0`。[项目详解](docs/项目详解.md)

首版源码采用 PolyForm Noncommercial 1.0.0。欢迎个人非商业自托管、修改和分享；第三方收费托管或集成到商业产品须另获授权。完整许可范围见 [LICENSE](LICENSE)。

## 一句话让 Agent 部署

你需要一台可以长期运行服务的托管服务器、供 Agent 使用的部署权限，以及一个 AI 客户端能访问的 HTTPS 地址。可以用自己的域名，也可以用托管平台提供的固定地址。准备好后，把下面这句话交给有终端能力的部署 Agent，替换两个尖括号中的内容即可。

> 请按 https://github.com/Ciward/boji-mcp 的 README，把 Boji 部署到我的服务器 `<SSH 别名或部署目标>`，使用 `<公开 HTTPS 地址>`，验证服务和 OAuth 发现后，给我网页地址、管理密码的安全获取方式、MCP 地址，以及连接 AI 客户端并验证第一条工具调用的步骤。

**给部署 Agent 的执行说明**

1. 确认目标主机、持久磁盘、可用端口和 HTTPS 入口。复用已授权的服务器连接与反向代理。如果已有 Boji 实例，先核对数据目录和已有配置，并备份后再升级。
2. 首次安装推荐使用仓库根目录的 `compose.yaml`。在服务器专用目录克隆源码，设置权限为 `0600` 的 `.env`，写入 `BOJI_PUBLIC_URL`（完整 HTTPS origin）、`BOJI_TIMEZONE`（用户时区）和 `BOJI_ADMIN_PASSWORD`（首次安装可用 `openssl rand -hex 32` 生成并直接写入文件）。创建持久化 `data/` 目录，确保容器 UID 1000 可写，执行 `docker compose up -d --build`。已有实例沿用原密码和数据。
3. 将公开地址下的所有路径转发至 Boji；同机反向代理可回源 `127.0.0.1:8787`，保留原始 Host。确认公网 `/healthz` 返回 `ok: true`，`/.well-known/oauth-authorization-server` 的 `issuer` 等于公开 origin，`/.well-known/oauth-protected-resource/mcp` 的 `resource` 指向公开 `/mcp`，未携带凭据的 `POST /mcp` 返回 `401`。
4. 交付实际网页地址、完整 `https://…/mcp` 地址、服务器上 `.env` 的位置和下面的客户端接入步骤。由账本主人在 Boji 授权页输入管理密码，聊天中只提供获取方式。若宿主登录需要本人操作，注明已通过的服务端检查，以及授权后要运行的 `boji_get_context` 验证指令。

## 从公开仓库运行自己的实例

生产服务器只需本仓库、实例配置和持久数据。建议把代码、账本和凭据放进三个独立目录。示例以 Linux 和 Docker Compose v2 为例。

```sh
git clone https://github.com/Ciward/boji-mcp.git /opt/boji
cd /opt/boji
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/boji
sudo install -d -m 0700 /etc/boji
```

首次安装可在 root shell 执行以下命令。将示例域名替换为本实例实际域名。`noclobber` 保护已有配置。

```sh
(umask 077; set -C; {
  echo 'BOJI_PUBLIC_URL=https://boji.example.org'
  echo 'BOJI_TIMEZONE=Asia/Shanghai'
  echo 'BOJI_DATA_PATH=/var/lib/boji'
  echo 'BOJI_ENV_FILE=/etc/boji/instance.env'
  echo 'COMPOSE_PROJECT_NAME=boji'
  printf 'BOJI_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)"
} > /etc/boji/instance.env)
cd /opt/boji
docker compose --env-file /etc/boji/instance.env up -d --build
curl -fsS http://127.0.0.1:8787/healthz
```

默认宿主端口为 `127.0.0.1:8787`，容器端口固定为 `8787`。如有特定的受限回源地址，在配置中设置 `BOJI_BIND_ADDRESS` 和 `BOJI_BIND_PORT`。`BOJI_DATA_PATH` 是宿主机持久目录，`BOJI_ENV_FILE` 是注入服务容器的配置文件。宿主和容器内的路径可以不同。

**可选 Cloudflare Tunnel。** 从 Cloudflare 的隧道管理页面获取 remotely-managed tunnel 的连接令牌。将令牌放在服务器上的 `/etc/boji/tunnel-token`，由 UID 1000 拥有，权限 `0400`。在 `instance.env` 添加 `BOJI_TUNNEL_TOKEN_FILE=/etc/boji/tunnel-token`。对于该隧道，把公开主机名路由的源站设为 `http://boji:8787`，保持原 Host。两个容器使用 Compose 服务名互相寻址。启用命令如下，后续升级也使用相同文件组合。

```sh
docker compose --env-file /etc/boji/instance.env -f compose.yaml -f compose.tunnel.yaml up -d --build
```

**接管已有实例。** 先对当前账本做 SQLite 在线备份，将原实例配置和部署版本留作回滚。将原 `BOJI_PUBLIC_URL`、`BOJI_PUBLIC_URL_ALIASES`、管理密码或其原 verifier、时区复用到新配置。把 `BOJI_DATA_PATH` 指向已有数据库所在目录，延用原监听地址、端口与隧道凭据。优先在隔离目录用备份测试恢复，切换时先停止旧服务，再启动公开库版本；同一数据库只由一个实例写入。若旧版隧道指向静态容器 IP，应在切换时把源站更新为 `http://boji:8787`。验证网页登录、已有授权和健康来源都能访问原账本。

**跟随社区更新。** 记录当前 `git rev-parse HEAD`，备份账本和实例配置，再运行 `git pull --ff-only`，使用原 Compose 参数执行 `up -d --build`。检查公网健康、OAuth 发现和一次已授权的只读调用。回滚时停止新服务，检出旧提交，将升级前的数据库快照恢复到独立空目录，再使用与快照匹配的原配置和版本启动；切换前保留升级后的数据以便补录。

## 先在本机记一餐

在仓库根目录运行以下命令。需要 Node.js 24 或以上版本及 npm。

```sh
npm ci
npm run setup
npm run build
npm start
```

1. 打开 `http://127.0.0.1:8787`，使用 `.env` 中的 `BOJI_ADMIN_PASSWORD` 登录。首次 setup 会生成随机密码。默认时区是 `Asia/Shanghai`，其他地区可在启动前修改 `BOJI_TIMEZONE`。
2. 在网页新增早餐，填一项有营养标签的食物，把知道的数值填进去。缺少的营养数据留空，日汇总会保留缺测信息。
3. 打开当日日记核对记录，试着修改份量，再看合计如何变化。账本默认保存在 `data/boji.sqlite`。

服务状态可通过 `curl http://127.0.0.1:8787/healthz` 查看。使用 Docker 时，先准备 `.env` 和可供容器用户 UID 1000 写入的 `data/`，再在根目录运行 `docker compose up -d --build`。根目录的 Compose 将端口绑定在主机回环地址。

## 把 AI 助手接进账本

给 Boji 配置 HTTPS 入口，将 `BOJI_PUBLIC_URL` 设为该入口的 origin，例如 `https://boji.example.org`，重新启动服务。在客户端添加 `https://boji.example.org/mcp`，选择 OAuth，在 Boji 授权页确认权限。先让助手执行一次只读操作，再试着写入。

> 请调用 `boji_get_context`，告诉我账本的日期和时区，然后查今天已经记录了哪些餐食。

> 帮我记午餐。这份便当的米饭吃了一半，其余吃完了。先查我的食物库，按实际份量记录，告诉我哪些营养值来自标签、哪些是估算。

收到保存回执后，可以在网页打开同一餐复核。如果再发餐后剩余的照片，请助手修订原餐。不同客户端的授权入口和可用能力取决于宿主。[接入、权限与故障排查](docs/implementation/接入与部署.md)

## 账本能保存什么

| 内容 | 使用方式 |
| --- | --- |
| 餐食和营养 | 每项食物保存本次整份的营养、实际食用比例、证据和可信度。服务端按比例计算一次，支持能量、蛋白质、碳水、脂肪、纤维、糖、钠和饱和脂肪。 |
| 常吃的食品和菜品 | 保存参考份量、品牌或餐厅、来源和核实时间。餐食保留当时的营养快照，日后修改食物库仍可追溯旧记录。 |
| Apple 健康数据 | 在网页创建来源，导入 Apple Health XML，或让 Health Auto Export 定期向设备专属接口推送支持的指标。网页显示最近接收时间和覆盖范围。 |
| 日记与趋势 | 查看当天已记录的摄入和近七日变化，可手工更正、移入回收站或恢复。无记录日期保留为空。 |

当前没有原生 iOS App、后台定时报告或内置模型推理。照片由接收它的 AI 客户端处理，使用外部客户端时应按其数据政策决定发送哪些内容。

## 数据与维护

- **备份与恢复**　构建完成后运行 `npm run backup -- /绝对备份目录` 生成 SQLite 一致性备份，其中含健康数据和授权记录。恢复到独立的空目录，核对记录后再切换。JSON 导出适合查看或分析账本数据。[恢复步骤](docs/implementation/接入与部署.md#备份恢复)
- **历史导入**　HTTP XML 上限为 20 MiB。更大的 Apple Health 导出可通过 `npm run import:health` 在数据库所在主机分批导入。[参数与数据覆盖](docs/implementation/健康接入契约.md)
- **本地开发**　运行 `npm run check`、`npm test` 和 `npm run build`。需要示例餐时，在独立演示数据目录运行 `BOJI_DATA_DIR=./data/demo npm run seed:demo -- --confirm-demo`，并用相同目录启动演示实例。

## 进一步阅读

- [项目详解](docs/项目详解.md) · [接口与数据模型](docs/implementation/API契约.md) · [授权契约](docs/implementation/授权契约.md)
- [个性化食物库与份量换算](docs/implementation/个性化食物库.md) · [Agent 工作流与提示词](docs/Agent工作流与提示词.md)
- [外部资料与兼容性依据](docs/资料来源与兼容性.md) · [长期设计与构想](docs/方案设计.md)
