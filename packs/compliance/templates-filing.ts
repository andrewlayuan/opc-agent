// 报送类材料模板：应用说明、算法安全自评估报告、双新安全评估报告、拟人化安全评估报告、AI 生成内容标识方案
import { fixed, model, optLabel, optLabels, productName, v, type DocTemplate } from './template-kit.ts';

const NO_NUMBERS = '不编造数量、人数、日期、编号等具体数字；资料与产品描述里没有的，输出占位。';

export const APP_STATEMENT: DocTemplate = {
  kind: 'app_statement', name: '应用说明（登记/备案用）', usage: 'filing', items: ['genai_register', 'genai_filing'], version: 1,
  chapters: [
    fixed('basic', '基本情况', ['entity.company_name', 'entity.credit_code', 'entity.address', 'facts.site'], (c) => [
      '| 项目 | 内容 |',
      '| --- | --- |',
      `| 应用名称 | ${productName(c)} |`,
      `| 运营主体 | ${v(c, 'entity.company_name')} |`,
      `| 统一社会信用代码 | ${v(c, 'entity.credit_code')} |`,
      `| 注册地址 | ${v(c, 'entity.address')} |`,
      `| 网址或 App 名称 | ${v(c, 'facts.site')} |`,
      `| 产品形态 | ${optLabels(c.answers, 'forms') || '—'} |`,
      `| 服务对象 | ${optLabels(c.answers, 'audience') || '—'} |`,
    ].join('\n')),
    model('service', '服务内容与场景', [
      '依据产品描述说明应用提供的生成式人工智能功能、使用场景和面向的用户，不扩大功能范围。',
      '按问卷「生成哪些内容」列出生成内容类型。',
    ]),
    fixed('model', '所用模型及备案情况', ['facts.model_name', 'facts.model_filing_no', 'facts.model_provider'], (c) => {
      const rows = [
        '| 项目 | 内容 |',
        '| --- | --- |',
        `| 使用方式 | ${optLabel('ai_use', String(c.answers.ai_use ?? '')) || '—'} |`,
        `| 模型名称 | ${v(c, 'facts.model_name')} |`,
        `| 模型提供方 | ${v(c, 'facts.model_provider')} |`,
        `| 备案号或上线编号 | ${v(c, 'facts.model_filing_no')} |`,
      ];
      if (c.answers.ai_output !== undefined) rows.push(`| 对模型输出的处理 | ${optLabels(c.answers, 'ai_output')} |`);
      return rows.join('\n');
    }),
    model('users', '用户群体与规模', ['按问卷说明服务对象、是否可能包含未成年人、当前用户规模。', NO_NUMBERS]),
    model('flow', '输入输出处理流程', [
      '按「用户输入 → 输入审核 → 调用模型 → 输出审核 → 标识与展示」逐步说明每个环节的处理与安全措施。',
      '问卷选择了对模型输出二次加工的，说明加工方式。',
    ]),
    model('safety', '内容安全措施', [
      '说明输入与输出两端的内容安全措施：关键词库、分类模型、人工审核、拒答策略、违法内容处置与报告、用户投诉处理。',
      NO_NUMBERS,
    ], { uses: ['facts.complaint'] }),
    model('label', '生成内容标识', ['依据《人工智能生成合成内容标识办法》第三条、第四条与 GB 45438-2025，说明显式标识和隐式标识的实现方式。']),
    fixed('complaint', '投诉举报', ['facts.complaint', 'entity.contact_email'], (c) => [
      `投诉举报渠道：${v(c, 'facts.complaint')}`,
      `联系邮箱：${v(c, 'entity.contact_email')}`,
      '我们将及时受理和处理用户投诉举报，并反馈处理结果。',
    ].join('\n\n')),
  ],
};

export const ALGO_SELFASSESS: DocTemplate = {
  kind: 'algo_selfassess', name: '算法安全自评估报告', usage: 'filing', items: ['algo_filing', 'genai_filing'], version: 1,
  chapters: [
    model('basic', '算法基本情况', [
      '说明算法名称（未知时输出【待填：算法名称】）、算法类型（生成合成、个性化推送、排序精选、检索过滤、调度决策中的哪类，依据问卷判断）、应用产品、应用场景与服务对象。',
      '依据《互联网信息服务算法推荐管理规定》第二十四条，说明本报告用于算法备案。',
    ]),
    model('principle', '算法原理与运行机制', ['说明算法的输入、处理与输出；模型来源（自研或调用他人模型），调用他人模型时写明模型名称与提供方。'], { uses: ['facts.model_name', 'facts.model_provider'] }),
    model('data', '数据来源与使用', ['说明训练数据（自研时）与运行时数据的来源、是否含个人信息及处理方式；调用他人模型时只写运行时数据。', NO_NUMBERS]),
    model('risks', '安全风险识别', ['按产品画像识别风险：违法不良信息生成与传播、虚假信息、歧视偏见、个人信息泄露、未成年人保护、沉迷、知识产权侵权；标注每项风险与本产品的相关程度。']),
    model('measures', '安全防范措施', ['针对上一章每项风险写对应的防范措施，写成已采取或将在上线前采取的措施，不夸大。', NO_NUMBERS]),
    model('governance', '算法安全管理制度', ['说明算法安全负责人、科技伦理审查、算法安全评估与监测、应急处置、日志留存、用户申诉等制度；负责人姓名未知时输出占位。'], { uses: ['entity.pi_officer'] }),
    model('conclusion', '评估结论', ['给出总体评估结论与待完善事项清单；不使用「完全无风险」之类的绝对表述。']),
  ],
};

export const SECURITY_REPORT: DocTemplate = {
  kind: 'security_report', name: '双新安全评估报告', usage: 'filing', items: ['security_assess'], version: 1,
  chapters: [
    model('basic', '服务基本情况', [
      '说明服务名称、主要功能、具有舆论属性或社会动员能力的功能（问卷「公开传播功能」）、上线情况与用户规模。',
      '依据《具有舆论属性或社会动员能力的互联网信息服务安全评估规定》第二条、第三条说明开展本次评估的原因。',
    ]),
    model('s1_officer', '安全管理负责人、信息审核人员与安全管理机构', ['说明确定与所提供服务相适应的安全管理负责人、信息审核人员或建立安全管理机构的情况（评估规定第五条第一项）。', NO_NUMBERS]),
    model('s2_identity', '用户真实身份核验与注册信息留存', ['说明用户真实身份核验方式以及注册信息留存措施（第五条第二项）。']),
    model('s3_logs', '日志信息与发布记录留存', ['说明对用户账号、操作时间、操作类型、网络源地址和目标地址、网络源端口、客户端硬件特征等日志信息，以及用户发布信息记录的留存措施，留存期限不少于六个月（第五条第三项）。']),
    model('s4_harmful', '违法有害信息防范处置', ['说明对账号与群组名称、昵称、简介、备注、标识，以及信息发布、转发、评论、群组等功能中违法有害信息的防范处置和记录保存措施（第五条第四项）；只写问卷实际具有的功能。']),
    model('s5_tech', '个人信息保护与防范失控风险的技术措施', ['说明个人信息保护措施，以及防范违法有害信息传播扩散、社会动员功能失控风险的技术措施（第五条第五项）。']),
    model('s6_complaint', '投诉举报制度', ['说明投诉举报制度、公布的投诉举报方式，以及受理和处理流程（第五条第六项）。'], { uses: ['facts.complaint'] }),
    model('s7_cac', '配合网信部门的工作机制', ['说明为网信部门依法履行互联网信息服务监督管理职责提供技术、数据支持和协助的工作机制（第五条第七项）。']),
    model('s8_police', '配合公安机关与国家安全机关的工作机制', ['说明为公安机关、国家安全机关依法维护国家安全和查处违法犯罪提供技术、数据支持和协助的工作机制（第五条第八项）。']),
    model('conclusion', '评估结论', ['逐项汇总上述八类措施的落实情况，给出评估结论与待完善事项；不使用绝对化表述。']),
  ],
};

export const ANTHRO_REPORT: DocTemplate = {
  kind: 'anthro_report', name: '拟人化安全评估报告', usage: 'filing', items: ['anthro_assess', 'anthro_selfcheck'], version: 1,
  chapters: [
    model('basic', '服务基本情况', [
      '说明服务名称、拟人化互动功能概况、上线情况与用户规模。',
      '依据《人工智能拟人化互动服务管理暂行办法》第二十二条，按问卷用户规模说明本次评估的触发情形（上线前、用户达到规模门槛或功能重大变化）。',
    ]),
    model('features', '拟人化功能与场景', ['依据产品描述说明角色设定、情感陪伴、记忆、语音或形象等功能与使用场景，不虚构功能。']),
    model('users', '用户群体', ['说明用户群体，以及对未成年人、老年人等特殊群体的识别与保护。']),
    model('identity', '人工智能身份提示', ['说明以显著方式提示用户正在与人工智能而非自然人互动，写明提示位置与时机。']),
    model('addiction', '防沉迷与情感依赖防范', ['说明使用时长提醒、情感依赖识别、引导现实社交、不以情感操控诱导付费等措施。']),
    model('content', '内容安全', ['说明角色扮演中违法不良信息的防范、对不当请求的拒绝，以及自伤、自杀等敏感话题的识别与干预。']),
    model('privacy', '个人信息保护', ['说明对话记录等个人信息（可能包含敏感个人信息）的处理目的、保存期限和删除方式。'], { uses: ['facts.retention'] }),
    model('emergency', '应急处置与人工接管', ['说明识别到用户存在自伤、自杀等高风险情形时的人工介入流程与求助资源提示，以及用户投诉渠道。'], { uses: ['facts.complaint'] }),
    model('conclusion', '评估结论', ['给出评估结论与待完善事项；不使用绝对化表述。']),
  ],
};

export const AIGC_LABEL_PLAN: DocTemplate = {
  kind: 'aigc_label_plan', name: 'AI 生成内容标识方案', usage: 'filing', items: ['aigc_label'], version: 1,
  chapters: [
    model('scope', '适用的内容类型', ['按问卷「生成哪些内容」列出需要标识的内容类型，以及各自的展示、下载、分享场景。']),
    model('explicit', '显式标识', ['依据《人工智能生成合成内容标识办法》第四条与 GB 45438-2025，按内容类型分别说明显式标识的位置与样式（文本、音频、图片、视频）；只写问卷勾选的类型。']),
    model('implicit', '隐式标识', ['说明在文件元数据中添加的隐式标识：生成合成内容属性、服务提供者名称或编码、内容编号等；如采用数字水印一并说明。']),
    model('notice', '用户协议与提示', ['说明在用户协议中写明标识的方法与样式，提示用户不得删除、篡改、隐匿标识；用户申请提供无显式标识内容时的处理方式。']),
    model('logs', '日志留存', ['说明提供无显式标识内容等情形的日志留存措施，留存期限不少于六个月。']),
    model('check', '实施与检查', ['说明上线前测试、定期抽检、版本变更时复核与责任人；责任人未知时输出占位。']),
  ],
};
