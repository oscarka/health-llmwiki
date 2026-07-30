# OpenClaw Memory & User Context 机制调研

## 结论速览

OpenClaw 有**两套完全不同的东西**，很容易混淆：

| 机制 | 类比 | 每次都注入 system prompt？ |
|------|------|---|
| Workspace 文件（AGENTS.md、USER.md 等） | 固定的便签纸 | ✅ 每次都注入 |
| memory/ 文件夹（memory/2026-07-30.md）| 笔记本 | ❌ 只搜索相关片段再注入 |

**不是一个东西。** 下面逐一解释。

---

## 第一层：Workspace 文件（USER.md 等）— 固定注入

### 文件清单（`workspace.ts` L33-40）

| 文件名 | 类型 | 描述 |
|--------|------|------|
| `AGENTS.md` | 必须 | Agent 的行为指令 |
| `SOUL.md` | 可选 | Agent 的"灵魂"、个性 |
| `TOOLS.md` | 必须 | 工具使用规范 |
| `IDENTITY.md` | 可选 | Agent 身份设定 |
| **`USER.md`** | **可选** | **用户信息（就是我们要的 notes）** |
| `HEARTBEAT.md` | 可选 | 定期任务指引 |
| `BOOTSTRAP.md` | 必须 | 首次引导说明 |
| `memory/` | 自动 | 按日期的记忆文件（另一套机制，见第二层）|

### 工作方式

**每次 agent 运行时，这些文件全部读取、全部塞进 system prompt。** 不筛选，不搜索，一股脑放进去。

> 类比：进屋之前先读一遍门口贴的便签纸，每次都读，固定的。

所以这些文件**要短**，不然 system prompt 会很长。OpenClaw 限制单个文件最大 2MB，实际建议几 KB。

**`USER.md` 就是 OpenClaw 的 "notes" 机制。** 一个自由格式的 Markdown 文件，写这个用户的背景信息，每次都注入。

---

## 第二层：memory/ 文件夹 — agent 主动写入 + 向量搜索按需检索

### 这套机制的完整流程（重要！要分清楚三步）

```
【Step 1: 触发写入】
当一次会话的 context window 快满时，触发 compaction（压缩），
compaction 之前先运行 pre-compaction memory flush：
  → agent 专门读一遍本次会话的重要内容，
  → 把认为值得保留的信息 append 到 memory/今天日期.md
  → 写入是 append-only，只追加，不覆盖
  → 原始聊天记录被压缩摘要，释放 context 空间

【Step 2: 向量索引同步】
- memory/*.md 文件的内容被切成约 400 token 的片段
- 每片用 embedding 模型向量化，存入 SQLite 数据库
- 不是一直在同步，满足以下条件之一才同步：
    * 每次会话开始时（onSessionStart: true）
    * 搜索时（onSearch: true）
    * 文件变化时监听到（watch: true）

【Step 3: 检索时注入】
每次新对话开始，agent 根据当前问题做向量搜索，
从 SQLite 向量库里取最相关的 6 条（默认），拼进 system prompt。
不是把所有 memory 文件都注入，是按需检索。
```

### 回答你的具体问题

**Q：超过 100k 或 50 条就执行一次记忆书写（写 .md 文件）吗？**

A：**不是。** 这两个阈值跟 memory 文件写入完全无关。Memory 文件的写入是由 **context window 快满时的 compaction（压缩）** 驱动的，跟 100k/50条无关。

那 100k / 50条 是什么？是控制**"会话历史（聊天记录本身）什么时候被同步进向量索引"**的阈值。具体来说：如果把 `sources` 设置为包含 `"sessions"`（会话历史作为向量来源），那么当会话积累了 100k 字节或 50 条新消息时，才把这段新增历史向量化进检索库。这是一个可选的增强功能，默认不开启。

**Q：每天一个 .md 文档会一直记录没有压缩吗？**

A：.md 文件本身**不压缩**，只会一直 append（追加）。今天的 `memory/2026-07-30.md` 可以被 append 很多次，每次 compaction 都往里追加一段。但真正起作用的不是原始 .md 文件，而是**向量索引**——.md 内容被分块后向量化存入 SQLite，查询时搜向量库而不是直接读 .md 文件。

**Q：如果每天不够 100k 或者 50 条呢？**

A：不影响 memory 文件写入（写入触发条件是 context 压满，跟这两个数字无关）。至于会话历史向量同步，不满足就先不同步，下次满足时再同步。对大多数用户（每天消息不多）来说，会话历史可能很少被向量化，但手动或 agent 写进 memory/*.md 里的内容照常被索引，不受影响。

**Q：向量读取是读取这么多 .md 文档吗？**

A：不是直接读 .md 文档。所有 .md 文档已经被预处理成向量存在 SQLite 里了。查询时是在向量数据库里做相似度搜索，速度很快。只有当 .md 文件有新内容追加时，才触发增量同步到向量库。有 100 个 memory 文件也没关系，搜索照样很快。

**Q：每次 system prompt 不会都把所有 .md 文档都用一遍吧？**

A：**不会。** memory/ 下的文件**不直接注入 system prompt**，而是：
1. 根据当前用户发的这条消息，在向量库里做相似度搜索
2. 返回最相关的最多 **6 条**片段（每条约 400 tokens，默认最低相似度 0.35）
3. 只把这 6 条片段拼进 system prompt

就算有 365 个 memory 文件（一年每天一个），也只注入最相关的 6 条。

### 文件结构示意

```
~/.openclaw/workspace/
├── AGENTS.md          ← 每次全文注入 system prompt（固定便签）
├── USER.md            ← 每次全文注入 system prompt（用户信息备忘）
├── memory/
│   ├── 2026-01-15.md  ← agent 历史 append 的，向量化后按需检索
│   ├── 2026-03-07.md
│   └── 2026-07-30.md  ← 今天的，还在追加中
└── .openclaw/
    └── memory.db      ← SQLite，存所有 memory/*.md 的向量索引
```

---

## 第三层：会话历史作为向量源（实验性，默认关闭）

`memory-search.ts` 的 `sources` 配置支持 `"sessions"` 值（需手动开启），即把历史会话记录也向量化，和 memory 文件一起作为检索来源。**100k / 50条这两个数字就是这里用的**：当会话历史积累了 100k 字节或 50 条新消息，才把这段新增历史同步进向量库。

对我们的项目来说这层基本不相关，我们用全量 20 条历史更简单直接。

---

## 对我们项目的参考价值

### 我们的需求 vs OpenClaw 的实现

| 我们的需求 | OpenClaw 对应机制 | 差异 |
|-----------|-----------------|------|
| `notes`（用户健康备忘） | `USER.md`（每次全文注入） | OC 是单用户，我们是多用户（每个微信用户一份） |
| `health_profile`（健康档案） | 没有对应的 | 需要自己设计 |
| 历史对话注入 | `sources: ["sessions"]`（向量搜索） | OC 用向量检索，我们用全量 20条 |
| 动态更新记忆 | compaction 触发 memory flush | 我们缺这个 agent 自动写入机制 |

### 关键洞察

**1. `USER.md` 是我们的 `notes` 的正确参考**
- 每次全文注入 system prompt，适合放用户的基本情况、偏好、注意事项
- 必须保持**短小精悍**（建议 500 字以内），我们为每个微信用户创建一个对应文件
- 不适合放大量数据（体检报告数据不要放这里）

**2. OpenClaw 的 memory 写入是 compaction 驱动的，不是消息条数驱动的**
- context window 快满时才压缩，同时把重要信息 append 到 memory/.md
- 对我们的建议：agent 在回复用户后，可以选择性地把关键健康信息 append 到该用户的 notes 文件（保持短小，旧信息定期清理或摘要）

**3. 健康档案要独立存放**
- `notes/<用户名>.md`：简短备忘（每次全文注入 system prompt）
- `profiles/<用户名>.json`：结构化健康档案（体检报告数据、诊断，按需加载）

---

## 推荐的实现方向（供参考）

```
skill-platform/
└── user-data/
    ├── notes/
    │   ├── 鲍伟.md     ← 简短，每次全文注入。内容如：用户基本情况、已知病史、偏好
    │   └── oscar.md    ← 建议 500 字以内
    └── profiles/
        ├── 鲍伟.json   ← 结构化健康档案（体检报告提取后写入，按需加载）
        └── oscar.json
```

**cua_forwarder.js 的 ingest 需要补充**：
1. 读取 `user-data/notes/<from_name>.md` → `notes` 字段（全文）
2. 读取 `user-data/profiles/<from_name>.json` → `health_profile` 字段（结构化）
3. 后端 agent 回复后，可以触发把本次对话关键健康信息 append 到 notes 文件（类似 OpenClaw 的 memory flush，但更轻量）
