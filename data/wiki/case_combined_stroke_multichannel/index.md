# 客户健康首页：重度高血压脑出血ICU急救与急诊多渠道回溯
<!-- SUMMARY_START -->
患者为53岁男性，因长期高血压擅自停药2年，突发失语、右侧偏瘫及呼吸急促。120紧急呼救提示发作迅速，急诊CT提示左基底节区重度脑出血，血压飙升至198/112 mmHg。目前收治于重症医学科（ICU），留置气管插管、深静脉管、胃管、尿管4种高危管路，行特级护理及机械通气，处于急性危重期。
<!-- SUMMARY_END -->

> [!IMPORTANT]
> **红线警示（颅内高压与致死性脑疝预防）**：
> - 处于急性出血及脑水肿高峰期，必须严格控制平均动脉压，维持收缩压在 130-140 mmHg 范围内，严防颅内压突增导致二次破裂脑出血或致死性脑疝 [🔗 溯源](log_c3_3)！
> - 患者神志呈嗜睡/浅昏迷状态，右下肢肌力0级 [🔗 溯源](log_c3_2)。

> [!WARNING]
> **多管路有创监护与吸入性肺炎防范**：
> - 留置气管插管、深静脉管、胃管、尿管等四种高危管路，意外拔管防范属于特级高危警示 [🔗 溯源](log_c3_3)。
> - 严禁口服任何食物。执行胃管喂饲流质营养，床头抬高40度，严格防反流导致吸入性误吸 [🔗 溯源](log_c3_3)。

## 1. 当前主要关注

```observation-block
type: observation
subtype: signal
content: "突发失语、右侧偏瘫、口眼歪斜，神志嗜睡/浅昏迷状态"
evidence_refs:
  - log_c3_1
  - log_c3_2
attention_score: 0.95
```

```observation-block
type: observation
subtype: signal
content: "入院血压 198/112 mmHg，重度高血压急症，颅内出血进行中"
evidence_refs:
  - log_c3_2
attention_score: 0.95
```

```observation-block
type: observation
subtype: finding
content: "急诊CT确诊：左基底节区重度脑出血，出血量约35mL，脑室受压变形"
evidence_refs:
  - log_c3_2
attention_score: 0.92
```

```observation-block
type: observation
subtype: functional
content: "右下肢肌力0级，完全瘫痪；右上肢肌力1级；无自主咳痰能力"
evidence_refs:
  - log_c3_2
  - log_c3_3
attention_score: 0.88
```

```intervention-block
type: intervention
subtype: pipeline
content: "ICU留置气管插管（接呼吸机）、右颈深静脉管、胃管、导尿管，共4路高危有创管路"
evidence_refs:
  - log_c3_3
```

## 2. 事件时间轴

* **2025-09-28 14:15**：突发失语、半身瘫痪、口歪气急。家属紧急致电随访呼救，医生识别卒中并下发平卧及清理呼吸道医嘱 [🔗 溯源](log_c3_1)。
* **2025-09-28 14:30**：急诊送达，查血压 198/112 mmHg，CT 确诊重度脑出血，行脱水控压急救处理 [🔗 溯源](log_c3_2)。
* **2025-09-28 18:00**：转入 ICU 重症病区，行气管插管连接呼吸机，完成特级有创置管，确立多管路防脱管指令 [🔗 溯源](log_c3_3)。

## 3. 客户基本画像

* **基本信息**：男，53岁，ICU 3床 [🔗 溯源](log_c3_3)。
* **急救诊断**：高血压脑出血（重度基底节出血） [🔗 溯源](log_c3_2)。
* **核心危险因素**：有多年高血压病史，且擅自断服降压药长达两年 [🔗 溯源](log_c3_1)。

## 4. 快捷导航

* [既往史与诊疗时间轴](medical_history.md)
* [用药方案与生活医嘱](medication_plan.md)
* [随访互动摘要](communication_timeline.md)
