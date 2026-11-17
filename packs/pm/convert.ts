/**
 * 旧版 Office（doc / xls / ppt）、RTF、ODF（odt / ods / odp）先用 LibreOffice 转成 docx / xlsx / pptx，再交给现有提取逻辑。
 * 加固：不经 shell、参数固定；每次用一次性的临时目录和配置（禁用宏、不更新外部链接、打开时不重算公式）；
 * 子进程只拿到最小环境变量（不含密钥）；放在独立进程组，超时或结束后整组强杀；同一时间只转换一个文件
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtractError } from './extract.ts';
import type { LegacyFormat } from './extract.ts';

export const LEGACY: ReadonlySet<string> = new Set<LegacyFormat>(['doc', 'xls', 'ppt', 'rtf', 'odt', 'ods', 'odp']);
export const TARGET: Record<LegacyFormat, 'docx' | 'xlsx' | 'pptx'> = { doc: 'docx', rtf: 'docx', odt: 'docx', xls: 'xlsx', ods: 'xlsx', ppt: 'pptx', odp: 'pptx' };
export const CONVERT_TIMEOUT_MS = 60000;
export const LO_MISSING = '服务器未安装文档转换工具（LibreOffice）';
export const LO_TIMEOUT = '文档转换超时';
export const LO_FAILED = '文档转换失败，文件可能已损坏或有密码保护';
const OUT_MAX = 50 * 1024 * 1024;
const STDERR_MAX = 4096;

const SETTINGS: [string, string, string][] = [
  ['/org.openoffice.Office.Common/Security/Scripting', 'MacroSecurityLevel', '3'],
  ['/org.openoffice.Office.Common/Security/Scripting', 'DisableMacrosExecution', 'true'],
  ['/org.openoffice.Office.Common/Security/Scripting', 'BlockUntrustedRefererLinks', 'true'],
  ['/org.openoffice.Office.Writer/Content/Update', 'Link', '2'],
  ['/org.openoffice.Office.Calc/Content/Update', 'Link', '2'],
  ['/org.openoffice.Office.Calc/Formula/Load', 'OOXMLRecalcMode', '1'],
  ['/org.openoffice.Office.Calc/Formula/Load', 'ODFRecalcMode', '1'],
];
export const PROFILE_XCU = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  ...SETTINGS.map(([p, k, v]) => `<item oor:path="${p}"><prop oor:name="${k}" oor:op="fuse"><value>${v}</value></prop></item>`),
  '</oor:items>',
  '',
].join('\n');

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  stderr: string;
}
export type RunFn = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<RunResult>;

/** 在独立进程组中运行；超时或结束后都对整组发 SIGKILL，清掉可能残留的子进程 */
export const realRun: RunFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const killGroup = () => {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL');
      } catch {
        // 进程组已经不存在
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    p.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += d.toString('utf8');
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code, timedOut, stderr: stderr.slice(0, STDERR_MAX) });
    });
  });

let tail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const r = tail.then(fn, fn);
  tail = r.catch(() => undefined);
  return r;
}

export interface ConvertOpts {
  run?: RunFn;
  timeoutMs?: number;
  tmpRoot?: string;
}

export function convertLegacy(file: string, format: LegacyFormat, o: ConvertOpts = {}): Promise<{ format: 'docx' | 'xlsx' | 'pptx'; buf: Buffer }> {
  return serial(async () => {
    const target = TARGET[format];
    const dir = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), 'opc-lo-'));
    try {
      const input = path.join(dir, `in.${format}`);
      fs.copyFileSync(file, input);
      const profile = path.join(dir, 'profile');
      fs.mkdirSync(path.join(profile, 'user'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), PROFILE_XCU);
      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      const args = ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--invisible', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', target, '--outdir', out, input];
      const env = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8' };
      let r: RunResult;
      try {
        r = await (o.run ?? realRun)('soffice', args, { cwd: dir, env, timeoutMs: o.timeoutMs ?? CONVERT_TIMEOUT_MS });
      } catch (e) {
        throw new ExtractError(422, (e as { code?: unknown }).code === 'ENOENT' ? LO_MISSING : LO_FAILED);
      }
      if (r.timedOut) throw new ExtractError(422, LO_TIMEOUT);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(out, `in.${target}`));
      } catch {
        throw new ExtractError(422, LO_FAILED);
      }
      if (!st.isFile() || st.size === 0 || st.size > OUT_MAX) throw new ExtractError(422, LO_FAILED);
      return { format: target, buf: fs.readFileSync(path.join(out, `in.${target}`)) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
