import type { AppConfig } from '../../packages/core/config.ts';
import type { DB } from '../../packages/core/db.ts';
import { Llm } from '../../packages/core/llm.ts';
import { Reach } from '../../packages/core/reach.ts';
import { analyzePending, retagPending } from './analyze.ts';
import { clusterRecent } from './cluster.ts';
import { collectOnce, resetSourceCache, syncSources } from './collect.ts';
import { enrichPending } from './enrich.ts';
import { feedWiki } from './feed.ts';
import { purgeItems } from './purge.ts';
import type { PurgeRange } from './purge.ts';
import { lensFor, migrateLegacyProfile } from './profiles.ts';
import { TopicMatcher, loadTopics } from './text.ts';
import type { Lens } from './text.ts';
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
  private analyzeContext?: () => string;

  constructor(db: DB, cfg: AppConfig, log: (s: string) => void = (s) => console.log(s), opts: { analyzeContext?: () => string } = {}) {
    this.db = db;
    this.cfg = cfg;
    this.log = log;
    this.analyzeContext = opts.analyzeContext;
    this.llm = new Llm(cfg.llm);
    this.reach = new Reach();
    this.topics = loadTopics();
    this.matcher = new TopicMatcher(this.topics);
    syncSources(db);
    migrateLegacyProfile(db);
  }

  /** 当前职业身份的分析口径 */
  profileLens(): Lens {
    return lensFor(this.db, this.topics);
  }

  /** 单飞：同一时间只跑一轮采集+分析 */
  async runCycle(opts: { regenerate?: Required<PurgeRange> } = {}): Promise<string> {
    if (this.state.running) return '已有任务在运行';
    this.state.running = true;
    this.state.startedAt = Date.now();
    try {
      let regenNote = '';
      if (opts.regenerate) {
        // 重新生成：先清掉该时段的条目（不记已删网址），并让所有源忽略「未修改」缓存，再走完整的采集→分析流程
        this.state.phase = '清理旧内容';
        const r = purgeItems(this.db, opts.regenerate, { tombstone: false });
        const n = resetSourceCache(this.db);
        regenNote = `重新生成：清除 ${r.deleted} 条，`;
        this.log(`[radar] 重新生成：清除 ${r.deleted} 条旧内容，${n} 个信息源将完整重新获取`);
      }
      this.state.phase = '采集中';
      this.log(`[radar] 开始采集 ${new Date().toISOString()}`);
      const s = await collectOnce(this.db, this.matcher, { maxAgeDays: this.cfg.maxAgeDays, reach: this.reach, log: this.log });
      if (this.llm.enabled && this.cfg.fulltextLimit > 0) {
        this.state.phase = '读取全文';
        await enrichPending(this.db, this.reach, this.cfg.fulltextLimit, this.cfg.llm.analyzeLimitPerRun, this.log);
      }
      const analyzeStart = Date.now();
      this.state.phase = '分析中';
      const analyzed = await analyzePending(this.db, this.llm, this.topics, this.cfg.llm.analyzeLimitPerRun, this.log, this.analyzeContext, this.profileLens());
      if (this.llm.enabled && analyzed) {
        this.state.phase = '事件归并';
        try {
          const n = await clusterRecent(this.db, this.llm, analyzeStart, this.log);
          if (n) this.log(`  事件归并：${n} 条并入同一事件`);
        } catch (e) {
          this.log(`  事件归并出错：${e instanceof Error ? e.message : e}`);
        }
      }
      if (this.llm.enabled) {
        try {
          const n = feedWiki(this.db);
          if (n) this.log(`  情报入知识库：${n} 份（日报或与你相关的资讯），稍后由 Wiki 编入`);
        } catch (e) {
          this.log(`  情报入知识库出错：${e instanceof Error ? e.message : e}`);
        }
      }
      if (this.llm.enabled) {
        this.state.phase = '主题校准';
        const n = await retagPending(this.db, this.llm, this.topics, RETAG_PER_RUN, this.log);
        if (n) this.log(`  主题校准：${n} 条`);
      }
      this.db.prepare('UPDATE runs SET analyzed=?, finished_at=? WHERE id=?').run(analyzed, Date.now(), s.runId);
      const msg = `${regenNote}源成功 ${s.okSources}，失败 ${s.failedSources}，新增 ${s.newItems}，分析 ${analyzed}${this.llm.enabled ? '' : '（未配置 DEEPSEEK_API_KEY，跳过分析）'}`;
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
