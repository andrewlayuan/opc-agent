/** 在 worker 线程中提取 Office / HTML 文字：构造的文件即使让解析卡住，也只卡这个线程，由主线程超时终止 */
import { parentPort, workerData } from 'node:worker_threads';
import { ExtractError, extractDocx, extractPptx, extractXlsx } from './extract.ts';
import type { OfficeFormat } from './extract.ts';
import { decodeHtml, htmlToText } from './html.ts';

const { format, buf } = workerData as { format: OfficeFormat; buf: Uint8Array };
const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
try {
  const text = format === 'docx' ? extractDocx(b) : format === 'xlsx' ? extractXlsx(b) : format === 'pptx' ? extractPptx(b) : htmlToText(decodeHtml(b));
  parentPort!.postMessage({ ok: true, text });
} catch (e) {
  parentPort!.postMessage(e instanceof ExtractError ? { ok: false, status: e.status, message: e.message } : { ok: false, status: 422, message: '' });
}
