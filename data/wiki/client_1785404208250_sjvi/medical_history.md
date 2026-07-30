# 既往史与诊疗时间轴

## 1. 既往病史
* **慢性病**：暂无登记。
* **手术/外伤史**：暂无登记。
* **家族史**：暂无登记。

## 2. 生理信号 (Physiologic Signals)
*(心率、血压、血氧、体温、HRV等穿戴/检测数据)*
```observation-block
type: observation
subtype: signal
content: "测得血氧饱和度仅为88%（SpO2: 88%）"
evidence_refs:
  - log_1785404208255_kqmq
attention_score: 0.95
```

## 3. 化验结果 (Laboratory Findings)
*(血常规、生化、影像学、病理等实验室检查结果)*
| 日期 | 检查项目 | 结果 | 参考值 | 异常标记 |
|------|----------|------|--------|----------|
| — | — | — | — | — |

## 4. 功能变化 (Functional Changes)
*(活动能力、睡眠、认知、情绪、日常生活功能的主观与客观变化)*
```observation-block
type: observation
subtype: functional
content: "呼吸促"
evidence_refs:
  - log_1785404208255_kqmq
attention_score: 0.3
```
```observation-block
type: observation
subtype: functional
content: "口角歪斜"
evidence_refs:
  - log_1785404208255_kqmq
attention_score: 0.3
```

## 5. 诊疗轨迹时间轴
*(以下内容将随医生问诊及单证 OCR 录入由大模型自动追加并精简)*
暂无记录。