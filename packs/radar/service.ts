import type { AppConfig } from '../../packages/core/config.ts';
import type { DB } from '../../packages/core/db.ts';
import { Llm } from '../../packages/core/llm.ts';
import { Reach } from '../../packages/core/reach.ts';
import { analyzePending, retagPending } from './analyze.ts';
import { collectOnce, syncSources } from './collect.ts';
import { enrichPending } from './enrich.ts';
import { TopicMatcher, loadTopics } from './text.ts';
import type { Topic } from './text.ts';

/** 每轮最多重新归类的历史条目数（40 条/次模型调用） */
const RETAG_PER_RUN = 1200;

export interface RunState {
  running: boolean;
  phase: string;
  startedAt: number | null;
  lastFinishedAt: number | null;
  lastResult: string | null;
}

export class Radar {
  readonly db: DB;
  readonly cfg: AppConfig;
  readonly llm: Llm;
  readonly reach: Reach;
  readonly topics: Topic[];
  readonly matcher: TopicMatcher;
  readonly state: RunState = { running: false, phase: 'idle', startedAt: null, lastFinishedAt: null, lastResult: null };
  private timer: NodeJS.Timeout | null = null;
  private log: (s: string) => void;

  constructor(db: DB, cfg: AppConfig, log: (s: string) => void = (s) => console.log(s)) {
    this.db = db;
    this.cfg = cfg;
    this.log = log;
    this.llm = new Llm(cfg.llm);
    this.reach = new Reach();
    this.topics = loadTopics();
    this.matcher = new TopicMatcher(this.topics);
    syncSources(db);
  }

  /** 单飞：同一时间只跑一轮采集+分析 */
  async runCycle(): Promise<string> {
    if (this.state.running) return '已有任务在运行';
    this.state.running = true;
    this.state.startedAt = Date.now();
    try {
      this.state.phase = '采集中';
      this.log(`[radar] 开始采集 ${new Date().toISOString()}`);
      const s = await collectOnce(this.db, this.matcher, { maxAgeDays: this.cfg.maxAgeDays, reach: this.reach, log: this.log });
      if (this.llm.enabled && this.cfg.fulltextLimit > 0) {
        this.state.phase = '读取全文';
        await enrichPending(this.db, this.reach, this.cfg.fulltextLimit, this.cfg.llm.analyzeLimitPerRun, this.log);
      }
      this.state.phase = '分析中';
      const analyzed = await analyzePending(this.db, this.llm, this.topics, this.cfg.llm.analyzeLimitPerRun, this.log);
      if (this.llm.enabled) {
        this.state.phase = '主题校准';
        const n = await retagPending(this.db, this.llm, this.topics, RETAG_PER_RUN, this.log);
        if (n) this.log(`  主题校准：${n} 条`);
      }
      this.db.prepare('UPDATE runs SET analyzed=?, finished_at=? WHERE id=?').run(analyzed, Date.now(), s.runId);
      const msg = `源成功 ${s.okSources}，失败 ${s.failedSources}，新增 ${s.newItems}，分析 ${analyzed}${this.llm.enabled ? '' : '（未配置 DEEPSEEK_API_KEY，跳过分析）'}`;
      this.log(`[radar] 完成：${msg}`);
      this.state.lastResult = msg;
      return msg;
    } catch (e) {
      const msg = `运行失败：${e instanceof Error ? e.message : e}`;
      this.state.lastResult = msg;
      this.log(`[radar] ${msg}`);
      return msg;
    } finally {
      this.state.running = false;
      this.state.phase = 'idle';
      this.state.lastFinishedAt = Date.now();
    }
  }

  startSchedule(): void {
    const ms = this.cfg.fetchIntervalMin * 60 * 1000;
    setTimeout(() => void this.runCycle(), 5000).unref();
    this.timer = setInterval(() => void this.runCycle(), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
