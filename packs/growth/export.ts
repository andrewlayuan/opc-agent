import { AI_NOTICE } from './checker.ts';
import { getPlatform, renderCopy } from './platforms.ts';
import type { CampaignView } from './store.ts';
import { GrowthError } from './types.ts';

export function parseExportFormat(v: string | null): 'md' {
  if (v !== 'md') throw new GrowthError(400, '导出格式不对');
  return v;
}

/** 投放导出为一份 Markdown：按平台顺序，未生成的跳过，未定稿的标草稿，末尾附 AI 声明提醒 */
export function exportCampaign(v: CampaignView): { name: string; body: string } {
  const out = [`# ${v.name}`, '', `产品：${v.product_name}`];
  for (const c of v.copies) {
    if (c.rev === 0) continue;
    const p = getPlatform(c.platform);
    out.push('', `## ${p.name}`, '');
    if (c.status !== 'final') out.push('> 草稿（未定稿），发布前请再自查', '');
    out.push(renderCopy(p, c.fields));
  }
  out.push('', '---', '', AI_NOTICE, '');
  return { name: `opc-growth-${v.id}.md`, body: out.join('\n') };
}
