# 既往史与诊疗时间轴

## 1. 既往病史
* **慢阻肺及哮喘**：病史 10 余年，肺功能受损重，走几步路即剧烈憋气 [🔗 溯源](log_c1_1)。
```observation-block
  type: observation
  subtype: functional
  content: "患者有慢性慢阻肺和哮喘病史十几年，最近活动后气短加重，没走几步就喘得气上不来，精神很差"
  evidence_refs:
    - log_c1_1
  attention_score: 0.3
```
* **糖尿病史**：确诊数年，由胰岛素/口服药控制，骨折后呈对应升高 [🔗 溯源](log_c1_2)。
```observation-block
  type: observation
  subtype: functional
  content: "患者摔伤腰部致剧烈疼痛、活动受限，无法站立与翻身"
  evidence_refs:
    - log_c1_2
  attention_score: 0.3
```
```observation-block
  type: observation
  subtype: finding
  content: "X线及CT检查提示腰椎骨折（L2椎体压缩性骨折）"
  evidence_refs:
    - log_c1_2
  attention_score: 0.75
```
```observation-block
  type: observation
  subtype: signal
  content: "体温 36.6℃，呼吸 22次/分，脉搏 88次/分，SpO2 89% (低流量给氧下)"
  evidence_refs:
    - log_c1_3
  attention_score: 0.95
```

## 2. 诊疗轨迹时间轴
* **3月17日**：因慢阻肺药效降低、活动气喘，家属向中心致电求助，获得就医指导 [🔗 溯源](log_c1_1)。
```intervention-block
  type: intervention
  subtype: treatment
  content: "建议患者查血气分析、胸部CT和肺功能，调整用药"
  evidence_refs:
    - log_c1_1
```
```intervention-block
  type: intervention
  subtype: care
  content: "建议患者在家里注意保暖，避免感冒诱发急性发作"
  evidence_refs:
    - log_c1_1
```
* **4月30日**：居家不慎跌倒致腰部摔伤 [🔗 溯源](log_c1_2)。
* **5月05日**：急诊确诊 L2 压缩骨折收治入院，下发禁食水与卧床指令 [🔗 溯源](log_c1_2)。
```intervention-block
  type: intervention
  subtype: treatment
  content: "收治入院，暂行禁食水以备术前检查"
  evidence_refs:
    - log_c1_2
```
```intervention-block
  type: intervention
  subtype: care
  content: "嘱患者绝对卧床休息"
  evidence_refs:
    - log_c1_2
```
* **5月07日**：病区扫腕带定级一级护理，血氧仅 89%，确立防压疮防窒息联合监护 [🔗 溯源](log_c1_3)。
```intervention-block
  type: intervention
  subtype: protection
  content: "防压疮极高危、防跌倒"
  evidence_refs:
    - log_c1_3
```
```intervention-block
  type: intervention
  subtype: care
  content: "糖尿病饮食管理"
  evidence_refs:
    - log_c1_3
```