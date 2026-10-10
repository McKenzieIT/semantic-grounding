| 规则 | 判据 | 命中 | 独杀 | 命中里含中文的词种 | 评 |
|---|---|---:|---:|---:|---|
| `pure-digits` | 纯数字 | 6 | 1 | 0 | #26 原有 |
| `partition-kv` | 分区/赋值式 | 127 | 0 | 8 | #26 原有 · 完全冗余 |
| `digit-run` | 长数字串(≥4) | 60 | 6 | 28 | #26 原有 |
| `operator-chars` | 含运算符 | 216 | 6 | 85 | #26 原有 |
| `separator-chars` | 含分隔符(，、;) | 408 | 129 | 336 | #26 原有 |
| `sentence-punct` | 含句读 | 39 | 3 | 27 | #26 原有 |
| `unbalanced-quote` | 引号不配对 | 10 | 1 | 9 | #26 原有 |
| `inner-space-phrase` | 含空格且长>8 | 464 | 135 | 327 | #26 原有 |
| `own-column-name` | 是本定义的列名 | 793 | 0 | 0 | #26 原有 · 完全冗余 |
| `slash-separator` | A `/` 也算分隔符 | 465 | 241 | 250 | **本票新增** |
| `layer-suffix` | B 分层/存储后缀 | 169 | 169 | 0 | **本票新增** |
| `column-name-canon` | C 列名 snake/camel 归一 | 859 | 66 | 0 | **本票新增** |
| `plus-operator` | D `+` 复合键记法 | 20 | 13 | 7 | **本票新增** |
| `arrow-tilde` | E 箭头/波浪号 | 9 | 4 | 5 | **本票新增** |
| `substring-of-own-id` | F 是自身 id 的子串【实测否决】 | 132 | 92 | 0 | **实测否决** |
| `len>24` | 长度上限 | 322 | 5 | 185 | 长度 |

### 长度上限扫描（其余规则全开）

| cap | 该阈值命中 | 其中没有任何别的规则能抓到 | 合计杀掉 |
|---:|---:|---:|---:|
| 12 | 816 | 35 | 2223 (51.7%) |
| 16 | 587 | 15 | 2203 (51.3%) |
| 20 | 432 | 6 | 2194 (51.1%) |
| 24 | 322 | 5 | 2193 (51.0%) |
| 28 | 234 | 3 | 2191 (51.0%) |
| 32 | 145 | 1 | 2189 (51.0%) |
| 40 | 51 | 0 | 2188 (50.9%) |
| 50 | 0 | 0 | 2188 (50.9%) |

### 需人工过目的疑似假阴性全表

业务形状的被杀候选 983 次 / 452 个词。其中 817 次 / 347 个词是**纯同一性命中**（这个词就是本定义自己的某个列名），该类含中文的词 **0** 个，故不计入误杀。剩下 **166 次 / 105 个词**是全部需要人眼看的量，列全如下：

| 次数 | 候选词 | 被哪条规则杀 | 原始上下文 |
|---:|---|---|---|
| 18 | `日全量快照 _df` | `inner-space-phrase` | …，供奖励活动选择与事实表 JOIN 查询使用。粒度：每个奖励物品 id 一行的配置/维度表（日全量快照 _df）。主要字段：id（物品ID，主键），name（物品名称），icon（图标），value |
| 14 | `dim` | `layer-suffix` | 卡池配置维度表（dim）。记录每个抽卡卡池的卡池类型（card_pool_type）、卡池ID（card_pool… |
| 8 | `_df 日全量快照` | `inner-space-phrase` | 内部用户游戏规则配置维度表（_df 日全量快照）。 记录游戏内部规则配置：每条规则由 rule_id（ip/role/code 三类编码）… |
| 8 | `等级/vip/战力/经验` | `slash-separator` | …达/触发某个节点(stepId关卡id、stepType节点类型)时上报，记录角色当前状态(等级/vip/战力/经验)及各类货币余额(coinList)。主体粒度为 role_id 角色级。ds=2 |
| 7 | `等级/VIP/战力` | `slash-separator` | …ageId)玩法中领取任务(missionId)奖励时上报，记录领取行为本身、领取角色画像（等级/VIP/战力）及领取后货币快照(coinList)。分析主体粒度为 role_id。scout 实测 |
| 4 | `钻石/紫金/体力等` | `slash-separator` | …poly 棋盘战斗中的通关/挑战行为，含角色等级、战力、vip等级及战斗时点携带的关键货币（钻石/紫金/体力等）。主体粒度为 role_id（角色），实测单日(ds=20260729/2026072 |
| 4 | `等级/VIP/战力/经验` | `slash-separator` | …代打（proxy/resort）玩法发起一次代打请求时上报，记录请求行为本身、发起角色画像（等级/VIP/战力/经验）及发起时刻的货币快照（coinList），并附带请求类型 type(实测1/3/ |
| 3 | `等级、vip、战力、经验` | `separator-chars` | …看板娘形象（image/newImage/newImageType），同时携带角色基础属性（等级、vip、战力、经验）与多类货币快照（gold/sendgold/freegold/diamond/e |
| 3 | `等级/战力/vip/货币` | `slash-separator` | 玩家进入迷宫副本时上报的事件，记录角色进入特定迷宫(dungeonId)的时机与角色快照(等级/战力/vip/货币)。分析主体为 role_id(角色)；单日 ds=20260729 scout 实测 |
| 2 | `钻石、紫金、体力等` | `separator-chars` | … GVE2 玩法中一键领取成就奖励的行为，包含角色基础信息（等级、战力、VIP）、货币列表（钻石、紫金、体力等）与成就 ID 列表。分析主体为 role_id（角色级事件）。实测 ds=202607 |
| 1 | `按 ds 更新日期分区` | `inner-space-phrase` | 游戏 10000251 的自动 BI 配置快照维度表。每行对应一次配置更新（按 ds 更新日期分区），conf 字段以 JSON 字符串形式存储完整配置（game_type、src_prj/… |
| 1 | `卡池ID，业务唯一标识` | `separator-chars` | …、保底与限制、up池与新手集市购买资源、展示灵器与背景图等。 键：card_pool_id（卡池ID，业务唯一标识）+ ds（日分区，快照日期）。复合唯一。 标签：card_pool_name（卡池 |
| 1 | `日分区，快照日期` | `separator-chars` | …资源、展示灵器与背景图等。 键：card_pool_id（卡池ID，业务唯一标识）+ ds（日分区，快照日期）。复合唯一。 标签：card_pool_name（卡池名称）、directions（卡池 |
| 1 | `订单号，主键，全局唯一` | `separator-chars` | …D）关联商品配置表用于订单维度的商品属性查找。粒度：每订单一行。主要字段：order_id（订单号，主键，全局唯一）, recharge_id（商品配置ID，外键）, ds（分区）。 |
| 1 | `礼包名称，标签` | `separator-chars` | …段：recharge_id（礼包ID，主键，非唯一-存在重复），recharge_name（礼包名称，标签），recharge_type/recharge_type_sec（类型/次级类型），rec |
| 1 | `order+level` | `plus-operator` | 武将觉醒信息配置归档维度表。粒度：每武将(knight_id)每觉醒点位(order+level)一行，按 ds 日期分区做历史快照归档。主要字段：knight_id(武将ID)、knig… |
| 1 | `等级，主键` | `separator-chars` | …251_knight_level_info）。粒度：每个骑士等级一行。主要字段：level（等级，主键）、develop（成长系数）、cost（升级需求资源，复合编码串如 1_18_1050）。… |
| 1 | `玩家类型, 新增天数` | `separator-chars` `inner-space-phrase` | …id)、普通(normal_stage/normal_id)玩家的关卡排序与进度。粒度：每(玩家类型, 新增天数)一行，按ds分区。 |
| 1 | `道具名称，人类可读` | `separator-chars` | …_type, item_value]（配置实体自然唯一标识），标签列为 item_name（道具名称，人类可读）。 |
| 1 | `游戏服/区服` | `slash-separator` | 服务器(区服)维度配置表。粒度：每 一个 server_id(游戏服/区服) 一行。 记录区服基础属性：server_name(显示名)、server_start_d… |
| 1 | `卡池id, 主键` | `separator-chars` | …id、名称、描述与类型，供事实表通过卡池 id JOIN 查询卡池维度属性。主要字段：id(卡池id, 主键), name(卡池名), desc(卡池描述), type(卡池类型编码)。 |
| 1 | `关卡id,主键` | `separator-chars` | …每行一个团队副本关卡。主键 id（关卡id），标签列 name（关卡名）。 主要字段：id(关卡id,主键), name(关卡名,标签), reco_level(推荐等级)。 用途：作为关卡维度的查 |
| 1 | `关卡名,标签` | `separator-chars` | …d（关卡id），标签列 name（关卡名）。 主要字段：id(关卡id,主键), name(关卡名,标签), reco_level(推荐等级)。 用途：作为关卡维度的查找/JOIN 表，供事实表按… |
| 1 | `C抽卡/活动` | `slash-separator` | 扭卡(C抽卡/活动)任务页签维度的全量快照归档表(dim)。每行代表一个 (卡池 gacha_id, 页签类型… |
| 1 | `如鱼饵、战法券快捷购买等` | `separator-chars` | 商品配置维度表：记录可交易/兑换商品（如鱼饵、战法券快捷购买等）的消耗与获得配置。 每行一个 (商品id, ds快照) 的商品配置记录。键字段：id（商品… |
| 1 | `真实关卡ID,为表主键` | `separator-chars` | …S编号)、boss_level(难度等级)、section(所属篇)、dungeon_id(真实关卡ID,为表主键)、name(BOSS名称)。 |
| 1 | `鱼的品质，1-6 数值` | `separator-chars` `inner-space-phrase` | …id，主键，但因日分区存档而存在多版本重复）、name（鱼的名字，标签列）、quality（鱼的品质，1-6 数值）。granularity: 每种鱼配置一行的维度表（按 ds 日分区存档，全表 i |
| 1 | `type+value` | `plus-operator` | …源配置维度表（dim_10000251_trans_item_df_arch）。存储资源项（type+value）的配置属性：name（资源名称）、quality（品质）、remark（备注）、ta |
| 1 | `按 ds 分区快照` | `inner-space-phrase` | …emark（备注）、table（引用表）。粒度：每 (type, value) 资源项一行（按 ds 分区快照）。作为维度表，通过 type+value 与事实表 JOIN 提供资源项的名称、品质等 |
| 1 | `如主线通关、日常副本` | `separator-chars` | …pter_name 为章节名，desc 为任务内容描述，type_desc 为任务内容类型（如主线通关、日常副本）。作为任务维度表供事实表通过 task_id 关联查询任务属性。 |
| 1 | `类型值,标签列` | `separator-chars` | …键), module(词条集合), attr_id(词条属性类型), attr_value(类型值,标签列), weight(权重), quality(稀有度), show_position(显示点 |
| 1 | `在单一 ds 分区内唯一` | `inner-space-phrase` | …、返利百分比气泡（rebate）。按 ds 分区存放每日全量快照。粒度：每个商品配置 id（在单一 ds 分区内唯一）一行的配置维度表；跨分区 id 会重复，需配合 ds 使用。 |
| 1 | `如礼包、月卡等` | `separator-chars` | …1 付费商店商品配置维度表（dim_）。日全量快照(_df)粒度，每行描述一个付费商店商品（如礼包、月卡等）。主键 id=付费商店商品id，标签列 name=付费商店商品名。包含周期(period) |
| 1 | `_arch 归档快照版` | `inner-space-phrase` | 游戏 10000251 付费/充值商店商品配置维度表（_arch 归档快照版）。每行描述一个付费商店商品：商品id(id)、商品名(name)、周期(period)、所… |
| 1 | `dim/df 日全量快照` | `inner-space-phrase` `slash-separator` | 游戏 10000251 的资源/道具类型配置维度表（dim/df 日全量快照）。每行对应一项资源类型记录，以 (resouce_type, resouce_value)… |
| 1 | `激活数档位1/2/3` | `slash-separator` | …段：id(套装id, 主键), name(套装名, 标签列), suit_num1/2/3(激活数档位1/2/3), suit_desc1/2/3(激活描述档位1/2/3)。 |
| 1 | `激活描述档位1/2/3` | `slash-separator` | …列), suit_num1/2/3(激活数档位1/2/3), suit_desc1/2/3(激活描述档位1/2/3)。 |
| 1 | `如玩家装备/战斗日志` | `slash-separator` | … desc1/desc2/desc3 分别为两件套/四件套/六件套效果描述文本。用于事实表（如玩家装备/战斗日志）按套装 id 联表获取套装名与各档位效果说明。 粒度：每 BUFF套装 一行的配置/ |
| 1 | `主键，角色维表条目ID` | `separator-chars` | …作为主键唯一标识一个临时角色维表条目，name 为该条目的显示名称/标签。 主要字段：id（主键，角色维表条目ID），name（显示名称）。 |
| 1 | `关卡名，如"汉家军阵"` | `separator-chars` `unbalanced-quote` | …的配置快照，按分区 ds 保留历史版本。主键列为 id（关卡 id），标签列为 name2（关卡名，如"汉家军阵"）。包含 type（关卡类型）、difficulty（难度）、chapter_id（ |
| 1 | `如关卡战斗记录、成就进度` | `separator-chars` | …所属章节、怪物组、强制上场 NPC、以及三档成就达成条件。作为维度表，通过 id 与事实表（如关卡战斗记录、成就进度）JOIN，提供关卡的属性化标签与分组维度，避免在事实表中冗余存放配置属性。 |
| 1 | `卡池ID，唯一` | `separator-chars` | …251 扭蛋(卡池)配置维度表（日全量快照 _df）。粒度：每卡池(id)一行；主键 id（卡池ID，唯一），标签列 name（卡池名称）。键/属性：id(卡池ID)、name(卡池名称)、grou |
| 1 | `0/1，基于阈值` | `separator-chars` `slash-separator` | …(0-1)；role_id=角色ID(主键)；idx=样本/批次索引；tag=预测流失标签(0/1，基于阈值)；y=实际流失标签(0/1，最新分区常为0因结果未实现)；ds=日分区。 业务用途：角色 |
| 1 | `每行=一个评估样本角色` | `operator-chars` | 粒度：角色级（每行=一个评估样本角色）。分析主体=角色（role）。 角色流失预测模型的评估样本快照表。每个 ds 分区按 sa… |
| 1 | `角色ID/PK` | `slash-separator` | …0_7_0 表示 2026-07-30、7 天窗口、版本 0）。 主要字段：role_id(角色ID/PK), acc_id(账号ID), server_id(服务器ID), server_ds(入 |
| 1 | `每行=一个训练样本角色` | `operator-chars` | 粒度：角色级（每行=一个训练样本角色）。分析主体=角色（role）。 角色流失预测模型的训练样本快照表。每个 ds 分区按 sa… |
| 1 | `角色, 停留关卡` | `separator-chars` | K11-关卡停留表（角色级日全量快照）。 记录每日停留在某关卡的角色级明细，每行一个 (角色, 停留关卡) 记录；区分玩法功能层(stay_type=1)与章节主题层(stay_type=2)停留… |
| 1 | `用于参与率/胜率计算` | `slash-separator` | …次数；role_part_pv/role_win_pv 为该角色在该玩法的总参与/胜利次数（用于参与率/胜率计算）。 |
| 1 | `日增量,非全量快照` | `separator-chars` | 财务付费订单日增量表(_di)。记录每笔付费订单的流水信息,粒度为"每笔订单每天一行"(日增量,非全量快照), 以 order_id 为唯一订单标识,同一订单成功(status=1)/失败(stat… |
| 1 | `订单金额/元` | `slash-separator` | …D), server_id(服务器ID), pay_type(付费类型), pay_amt(订单金额/元), tm(行为时间), cfg_id(商品配置ID), activity_type(活动类… |
| 1 | `p0601` | `digit-run` | …索日全量快照(_df)，角色(user_type=3)粒度，按区服/城池细分每日探索、轶事(p0601)、据点(p0602)的参与与通关次数、累计次数、探索进度、藏品/探索等级及携带见闻技能。 … |
| 1 | `p0602` | `digit-run` | …)，角色(user_type=3)粒度，按区服/城池细分每日探索、轶事(p0601)、据点(p0602)的参与与通关次数、累计次数、探索进度、藏品/探索等级及携带见闻技能。 粒度：日全量快照(_… |
| 1 | `角色id，主键` | `separator-chars` | …r_type，角色主体为推断，未做 user_type 校验）。 主要字段：role_id（角色id，主键），server_id（区服），story_id（剧情id），visit_pv（访问次数）， |
| 1 | `卡牌/灵器` | `slash-separator` | 灵器培养（卡牌/灵器）状态日全量快照总表，按角色(role_id)维度记录每个角色持有的灵器培养状态。 粒度：日… |
| 1 | `角色粒度，日增量_di` | `separator-chars` | 风物培养详情日表（角色粒度，日增量_di）。 记录角色在风物培养系统中各行为（action）对风物（tactic_id）的操作及对应… |
| 1 | `角色ID/subject` | `slash-separator` | …要字段：pve_type(玩法), battle_id(战斗ID/PK), role_id(角色ID/subject), stage_id(关卡ID), chapter_id(章节ID), sugg |
| 1 | `DWS` | `layer-suffix` | PVP积分每日变化表(DWS)。粒度：角色(role_id)×PVP玩法(pvp_type)×日增量(_di)。 记录每… |
| 1 | `充值购买/凤翎购买` | `slash-separator` | K11-付费商店购买明细表。记录玩家在付费商店的购买行为（充值购买/凤翎购买）。 主体粒度：账号+角色交易粒度（每条记录为一次购买行为，含 account_id 与 r… |
| 1 | `角色粒度，日增量 _di` | `separator-chars` `inner-space-phrase` | 道具资源产销汇总日表（角色粒度，日增量 _di）。 粒度：日增量(_di)，每行=单角色单日单道具类型单产销原因的产销汇总。 主体：角色(… |
| 1 | `无 ds 分区，静态全量` | `separator-chars` `inner-space-phrase` | …排除真实玩家分析）。业务咨询：xuwenlong.xwl(null)#。 粒度：明细快照表（无 ds 分区，静态全量）。分析主体=账号（user_type=2 推断；表无 user_type 列，主 |
| 1 | `等级/名称/战力/VIP` | `slash-separator` | 角色通用特征日增量表,记录每个角色在每日的通用属性与状态快照,涵盖角色基础信息(等级/名称/战力/VIP)、 各类货币余额(coinlist_*、diamond)、公会归属与公会信息、赛季/联赛阶… |
| 1 | `di` | `layer-suffix` | …diamond)、公会归属与公会信息、赛季/联赛阶段、在线时长、注册时间等。 粒度:日增量(di),每角色每天一行,记录当日角色通用特征快照。 主体类型:表名含"role"且存在 role… |
| 1 | `ds+tag_type` | `plus-operator` | …最新ds=20251228仅user_type=3）。 粒度：日全量快照(_df)，双分区(ds+tag_type)；最新ds=20251228仅tag_type=progression分区。 每行 |
| 1 | `时间/账号/utdid` | `slash-separator` | … 推断；该表无 user_type 列，主体按角色-区服汇总定义）。涵盖首/末次活跃与付费(时间/账号/utdid)、近期7/30天及累计活跃(pv/days/dur)与付费(pv/days/amt |
| 1 | `天数/次数/时长` | `slash-separator` | …P地理/渠道/包名/端版本)、首次与最近活跃及付费时间/金额、累计与7日/30日窗口的活跃(天数/次数/时长)和付费(天数/次数/金额)汇总指标。粒度:日全量快照(_df),当日即使角色未登录也保留 |
| 1 | `天数/次数/金额` | `slash-separator` | …)、首次与最近活跃及付费时间/金额、累计与7日/30日窗口的活跃(天数/次数/时长)和付费(天数/次数/金额)汇总指标。粒度:日全量快照(_df),当日即使角色未登录也保留其在库最新状态快照。能回答 |
| 1 | `2=账号` | `operator-chars` | …型(固定)】表名含 acc,按判定规则本表固定为【账号表】,user_type 固定为 2(2=账号),分析主体=账号,标识字段=user_id 存账号ID。DISTINCT user_typ… |
| 1 | `act_pv,登录次数` | `separator-chars` | …账号数(pay_fst=1)。 - 分区服的活跃/付费规模与首充转化。 - 账号的活跃次数(act_pv,登录次数)。 【注意事项】 - _di 为日增量,仅含当日有事件(活跃或付费)的账号-区服记 |
| 1 | `新增+付费` | `plus-operator` | …first_pay_rate 指标为"新增账号中首充账号占比",pay_fst 为首充而非"新增+付费"联合标记,非新增账号当日首充也会计入分子,故该比值为新增付费转化的近似值,精确新增付费率需… |
| 1 | `买量标识、买量媒体` | `separator-chars` | …、首次关联角色区服)、设备与环境信息(设备品牌型号、活跃 IP、地理位置、地区)、买量归因(买量标识、买量媒体)、内部用户标记(fellow_flag)、角色等级。 能回答的业务问题:某账号在某区服 |
| 1 | `累计付费、多窗口付费金额` | `separator-chars` | …1d、新增首N日付费)、渠道 ROI 归因(买量标识与媒体)、用户价值分层与 LTV 评估(累计付费、多窗口付费金额)、角色养成进度分析(账号关联角色的等级/战力/职业分布)。 注意事项:1) _d |
| 1 | `账号表/角色表` | `slash-separator` | …设备表】,分析主体=设备,主体标识字段为 user_id(本表中实际存储设备ID);不同表(账号表/角色表)对应不同 user_type,但本表内 user_type 不作为切换层级的开关。能回答的 |
| 1 | `设备ID+区服+日期` | `plus-operator` | 该表是按"设备ID+区服+日期"粒度的日活跃与付费明细宽表(_di 日增量),每行记录某设备在某区服某日的活跃与付费状态。… |
| 1 | `回流/流失节奏` | `slash-separator` | …180/360)付费金额; - 首次/最近活跃时间、首次/最近付费时间、最近两个活跃日间隔(回流/流失节奏); - 设备的平台、渠道、包名、地区、设备品牌型号、关联设备/账号/角色 ID 与时间、角 |
| 1 | `买量标识、媒体` | `separator-chars` | …道、包名、地区、设备品牌型号、关联设备/账号/角色 ID 与时间、角色区服; - 买量归因(买量标识、媒体)、预下载/测试期/内部用户标记; - 关联角色养成画像(角色名、等级、战力、职业、养成角色 |
| 1 | `累计付费 / 设备数` | `inner-space-phrase` `slash-separator` | …设备识别 - 沉默付费设备(曾付费但长期未活跃)识别 - LTV / 累计 ARPU 粗算(累计付费 / 设备数) - 付费转化率与付费设备人均累计付费 注意事项： - 本表主体固定为设备(user |
| 1 | `_df，每日全量` | `separator-chars` | 角色×区服粒度的通用标签日全量快照表（_df，每日全量）。每行表示一个角色在某区服截至分区日期 ds 的累计标签状态， 记录该角色的累计活跃天数/… |
| 1 | `df` | `layer-suffix` | 【角色表】该表为日全量快照(df),记录每个角色(user_id 即角色ID)×server_id 组合在当天时点的活跃与付… |
| 1 | `渠道 ROI、媒体对比` | `separator-chars` `inner-space-phrase` | …:付费 LTV 评估(首1/2/3/7/30/180日及分段 LTV)、渠道与买量归因分析(渠道 ROI、媒体对比)、首付转化漏斗、用户分层与流失预警(沉默/流失分级)、用户画像(机型/地域/平台) |
| 1 | `沉默/流失分级` | `slash-separator` | … LTV)、渠道与买量归因分析(渠道 ROI、媒体对比)、首付转化漏斗、用户分层与流失预警(沉默/流失分级)、用户画像(机型/地域/平台)、角色养成进度分布(等级/战力/职业)、付费节奏(新增期 v |
| 1 | `等级/战力/职业` | `slash-separator` | …漏斗、用户分层与流失预警(沉默/流失分级)、用户画像(机型/地域/平台)、角色养成进度分布(等级/战力/职业)、付费节奏(新增期 vs 滚动期)对比、Web 端占比分析。 注意事项: 1) 本表固定 |
| 1 | `新增期 vs 滚动期` | `inner-space-phrase` | …/流失分级)、用户画像(机型/地域/平台)、角色养成进度分布(等级/战力/职业)、付费节奏(新增期 vs 滚动期)对比、Web 端占比分析。 注意事项: 1) 本表固定为角色主体(user_type |
| 1 | `均值/求和` | `slash-separator` | …_object 解析; 4) role_level/role_force 等为快照值,聚合(均值/求和)仅作分布参考,无业务累加意义; 5) form_role_id(养成数据归属角色)可能与当… |
| 1 | `角色+统计日` | `plus-operator` | …识字段为 role_id(本表中 user_id 列实际存储角色ID role_id)。每"角色+统计日"一行,记录角色全生命周期的标签快照。DISTINCT user_type 仅返回单一值 3… |
| 1 | `coinList 数组` | `inner-space-phrase` | …id 作为账号维度可下钻）。参数含游戏服/账号/角色基础信息、角色等级与战力、关键货币列表（coinList 数组）及回退模块标识。scout 实测 ds=20260729 与 ds=2026072 |
| 1 | `等级/战力/货币余额` | `slash-separator` | …se)事件：通过GM工具对已存在订单(orderId)重新发货/补单，记录补发时的角色快照(等级/战力/货币余额)与订单信息。主体粒度为role_id，单日scout实测ds=20260729/20 |
| 1 | `等级/VIP/战力/货币` | `slash-separator` | …战双方(atkUid/defUid)旧新分数与排名、角色自身score/rank及基础属性(等级/VIP/战力/货币)。主体粒度 role_id（角色）。实测 ds=20260729：cnt=631 |
| 1 | `角色等级、vip、战力等` | `separator-chars` | …项事件：玩家在自动战斗功能中删除已保存的武将出战方案配置，记录被删除的方案id及角色上下文（角色等级、vip、战力等）。主体粒度为 role_id（单角色），20260729 实测 458 次删除涉 |
| 1 | `自定义关卡 PvP` | `inner-space-phrase` | 演武场-取消匹配事件：玩家在演武场（自定义关卡 PvP）匹配流程中主动取消匹配时上报的角色级埋点。记录角色身份、所在服、角色等级/VIP/战力与多… |
| 1 | `充值钻石/紫金/体力等` | `slash-separator` | …（params.id 为日记id），附带角色等级、vip、战力、关键货币 coinList（充值钻石/紫金/体力等）等 23 个参数。分析主体为 role_id（角色粒度），account_id 为 |
| 1 | `含充值钻石、紫金、体力等` | `separator-chars` | …交易所购买物品的埋点事件，记录每次购买行为的商品id、购买数量、剩余免费次数及角色货币快照（含充值钻石、紫金、体力等）。主体粒度为 role_id（角色），2026-07-29 单日实测 cnt=1 |
| 1 | `等级/战力/vip/经验` | `slash-separator` | …requireType、rewards 奖励列表及任务描述 detail，以及角色基础属性(等级/战力/vip/经验)。subject 粒度为 role_id（角色级）。ds=20260729/20 |
| 1 | `角色/账号/服务器覆盖` | `slash-separator` | …/货币列表等)。分析主体为 role_id(角色级事件)，可用于统计剧本城池解锁的参与规模(角色/账号/服务器覆盖)与解锁城池/剧本分布。scout 实测 ds=20260729：事件 1750 条 |
| 1 | `武将/装备/战法/法宝` | `slash-separator` | …间、上线时间、角色等级、vip等级、角色战力、经验、teamId、index、detail(武将/装备/战法/法宝)、coinList(各类货币) 等41个。scout 实测 ds=20260729 |
| 1 | `等级、战力、VIP` | `separator-chars` | …一键领取成就奖励事件：记录玩家在 GVE2 玩法中一键领取成就奖励的行为，包含角色基础信息（等级、战力、VIP）、货币列表（钻石、紫金、体力等）与成就 ID 列表。分析主体为 role_id（角色级 |
| 1 | `成功率~93.4%` | `arrow-tilde` | …1, server_uv=42, play_uv=198, success_cnt=185(成功率~93.4%), score_sum=636682, talent_points_sum=1055。 |
| 1 | `等级、战力、VIP、经验` | `separator-chars` | …tlefield)角色复活事件，记录角色在古战场战斗中被击败后复活的时刻，携带角色基础属性(等级、战力、VIP、经验)与货币快照(coinList)。分析主体为角色(role_id)，反映复活行为规 |
| 1 | `角色粒度，账号粒度辅助` | `separator-chars` | …/战力/货币快照 coinList 与奖励id列表 idlist。分析主体 role_id（角色粒度，账号粒度辅助）。ds=20260729 单日 scout 实测 cnt=4202, role_u |
| 1 | `money, 付费货币` | `separator-chars` `inner-space-phrase` | …含商店id(shopId)、货物id(goodsId)、购买数量(amount)、消耗凤翎(money, 付费货币)等。分析主体为 role_id（角色），可统计购买次数、购买角色UV、消耗凤翎总额 |
| 1 | `等级/vip/战力/货币` | `slash-separator` | …d）激活事件：玩家购买/激活幻想月卡时上报，记录充值项 goodsId 与激活时刻角色快照（等级/vip/战力/货币）。分析主体为 role_id（角色级，account_id 作为账号维补充）。d |
| 1 | `充值/付费` | `slash-separator` | …0分(¥27776) 与 DWS 表 com_pay_order_di 覆盖同一类业务问题(充值/付费)但不是同一记录集,不可自由互推——已验证的唯一对齐口径:本表 moneyType=1 且 … |
| 1 | `装备 uid 数组` | `inner-space-phrase` | …resources（回收资源数组 type/value/size/uid）与 equips（装备 uid 数组）。 |
| 1 | `向商品出价/议价` | `slash-separator` | 公会砍价-砍价：玩家在公会砍价玩法中触发砍价动作（向商品出价/议价）的事件，每次事件对应当日 1 次砍价(dailyBargainCnt=1)。记录砍价时货币… |
| 1 | `低频行为，量级合理` | `separator-chars` | …0728: cnt=1, role_uv=1, acc_uv=1, server_uv=1（低频行为，量级合理）。 |
| 1 | `兵符抽卡/抽奖` | `slash-separator` | artifact.gacha（兵符抽卡/抽奖） 记录角色进行兵符（artifact）抽卡/抽奖的日志事件。事件携带游戏服id、角色id、… |

### 护栏生效后仍会被重抽的剩余量（#36 的否决集规模）

| 来源分支 | 存活次数 | 存活词种 | 说明 |
|---|---:|---:|---|
| domain | 922 | 10 | `domains` 字段逐项入候选，全库只有 10 个词 |
| paren | 1139 | 667 | 描述里的括号夹注 |
| quote | 42 | 36 | 描述里的引号夹注 |
| **合计** | **2103** | **711** | 否决集：按 (定义,label) 键 ≈ 2103 条；按 label 全局键 ≈ 711 条 |

domain 分支的全部 10 个词：`自定义`×162、`角色成长`×144、`战斗关卡`×128、`系统监控`×95、`付费经济`×93、`用户生命周期`×90、`装备道具`×72、`探索收集`×66、`社交公会`×54、`资源产销`×18
