# 飞控令牌移交复核服务

面向飞控维护审查员的受限脚本线性令牌流复核台。审查员在网页粘贴**仅含
令牌声明（`token`）、`consume`、`let`、匿名函数、调用、`if`** 的受限脚本并提交复核。

## 受限文法

```
P := S*
S := token <ident> ';'
   | consume <ident> ';'
   | let <ident> '=' E ';'
   | <ident> '(' args? ')' ';'
E := <ident>
   | <ident> '(' args? ')'
   | function '(' params? ')' '{' S* '}'
   | if '(' <ident> ')' '{' S* '}' else '{' S* '}'
```

## 判定语义

| 主题 | 规则 |
|---|---|
| 规范类型 | 每个 `token` 产生一个物理令牌，类型为 `令牌(<名>)`；`let`/形参都是别名 |
| 唯一消费 | 每条可达路径上每个物理令牌**恰好**消费一次，结束时不允许遗留 |
| let 多态 | 匿名函数无标注，每次调用按实参令牌类型实例化形参，同一函数可用不同类型实参复用 |
| 实参/返回统一 | 形参别名实参物理令牌；函数结束时仍存活的调用引入令牌构成**返回剩余集合**，可经 `let r = f(x); consume r;` 移交 |
| 分支剩余集合 | 两个可达分支：消费数量相同 **且** 结束时可见剩余令牌多重集合按规范类型一致，否则拒绝（`BRANCH_MISMATCH`）并说明 `then/else` 的消费数与剩余集合 |
| 不可达分支 | 守卫令牌在分叉前已被消费 ⇒ 真分支不可达，仅按可达的假分支裁决（不可达分支的错误不阻断） |
| 闭包捕获 | 匿名函数按词法捕获外层令牌；闭包内消费后外层再消费 ⇒ `DOUBLE_CONSUME`，**页面与接口返回同一份**变量跨度（声明→末次消费）与冲突路径（声明→捕获→首次→再次） |
| 结论固定保存 | 结论与输入摘要（SHA-256）、审计标识固定保存；重开可读回**原类型、消费映射、拒因** |
| 幂等 | 相同输入摘要 + 同一标识重传 ⇒ 返回原结论（`reused=true`），不改写 |
| 标识复用 | 不同输入复用已绑定标识 ⇒ `409 AUDIT_ID_REUSED`，**绝不改写旧结论** |

审计标识可自行指定（字母数字及 `._-`），留空时由输入摘要派生 `AUD-<sha256前12位>`。

## 本地运行

```sh
npm test          # 代码测试
sh scripts/build.sh
npm start         # http://localhost:8080  复核页 /  健康端点 /healthz
sh scripts/verify.sh   # 一次性验收：测试 → 构建 → HTTP/API 冒烟，以退出码报告
```

## Docker Compose（推荐操作方式）

```sh
# 长期服务：可配置宿主端口
HOST_PORT=9090 docker compose up -d --build
# 访问 http://localhost:9090/         复核页
#      http://localhost:9090/healthz  健康端点

# 一次性验收服务（执行后退出，以退出码报告验收结果）
docker compose --profile acceptance run --rm --build verify
echo $?   # 0 表示全部通过
```

数据保存在命名卷 `review-data` 的 `conclusions.json`，重启/重开可按审计标识读回。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/reviews` | 提交脚本（`{script, auditId?}`），201 保存；同内容重传 200 `reused`；不同内容同标识 409 |
| GET | `/api/reviews/:id` | 按审计标识读回完整结论 |
| GET | `/api/reviews` | 已保存记录概览 |
| GET | `/healthz`、`/health` | 健康端点 |
| GET | `/` | 复核页 |

## 项目结构

```
src/parser.js    词法/语法分析
src/analyzer.js  线性令牌流分析（别名、捕获、分叉合一、let 多态）
src/review.js    复核门面：解析/分析 -> 规范结论
src/store.js     结论固定保存（原子写、重开读回）
src/server.js    HTTP 服务（页面 + API + 健康端点）
src/public/index.html  复核页
test/            20 项代码测试
scripts/verify.sh      一次性验收入口（名为 verify）
scripts/smoke.js       HTTP/API 冒烟（含重启读回）
scripts/build.sh       构建校验
```
