/** 多轮对话的纯逻辑：输出协议解析与上下文组装（不触碰数据库和模型） */

export type TurnMode = 'auto' | 'revise';
export type TurnResult = { kind: 'revise'; doc: string; note: string } | { kind: 'ask'; answer: string };

export interface TurnMsg {
  role: 'user' | 'assistant';
  kind: 'ask' | 'revise';
  content: string;
  status: 'running' | 'done' | 'error';
}

export const HISTORY_BUDGET = 12000;
const ANSWER_MAX = 3000;
const NOTE_MAX = 80;
const DOC_MIN = 200;
const DEFAULT_NOTE = '根据你的要求修订';

export const TURN_PROTOCOL = `## 多轮对话输出协议（必须遵守）
用户会基于「当前文档」继续追问或提出修改要求。先判断意图，再按以下格式输出：
- 如果用户要求修改、补充、重写文档的任何部分：第一行只写 [改写]，随后输出修改后的**完整**文档（Markdown，保留未改动的部分，不要只给片段，不要用代码块包裹）；文档结束后另起一行写 ---变更说明---，再用一句话（不超过 80 字）说明改了什么。
- 如果用户只是提问、要求解释或讨论：第一行只写 [回答]，随后给出简洁、具体的回答（不超过 3000 字），不要重复整份文档。
- 无论哪种，都不要输出任何链接；引用雷达资料时沿用 [n] 编号。`;

const MARK = /^[[【]\s*(改写|回答)\s*[\]】][ \t]*\n?/;
const NOTE_SPLIT = /\n-{3,}\s*变更说明\s*-{3,}[ \t]*/;
const FENCE = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/i;
const URL = /https?:\/\/\S+/g;

const chars = (s: string) => Array.from(s);
const cut = (s: string, n: number) => chars(s).slice(0, n).join('');

export function normMode(x: unknown): TurnMode {
  return x === 'revise' ? 'revise' : 'auto';
}

export function parseTurn(raw: string, mode: TurnMode): TurnResult {
  const s = raw.trim();
  const m = s.match(MARK);
  const body = m ? s.slice(m[0].length) : s;
  const kind = m ? (m[1] === '改写' ? 'revise' : 'ask') : mode === 'revise' ? 'revise' : 'ask';

  if (kind === 'ask') {
    const answer = cut(body.replace(URL, '').trim(), ANSWER_MAX);
    if (!answer) throw new Error('模型没有返回内容');
    return { kind: 'ask', answer };
  }

  const at = body.search(NOTE_SPLIT);
  let docPart = (at >= 0 ? body.slice(0, at) : body).trim();
  const notePart = at >= 0 ? body.slice(at).replace(NOTE_SPLIT, '') : '';
  const fenced = docPart.match(FENCE);
  if (fenced) docPart = fenced[1];
  const doc = docPart.replace(URL, '').trim();
  if (chars(doc).length < DOC_MIN) throw new Error('模型没有返回完整文档');
  const note = cut(notePart.replace(URL, '').replace(/\s+/g, ' ').trim(), NOTE_MAX) || DEFAULT_NOTE;
  return { kind: 'revise', doc, note };
}

/** 只保留已完成的轮次；从最新往前累加，超出预算即停止；按时间正序返回 */
export function pickHistory(msgs: TurnMsg[], budget: number = HISTORY_BUDGET): TurnMsg[] {
  const out: TurnMsg[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const x = msgs[i];
    if (x.status !== 'done') continue;
    const next = msgs[i + 1];
    if (x.role === 'user' && next?.role === 'assistant' && next.status !== 'done') continue;
    const len = chars(x.content).length;
    if (used + len > budget) break;
    used += len;
    out.push(x);
  }
  return out.reverse();
}

export function buildTurnMessages(a: {
  system: string;
  input: string;
  refsText: string;
  latestN: number;
  latestDoc: string;
  history: TurnMsg[];
  text: string;
  mode: TurnMode;
}): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const first = `原始需求：\n${a.input}` + (a.refsText ? `\n\n雷达参考资料（引用时用 [n]）：\n${a.refsText}` : '');
  const list: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: a.system },
    { role: 'user', content: first },
    { role: 'assistant', content: `当前文档（v${a.latestN}）：\n\n${a.latestDoc}` },
    ...a.history.map((x) => ({
      role: x.role,
      content: x.role === 'assistant' && x.kind === 'revise' ? `（已改写文档）${x.content}` : x.content,
    })),
    { role: 'user', content: a.text + (a.mode === 'revise' ? '\n\n本轮要求：输出改写后的完整文档' : '') },
  ];
  // 部分模型不接受相邻的同角色消息（历史被预算截断时可能出现），合并为一条
  const out: typeof list = [];
  for (const m of list) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') prev.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}
