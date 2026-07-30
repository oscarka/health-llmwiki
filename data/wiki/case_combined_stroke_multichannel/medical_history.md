# 既往史与诊疗时间轴

## 1. 既往病史

```observation-block
type: observation
subtype: functional
content: "高血压病史多年，擅自停服降压药2年以上，缺乏日常血压随访，是本次重度脑出血的直接主因"
evidence_refs:
  - log_c3_1
attention_score: 0.90
```

* **高血压停药史**：病史多年，但自行停服降压药2+年，缺乏日常血压随访，是导致本次突发重度血管破裂出血的直接主因 [🔗 溯源](log_c3_1)。

## 2. 生理信号记录

```observation-block
type: observation
subtype: signal
content: "急诊入院血压 198/112 mmHg，脉搏 102次/分，呼吸 26次/分，SpO2 91%（面罩给氧10L/min下）"
evidence_refs:
  - log_c3_2
attention_score: 0.95
```

```observation-block
type: observation
subtype: signal
content: "ICU接诊体温 36.8℃，维持镇静镇痛后心率降至88次/分，SpO2 97%（气管插管呼吸机辅助通气）"
evidence_refs:
  - log_c3_3
attention_score: 0.85
```

## 3. 化验与影像结果

```observation-block
type: observation
subtype: finding
content: "头颅CT：左基底节区高密度影，出血量约35mL，脑室受压变形，中线结构轻度右移"
evidence_refs:
  - log_c3_2
attention_score: 0.92
```

```observation-block
type: observation
subtype: finding
content: "急诊血常规：血红蛋白正常；凝血功能：PT/APTT轻度延长；血钠138mmol/L，血糖8.2mmol/L（应激性升高）"
evidence_refs:
  - log_c3_2
attention_score: 0.75
```

## 4. 功能变化记录

```observation-block
type: observation
subtype: functional
content: "发病时右侧上肢肌力1级，右侧下肢肌力0级，左侧肢体肌力正常，言语不能，但对简单指令有眨眼反应"
evidence_refs:
  - log_c3_2
attention_score: 0.88
```

```observation-block
type: observation
subtype: functional
content: "无自主咳嗽及吞咽能力，人工气道辅助通气中，双肺听诊呼吸音粗"
evidence_refs:
  - log_c3_3
attention_score: 0.82
```

## 5. 诊疗急救时间轴

* **2025-09-28 14:15**：突发失语、半身瘫痪、口歪气急。家属紧急致电随访呼救，医生识别卒中并下发平卧及清理呼吸道医嘱 [🔗 溯源](log_c3_1)。
* **2025-09-28 14:30**：急诊送达，查血压 198/112 mmHg，CT 确诊重度脑出血，行脱水控压急救处理，下达病危通知书 [🔗 溯源](log_c3_2)。
* **2025-09-28 18:00**：转入 ICU 重症病区，行气管插管连接呼吸机，完成特级有创置管，确立多管路防脱管指令 [🔗 溯源](log_c3_3)。
