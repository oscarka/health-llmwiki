# 客户健康首页：克罗恩病青年维持期及穿戴生理指标监测
<!-- SUMMARY_START -->
患者为26岁男性，确诊克罗恩病（CD）2年余，长期规律使用乌司奴单抗维持治疗。近期穿戴设备捕捉到连续 7天“低活动量与HRV植物神经重度失调”恶化警报，综合异常评分 0.4890，夜间 HRV 剧烈波动可能与频繁饮酒行为有关。目前入住消化科常规复查，辅以行为节律管理。
<!-- SUMMARY_END -->

> [!IMPORTANT]
> **红线警示（免疫抑制与肠粘膜保护）**：
> - 维持期使用乌司奴单抗，机体防御力降低，应高度预防呼吸道与肠道继发感染！
> - 若复查期出现发热、剧烈腹痛或大便次数骤增至每日 5 次以上，必须立刻急诊检查 [🔗 溯源](log_c2_1)。

> [!WARNING]
> **自主神经失调与酒精戒断预警**：
> - 穿戴连续31天数据报警：日均步数骤降至 3.1 步/日 [🔗 溯源](log_c2_2)。
> - 频繁饮酒使夜间 HRV 振幅偏离基线达 +35.2%，处于交感/副交感神经重度失衡状态，必须从即日起限制睡前饮酒 [🔗 溯源](log_c2_2)。

## 1. 客户基本画像
* **基本信息**：男，26岁，消化内科 23床 [🔗 溯源](log_c2_3)。
* **主要诊断**：
```observation-block
  type: observation
  subtype: finding
  content: "主要诊断为克罗恩病（CD）2年余"
  evidence_refs:
    - log_c2_1
  attention_score: 0.3
```
* **生理指标危机**：
```observation-block
  type: observation
  subtype: signal
  content: "HRV RMSSD 当前值 68.11 ms，偏离基线幅度波动达 -2.1% 至 +35.2%（偏离均值 +11.9%）"
  evidence_refs:
    - log_c2_2
  attention_score: 0.3
```
```observation-block
  type: observation
  subtype: signal
  content: "平均心率 74.8 bpm（静息状态下最高达 80.2 bpm）"
  evidence_refs:
    - log_c2_2
  attention_score: 0.3
```

## 2. 快捷导航
* [既往史与诊疗时间轴](medical_history.md)
* [用药方案与生活医嘱](medication_plan.md)
* [随访互动摘要](communication_timeline.md)