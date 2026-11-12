/** 在 worker 线程中提取 Office 文字：构造的文件即使让解析卡住，也只卡这个线程，由主线程超时终止 */
import { parentPort, workerData } from 'node:worker_threads';
import { ExtractError, extractDocx, extractPptx, extractXlsx } from './extract.ts';

const { format, buf } = workerData as { format: 'docx' | 'xlsx' | 'pptx'; buf: Uint8Array };
const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
try {
  const text = format === 'docx' ? extractDocx(b) : format === 'xlsx' ? extractXlsx(b) : extractPptx(b);
  parentPort!.postMessage({ ok: true, text });
} catch (e) {
  parentPort!.postMessage(e instanceof ExtractError ? { ok: false, status: e.status, message: e.message } : { ok: false, status: 422, message: '' });
}
