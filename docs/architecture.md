# 逆旅 · 架构说明（v2）

> 一个页面，一个光点，一生只走一次。

v1 是 60 秒小游戏，v2 把时间改成了现实时间：**现实 1 秒 = 游戏 1 秒，一生 30,000 天**。这一页解释它为什么能这样跑、服务器怎么相信时间、关掉网页后发生了什么。

---

## 0. 结论

| 层 | 选择 | 原因 |
| --- | --- | --- |
| 页面 | 纯静态 HTML/CSS/ES Modules，GitHub Pages | 打开即开始，后端挂了也能继续 |
| 规则 | `assets/js/life.js`，浏览器与服务器共用 | 同一套积分，同一个结果 |
| 时间 | **服务器时间 + 惰性结算** | 不需要常驻进程；离线的时间在下次访问时补上 |
| 账号 | GitHub OAuth | 不存密码、不碰邮箱 |
| 会话 | 随机 Bearer token，数据库只存哈希 | 跨站可靠，避开第三方 Cookie |
| 数据 | D1（或 SQLite） | 免费、SQL、可迁移 |
| 部署 | Pages + Worker | 没有常驻服务器 |

四条原则：

1. **时间是服务器说了算**：前端只做插值显示，不能把一天改成一年。
2. **一生只增不减**：时间、斜率、面积都只向前；没有回档。
3. **关掉网页不等于暂停**：`last_settled_at` 记着上一次结算，下一次访问补上。
4. **一个人可以有很多生，但同时只能有一生在走**。

---

## 1. 时间模型

时间单位是**现实秒**：

```text
DAY = 86,400 秒
LIFETIME = 30,000 天 = 2,592,000,000 秒
```

服务器不为每个用户跑定时器。它只在有人访问时结算：

```text
now = 服务器当前时间
delta = (now - account.last_settled_at) / 1000
delta = min(delta, 剩余寿命)
height1 = height0 + slope × delta
area += (height0 + height1) / 2 × delta
age += delta
last_settled_at = now
```

面积用梯形积分，因为在这一段时间里斜率不变，高度是线性变化的。

### 为什么不用 cron

- 82 年寿命、几万个用户，逐秒 tick 是浪费。
- 无服务器环境没有常驻进程。
- 惰性结算只依赖 `last_settled_at`，宕机、重启、换实例都不影响。
- 代价是：排行榜/别人的页面在没人访问前不会更新；对单人一生的游戏无所谓。

### 离线时间

用户关掉页面、换设备、隔一年回来：

- `last_settled_at` 还在。
- 下一次 `GET /api/account` 会一次性补上全部离线时间。
- 如果补到 30,000 天，账户在这一刻结束，`end_reason = lifespan`。

### 客户端插值

服务器每 20 秒轮询一次；两次之间，客户端用：

```text
predicted = settle(snapshot, now - snapshot_received_at)
```

右上角的数字因此每一帧都在动。服务器仍然是最终权威；下一次轮询会把误差抹平。

---

## 2. 一生的一生

```text
出生（第 0 天）
  │  斜率 0，面积 0
  │
  ├─ 努力：斜率 +Δ（越接近上限加得越少）
  │
  ├─ 快进：跳到目标天，按当前斜率补面积
  │
  ├─ 自然时间：每秒自动结算
  │
  ├─ 第 30,000 天：自动结束（lifespan）
  │
  └─ 结束：手动注销（manual）
        ↓
     status = 'ended'
     不能恢复；下一次登录开始新的一生
```

### 2.1 努力

- 客户端点「努力」，服务器生成一组箭头，存进 `efforts`。
- 没有倒计时；`effort` 不会过期。
- 提交时逐位比对；错一位，整个 effort `failed`，斜率不变。
- 对，才增加斜率：

```text
room = max(0, 1 - slope / 0.0012)
gain = 0.0001 × room
slope += gain
```

- 指令长度：`min(7, 2 + floor(efforts / 3))`。
- 输错后必须重新点「努力」；旧的 effort 不能复用。

### 2.2 快进

- 目标必须是整数天，`0 <= target <= 30000`。
- 只能向前：`target >= 当前 day`。
- 服务器先结算到现在，再按当前斜率补到目标天。
- 快进本身不改变斜率，只是把时间提前花掉。
- `target == 30000` 时，这一生在快进结束的瞬间注销。

### 2.3 结束

- 必须 `confirm: true`。
- 先结算到当前时刻，再 `status = 'ended'`、`end_reason = 'manual'`。
- 账户不能恢复；当前页面进入死亡状态（全黑）。
- 数据保留为墓碑，用于「一生」历史和未来的纪念/排名；如果以后要硬删除，另加接口。

### 2.4 30,000 天

- 服务器结算时一旦 `age >= LIFETIME`，就截断在 30,000 天，状态 `ended`，原因 `lifespan`。
- 之后任何动作返回 `409`。
- 客户端发现状态结束，进入死亡状态。

---

## 3. 一个用户，多个人生

```sql
CREATE UNIQUE INDEX idx_accounts_one_alive
  ON accounts(user_id) WHERE status = 'alive';
```

- 同一用户，最多一个 `alive`。
- 结束一个，可以开始下一个。
- 所有结束的账户保留在 `accounts`，通过 `GET /api/accounts` 可以列出。
- 前端只显示当前活着的那一个；不展示账户切换（页面要极简）。
- 「当前这一生」由服务器查 `status='alive'` 得到，不依赖浏览器记住 id。

### 为什么是部分唯一索引

数据库层保证「一人同时只有一生」，而不是靠应用代码检查。多标签页同时创建，只会有一个成功。

---

## 4. 数据模型

```sql
users(id, github_id, login, name, avatar_url, ...)
sessions(token_hash, user_id, expires_at, ...)
login_states(state, nonce, return_url, ...)
login_codes(code_hash, user_id, expires_at, used_at)

accounts(
  id, user_id, status,
  birth_at, ended_at, end_reason,
  last_settled_at,
  age_seconds, day, slope, height, area, efforts,
  seed, engine_version, version, meta_json,
  created_at, updated_at
)

account_events(
  id, account_id, type, at_age, at_ms, slope_after, payload_json
)

efforts(
  id, account_id, user_id, sequence_json,
  status, keys_json, created_at, completed_at
)
```

- `version`：乐观锁，多标签页/并发写入时重试。
- `account_events`：出生、努力、快进、结束都写一条。它是「以后所有玩法」的扩展点：新玩法只需要写事件，不必改主表。
- `meta_json`：未来物品、称号、心情等。
- `efforts`：一次努力一个答案；答案在服务器，客户端只负责敲。

索引：

- `accounts(user_id, status)`：当前一生。
- `account_events(account_id, at_age)`：画轨迹 / 回放。
- `efforts(account_id, created_at)`：限流 / 历史。

---

## 5. API

所有接口都需要登录（除 health / OAuth / dev login）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 引擎版本、特性、寿命 |
| GET | `/api/account` | 当前一生 + 事件 + `lastEnded` |
| POST | `/api/account` | 没有 alive 时创建；有则返回当前的 |
| GET | `/api/accounts` | 所有一生（含墓碑） |
| POST | `/api/account/efforts` | 开始一次努力，返回箭头 |
| POST | `/api/account/efforts/:id/complete` | 提交按键；对/错都返回 |
| POST | `/api/account/fast-forward` | `{targetDay}` |
| POST | `/api/account/end` | `{confirm:true}` |
| GET | `/api/account/events` | 事件流（预留） |
| GET | `/api/me` | 用户、alive、所有一生摘要 |

### 响应形状

```json
{
  "account": {
    "id": "a_...",
    "status": "alive",
    "birthAt": 1795...,
    "age": 123.4,
    "day": 0.0014,
    "slope": 0.0001,
    "height": 0.01,
    "area": 1.2,
    "efforts": 1,
    "endReason": null,
    "engineVersion": "2.0.0"
  },
  "events": [{ "type": "effort", "at": 10.2, "slope": 0.0001 }],
  "serverNow": 1795...
}
```

`events` 是画轨迹用的；`at` 是出生后的秒数。

---

## 6. 并发与一致性

### 6.1 乐观锁

每次更新：

```sql
UPDATE accounts SET ..., version = version + 1
WHERE id = ? AND version = ? AND status = 'alive'
```

- 影响 0 行 → 有人先写了 → 重新读、重新算、重试。
- 最多 4 次，仍失败返回 `409 account_busy`。

### 6.2 重复提交

- `efforts` 的状态只能从 `open` 变成 `done`/`failed` 一次。
- 两个标签页同时提交同一次努力，只有一个能 claim。
- 快进/结束都带 `version`，不会把别的动作覆盖掉。

### 6.3 创建

- 部分唯一索引兜底。
- 冲突时读取已有 alive 返回，不报错。

---

## 7. 安全与边界

| 攻击 | 防护 |
| --- | --- |
| 改前端年龄/面积 | 服务器不接受前端状态，只按服务器时间结算 |
| 快进到过去 | `target < day` → 400 |
| 快进超过 30000 | 400 |
| 改努力答案 | sequence 在服务器，客户端只拿到题目 |
| 重放 effort | 只能 open → 一次结束 |
| 改系统时间 | 服务器用 `Date.now()`，客户端时间只做插值 |
| 刷账号 | 每小时最多创建 10 个 |
| 刷努力 | 每小时最多 240 次 |
| SQL 注入 | 全部 prepared statement |
| 开放重定向 | return URL 必须在 `APP_ORIGIN` 白名单 |
| XSS | CSP、无第三方脚本、用户内容 textContent |
| 跨站 Cookie 限制 | 用 Bearer token，不用 Cookie |

### 防不住什么

- **本地模式可以随便改**：localStorage 里的这一生没有排名，只属于那台设备。
- **服务器模式可以自动化「努力」**：题目在服务器，但脚本能读题目、按键。这不会改分数，只会让斜率增长得更快。
- **多设备同时在线**：乐观锁保证不重复计时，但两个页面会各自插值；20 秒内可能看到细小差异，轮询后对齐。

---

## 8. 可靠性

| 故障 | 行为 |
| --- | --- |
| API 挂了 | 页面降级为本机模式（如果还没登录/加载） |
| 登录过期 | 前端清 token，回到本机模式；服务器那一生继续走 |
| 提交 effort 网络失败 | 面板关闭；可以重新点「努力」；服务器 effort 仍是 open，下一次开始时会作废旧的 |
| 快进/结束网络失败 | 不改变本地显示；按钮抖动；可重试 |
| 多标签页同时写 | version 冲突重试，最多 4 次 |
| 服务器时钟跳变 | 向前跳会补时间；向后跳 `delta=0`，不会倒扣 |
| 账户到寿命 | 自动 ended；页面死亡；下次新的一生 |
| 浏览器崩溃 | 服务器/本地时间在下次打开时补上 |

### 本地模式

- `localStorage` 存 `{life, lastSettledAt, events}`。
- 打开时按 `lastSettledAt` 补时间。
- 每 15 秒、页面隐藏、动作后保存。
- 结束后写 `status: ended`；同一个标签页刷新保持死亡，新标签页会开始新的一生。

---

## 9. 部署

### 9.1 页面

GitHub Pages，`main` / root，`.nojekyll`。

### 9.2 API（Cloudflare Worker + D1）

```bash
npx wrangler d1 create nilu
npx wrangler d1 execute nilu --file server/schema.sql --remote
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy
```

`wrangler.toml`：

- `APP_ORIGIN = "https://joffzxf.github.io"`
- `API_ORIGIN = "https://<worker>.workers.dev"`
- `GITHUB_CALLBACK_URL = "https://<worker>.workers.dev/api/auth/github/callback"`

### 9.3 OAuth App

- Homepage: `https://joffzxf.github.io/nilu/`
- Callback: 与 `GITHUB_CALLBACK_URL` 完全一致
- Scope: `read:user`

### 9.4 前端接上

`assets/js/config.js`：

```js
export const CONFIG = {
  apiBase: 'https://nilu-api.xxx.workers.dev',
  repoUrl: 'https://github.com/joffzxf/nilu',
  pagesUrl: 'https://joffzxf.github.io/nilu/',
};
```

页面探测 `/api/health`；成功才显示账号入口。

### 9.5 本地

```bash
cp .env.example .env
npm start
```

Node 同时托管静态文件和 API，SQLite 在 `data/nilu.db`。`DEV_AUTH=1` 时，点页面左上角的小圆点会用本地测试账号登录；不点就是本机模式。

---

## 10. 扩展点

现在只有「努力 / 快进 / 结束」三个动作，但接口已经为后续玩法留了位置：

1. **account_events**：新玩法只追加事件（`type`, `at_age`, `payload`），不改主表。
2. **meta_json**：物品、称号、关系、状态。
3. **efforts**：可以扩展成不同题型、不同长度、不同奖励。
4. **engine_version**：规则升级时冻结旧版本；历史一生仍可解释。
5. **accounts.status**：未来可以有 `archived`、`memorial` 等状态。
6. **events 接口**：以后可以做回放、轨迹卡、他人视角、赛季。
7. **多生**：已支持一个用户多个 ended 账户；未来可以加「选择哪一生」的入口。
8. **排行榜**：如果要，可以对 ended 账户按 area 排名；但当前页面刻意没有入口。

---

## 11. 取舍

- **真实时间很慢**：一个普通访问只能看到几秒钟的变化；所以有「快进」，也所以面积数字要能跳动（小数/大整数）。
- **没有文字**：没有标题、教程、图例。用户需要自己点一下才知道三个动作是什么；这是作品的一部分，不是疏忽。
- **软删除**：「注销」= 不能再用；数据库保留墓碑。好处是历史/未来排名；坏处是用户可能认为「注销」等于删除。若需要真删除，另加 `DELETE /api/account` 并匿名化。
- **没有 WebSocket**：20 秒轮询足够；真实时间游戏不需要毫秒同步。
- **没有排行榜入口**：v1 有；v2 页面只有三个动作。排名能力保留在数据层，未来再决定要不要。

---

## 12. 一句话

**时间不归前端管，死亡不可逆，关掉网页它也继续走。**
