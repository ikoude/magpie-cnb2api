# 安全说明

## 这个插件会接触哪些凭据

| 凭据 | 存哪 | 谁能读到 |
|---|---|---|
| CNB 访问令牌 | magpie 的数据目录（`~/.config/magpie` 下的凭据文件），由 magpie 以本机用户权限读写 | 本机同一用户 |
| `PROXY_KEY` | 同上；它同时是调用方访问 `/v1` 的口令 | 本机同一用户 |

插件本身**不建立任何外部连接**，只访问 CNB OpenAPI（`https://api.cnb.cool`）与工作区地址；
不向第三方上报数据，不含遥测。

## 令牌权限

插件需要的权限按 README 5.3 的要求勾选即可，**不需要**仓库写权限以外的授权。
令牌应视为等同 CNB 账号密码：不要提交到仓库、不要贴进 issue、不要放在共享机器上。

## 日志与截图

- 工作区地址默认打码（保留首尾字符），避免把可访问的实例地址完整暴露在日志与面板里。
- 提交 issue 前请检查截图中是否含真实的组织名、仓库名、实例编号或令牌；
  需要说明结构时，用 `alice` / `acme` / `acme/gateway` 这类示例值替换。

## 报告问题

发现安全问题时，请不要开公开 issue。请到仓库的 **Security** 标签页，
用 *Report a vulnerability* 发起私密报告（GitHub Security Advisory），
说明影响范围与复现步骤，我会在确认后发布修复版本并在 CHANGELOG 中注明。

## 支持范围

只对最新版本提供安全修复。旧版本请先升级：`magpie plugin add github:ikoude/magpie-cnb2api`。
