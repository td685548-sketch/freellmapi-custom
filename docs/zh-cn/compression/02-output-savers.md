[English](../../en/compression/02-output-savers.md) · **简体中文**

# 输出节省器（caveman 与 ponytail）

[← 返回 README](../README.md) · [文档索引](../README.md) · [API 参考](../api/01-rest-api.md)

压缩缩减你**发出去**的内容，两个输出节省器则缩减**返回**的内容：它们在对话前加一条固定的
风格指令，让模型用更少的词回答（`caveman`）、写更少的代码（`ponytail`）。两者都**默认关闭**，
并且都不改动路由、提供方选择、工具或对话本身 —— 只改动回答的冗长程度。

## 两个节省器

| 节省器 | 改动什么 |
| --- | --- |
| `caveman` | 散文的简洁度。废话、含糊措辞和客套话先去，随等级加深句子层面的压缩。 |
| `ponytail` | 代码的极简度。模型在写任何东西之前先走一遍梯子 —— 这东西需要存在吗、标准库有吗、平台原生能力覆盖吗、一行够吗 —— 并交出它所能的代码最短的 diff。 |

各自都有一个等级：

| 等级 | `caveman` | `ponytail` |
| --- | --- | --- |
| `off` | 不注入任何内容。这是默认值；请求头无法开启操作者保持关闭的节省器。 | 不注入任何内容。 |
| `lite` | 简洁但合乎语法：完整句子，去掉废话。 | 按用户要求构建，同时用一行点出更懒的替代方案；由你决定。 |
| `full` | 穴居人式压缩：冠词和含糊措辞消失，片段可以接受，每个技术术语保持精确。 | 强制走梯子 —— 标准库和原生能力优先，最短 diff，最短解释。 |
| `ultra` | 极限压缩；一个词够用就只用一个词。 | YAGNI 极端派：先删再加，交出那一行代码，并在同一个回答里质疑剩下的需求。 |

两个节省器的每个等级都带同样的护栏，所以简洁从不牺牲正确性：代码块、文件路径、命令、错误串
和 URL 保持精确；安全警告、不可逆操作的确认和多步顺序流程回到正常散文；保留用户的主导语言；
不臆造缩写；风格也永远不在回答里自我宣告。`ponytail` 绝不会简化掉信任边界的输入校验、防数据
丢失的错误处理、安全、无障碍，或任何被明确要求的东西。

指令文本是源码里的常量（`server/src/custom/output-savers/prompts.ts`，按 MIT 改编自 9Router）。
设置 API 和请求头都无法把任意文本放进被注入的系统消息 —— 你选的是等级，不是提示词。

## 启用它

用环境变量引导：

```env
FREELLMAPI_CAVEMAN=full
FREELLMAPI_PONYTAIL=lite
```

或在运行时修改，无需重启：

```bash
curl -X PUT http://localhost:3000/api/savers \
  -H "Authorization: Bearer <仪表盘会话令牌>" \
  -H "Content-Type: application/json" \
  -d '{"caveman":"full","ponytail":"off"}'
```

`GET /api/savers` 读取同一个视图。已认证的管理端客户端可以用这两个接口；写操作需要系统设置
能力（`manage_compression` 叶子权限或 `manage_settings` 父权限），读取对任何登录账号开放，
好让状态视图能显示当前生效的是什么。

节省器暂时没有仪表盘页面 —— API 加那两个环境变量就是完整的控制面。

## 逐请求控制

在任何聊天请求上发 `X-FreeLLM-Saver`：

```text
X-FreeLLM-Saver: off
X-FreeLLM-Saver: lite
X-FreeLLM-Saver: caveman=off
X-FreeLLM-Saver: caveman=lite,ponytail=off
```

`off` 让本次请求绕过两个节省器，裸等级是两者的**上限**，`name=level` 只设一个节省器。请求头
可以降低或关闭某个节省器，但既不能提高等级，也不能打开操作者保持关闭的节省器 —— 和
`X-FreeLLM-Compress` 同样的单向规则。无法解析的值会被忽略，配置好的等级照旧生效。

## 文本落在哪里

* 在 `messages` 最前面加**一条新的**系统消息。调用方自己的系统消息绝不被编辑，所以发送完全
  相同前缀的智能体能保住提供方侧的提示词缓存命中。
* 客户端配置档强制的系统提示词仍在最前：强制提示词、然后节省器、然后调用方的系统消息。
* 注入发生在压缩**之后**，所以节省器自己的文本绝不会被压缩掉，压缩统计数据也仍然只描述你的
  载荷。
* 这段文本是 `messages` 的一部分，所以词元估算、上下文窗口预算和响应缓存键都看得到它。缓存里
  的简洁回答绝不会被重放给一个没有要求它的请求。
* 它是幂等的：重试或重放时，已经带上这段文本的请求体不会被二次注入。
* 失败即放开（fail-open）。任何意外都让对话保持原样 —— 风格上的小优化绝不能成为请求失败的原因。

节省器跑在每条聊天线路上：`/v1/chat/completions`、遗留的 `/v1/completions`、`/v1/responses`、
`/v1/messages`（Anthropic），以及 Gemini 的 `generateContent` / `streamGenerateContent`。
词元计数接口刻意不做节省：它们应当报告调用方实际发送的内容。

## 它的代价

节省器开着时，这段文本会注入**每一个**请求，长度从几百到几千字符不等。`GET /api/savers`
会报告它：

```json
{
  "caveman": "full",
  "ponytail": "lite",
  "sources": { "caveman": "setting", "ponytail": "env" },
  "injectedChars": 3182
}
```

`sources` 说明每个等级来自哪里（`setting`、`env` 或 `default`），`injectedChars` 是一个请求
现在多带的字符数 —— 用别处同样的 `chars / 4` 估算就能换成词元。相对回答缩短 30–50% 而言
这通常是划算的，但在一个一行的问题上它是纯开销：这就是逐请求请求头的用途。

## 相关

- [01-compression-pipeline.md](01-compression-pipeline.md) —— 同一笔预算的输入侧那一半。
- [../api/01-rest-api.md](../api/01-rest-api.md) —— 请求与响应头。
- [../env/01-variables.md](../env/01-variables.md) —— `FREELLMAPI_CAVEMAN` 与 `FREELLMAPI_PONYTAIL`。
