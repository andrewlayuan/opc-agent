/** 附件文字进提示词：<attachment> 包裹、标签中和、按预算分配 */

/** 把数据中的 <tag> 换成 ‹tag›，防止伪造提示词结构（与 memory/events.ts 的 fence 同规则） */
export const neutralize = (s: string): string => s.replace(/<(\/?[A-Za-z_][\w-]*)[^<>]*>/g, '‹$1›');

export interface AttText {
  name: string;
  kind: 'image' | 'doc';
  text: string;
  orig_chars: number | null;
}

const KIND = { doc: '文档', image: '图片描述' } as const;

export function renderAttachments(list: AttText[], budget: number, perItem = Infinity): string {
  let left = Math.max(0, budget);
  const blocks: string[] = [];
  for (const a of list) {
    const name = neutralize(a.name).replace(/"/g, '＂');
    const cps = [...a.text];
    let body: string;
    if (left <= 0) body = '（超出字数预算，已省略）';
    else {
      const allow = Math.min(perItem, left);
      const keep = cps.slice(0, allow);
      left -= keep.length;
      body = neutralize(keep.join(''));
      if (keep.length < cps.length || a.orig_chars != null) body += `\n（原文 ${a.orig_chars ?? cps.length} 字，已截取前 ${keep.length} 字）`;
    }
    blocks.push(`<attachment name="${name}" kind="${KIND[a.kind]}">\n${body}\n</attachment>`);
  }
  return blocks.join('\n');
}

export function placeholderInput(names: string[]): string {
  return [...`（见附件）${names.join('、')}`].slice(0, 200).join('');
}
