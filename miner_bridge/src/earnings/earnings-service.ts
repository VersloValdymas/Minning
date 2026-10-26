import type { AppConfig } from '../config.js';
import type { Pool } from '../db/pool.js';
import { powerToKw, priceToEurKwh, readHaState } from '../ha/ha-states.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../util/async.js';

const log = createLogger('earnings');

/**
 * Mining economics. Accurate account BTC from F2Pool; BTC/EUR from CoinGecko; electricity price and
 * whole-facility power from Home Assistant (Supervisor -> Core API). Profit = revenue - total facility
 * electricity (so ventilation/pumps are included). Per-day revenue and cost are accrued into
 * daily_earnings for cumulative profit and ROI vs a fixed fleet investment.
 */
export interface EarningsStatus {
  // F2Pool account
  configured: boolean;
  f2poolError: string | null;
  todayBtc: number | null;
  yesterdayBtc: number | null;
  totalBtc: number | null;
  unpaidBtc: number | null;
  paidBtc: number | null;
  // BTC price
  price: number | null;
  priceError: string | null;
  currency: string;
  // electricity price (EUR/kWh)
  electricity: number;
  electricitySource: 'ha' | 'fixed';
  priceEntity: string | null;
  // whole-facility power (kW) from HA; null = not configured
  totalPowerKw: number | null;
  powerEntity: string | null;
  powerAt: string | null;
  // economics / ROI
  investment: number;
  recoveredStart: number;
  cumulativeProfit: number; // recoveredStart + sum of daily profit
  roiStartDate: string | null;
  account: string | null;
  updatedAt: string | null;
}

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const F2POOL = 'https://api.f2pool.com/v2/assets/balance';
const FLUSH_MS = 3 * 60 * 1000;

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export class EarningsService {
  private status: EarningsStatus;
  private timer: NodeJS.Timeout | null = null;

  // in-memory accrual for the current UTC day (flushed to daily_earnings)
  private day = utcDay();
  private buf = { revenueEur: 0, minerCostEur: 0, overheadCostEur: 0, btc: 0 };
  private lastTodayBtc: number | null = null;
  private lastAccrueAt = 0;
  private dbCumulative = 0; // sum of daily profit already in DB (excludes the live buffer)
  private flushAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: AppConfig,
  ) {
    const e = cfg.earnings;
    this.status = {
      configured: Boolean(e.f2poolToken && e.f2poolAccount),
      f2poolError: null,
      todayBtc: null,
      yesterdayBtc: null,
      totalBtc: null,
      unpaidBtc: null,
      paidBtc: null,
      price: null,
      priceError: null,
      currency: e.currency,
      electricity: e.electricityEurKwh,
      electricitySource: 'fixed',
      priceEntity: e.haPriceEntity || null,
      totalPowerKw: null,
      powerEntity: e.haTotalPowerEntity || null,
      powerAt: null,
      investment: 0,
      recoveredStart: 0,
      cumulativeProfit: 0,
      roiStartDate: null,
      account: e.f2poolAccount || null,
      updatedAt: null,
    };
  }

  get current(): EarningsStatus {
    return this.status;
  }

  async init(): Promise<void> {
    await this.loadSettings();
    await this.loadDailyState();
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => undefined), this.cfg.earnings.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }

  // ---------------- settings (dashboard-editable) ----------------
  private async loadSettings(): Promise<void> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM settings WHERE key LIKE 'earnings_%'",
    );
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const num = (k: string, def: number) => (typeof m.get(k) === 'number' ? (m.get(k) as number) : def);
    this.status.electricity = num('earnings_electricity', this.cfg.earnings.electricityEurKwh);
    this.status.investment = num('earnings_investment', 0);
    this.status.recoveredStart = num('earnings_recovered_start', 0);
    this.status.roiStartDate = (m.get('earnings_roi_start') as string) ?? null;
  }

  private async setSetting(key: string, value: number | string): Promise<void> {
    const cast = typeof value === 'number' ? '$2::float8' : '$2::text';
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, to_jsonb(${cast}))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  async setElectricity(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error('Netinkama elektros kaina');
    this.status.electricity = value;
    await this.setSetting('earnings_electricity', value);
  }

  async setInvestment(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) throw new Error('Netinkama investicijos suma');
    this.status.investment = value;
    await this.setSetting('earnings_investment', value);
    if (!this.status.roiStartDate) {
      this.status.roiStartDate = utcDay();
      await this.setSetting('earnings_roi_start', this.status.roiStartDate);
    }
  }

  async setRecoveredStart(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) throw new Error('Netinkama suma');
    this.status.recoveredStart = value;
    await this.setSetting('earnings_recovered_start', value);
    this.recomputeCumulative();
  }

  // ---------------- daily accrual ----------------
  private async loadDailyState(): Promise<void> {
    const today = await this.pool.query<{ revenue_eur: number; miner_cost_eur: number; overhead_cost_eur: number; btc: number }>(
      'SELECT revenue_eur, miner_cost_eur, overhead_cost_eur, btc FROM daily_earnings WHERE day = $1',
      [this.day],
    );
    if (today.rows[0]) {
      const r = today.rows[0];
      this.buf = { revenueEur: r.revenue_eur, minerCostEur: r.miner_cost_eur, overheadCostEur: r.overhead_cost_eur, btc: r.btc };
    }
    await this.refreshDbCumulative();
  }

  private async refreshDbCumulative(): Promise<void> {
    // cumulative profit from all days EXCEPT today (today lives in the buffer)
    const { rows } = await this.pool.query<{ sum: number | null }>(
      'SELECT COALESCE(SUM(revenue_eur - miner_cost_eur - overhead_cost_eur), 0) AS sum FROM daily_earnings WHERE day <> $1',
      [this.day],
    );
    this.dbCumulative = Number(rows[0]?.sum ?? 0);
    this.recomputeCumulative();
  }

  private recomputeCumulative(): void {
    const todayProfit = this.buf.revenueEur - this.buf.minerCostEur - this.buf.overheadCostEur;
    this.status.cumulativeProfit = this.status.recoveredStart + this.dbCumulative + todayProfit;
  }

  /**
   * Called by the poller each cycle with the current miners power (kW). Accrues real revenue
   * (delta of F2Pool todayBtc) and real cost (facility power x price x elapsed) into the day buffer.
   */
  async accrue(minersKw: number, now = Date.now()): Promise<void> {
    const today = utcDay(new Date(now));
    if (today !== this.day) {
      await this.flush();
      this.day = today;
      this.buf = { revenueEur: 0, minerCostEur: 0, overheadCostEur: 0, btc: 0 };
      this.lastTodayBtc = null;
      await this.refreshDbCumulative();
    }

    const price = this.status.price;
    const elec = this.status.electricity;
    if (this.lastAccrueAt > 0 && price) {
      const dtH = (now - this.lastAccrueAt) / 3_600_000;
      if (dtH > 0 && dtH < 1) {
        // revenue: delta of F2Pool "today" BTC (cumulative since 00:00 UTC)
        if (this.status.todayBtc != null && this.lastTodayBtc != null) {
          const dBtc = this.status.todayBtc - this.lastTodayBtc;
          if (dBtc > 0) {
            this.buf.btc += dBtc;
            this.buf.revenueEur += dBtc * price;
          }
        }
        // cost: energy this interval x price. Total facility power if known, else miners only.
        const totalKw = this.status.totalPowerKw ?? minersKw;
        const overheadKw = Math.max(0, totalKw - minersKw);
        this.buf.minerCostEur += minersKw * elec * dtH;
        this.buf.overheadCostEur += overheadKw * elec * dtH;
      }
    }
    this.lastAccrueAt = now;
    this.lastTodayBtc = this.status.todayBtc;
    this.recomputeCumulative();

    if (now - this.flushAt > FLUSH_MS) await this.flush();
  }

  private async flush(): Promise<void> {
    this.flushAt = Date.now();
    try {
      await this.pool.query(
        `INSERT INTO daily_earnings (day, revenue_eur, miner_cost_eur, overhead_cost_eur, btc, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (day) DO UPDATE SET revenue_eur = $2, miner_cost_eur = $3, overhead_cost_eur = $4, btc = $5, updated_at = now()`,
        [this.day, this.buf.revenueEur, this.buf.minerCostEur, this.buf.overheadCostEur, this.buf.btc],
      );
    } catch (err) {
      log.debug(`daily_earnings flush failed: ${errorMessage(err)}`);
    }
  }

  /** Full-day BTC rate: yesterday's actual, else today's projected to 24 h. */
  private dailyBtcRate(): number | null {
    const s = this.status;
    if (s.yesterdayBtc && s.yesterdayBtc > 0) return s.yesterdayBtc;
    if (s.todayBtc == null) return null;
    const now = Date.now();
    const d = new Date();
    const frac = Math.max((now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86_400_000, 0.03);
    return s.todayBtc / frac;
  }

  /** Server-side fleet economics (also used for the MQTT sensors published back to HA). */
  fleetEconomics(minersKw: number) {
    const s = this.status;
    const totalKw = s.totalPowerKw ?? minersKw;
    const overheadKw = Math.max(0, totalKw - minersKw);
    const minerCost = minersKw * 24 * s.electricity;
    const overheadCost = overheadKw * 24 * s.electricity;
    const cost = minerCost + overheadCost;
    const dailyBtc = this.dailyBtcRate();
    const revenue = dailyBtc != null && s.price ? dailyBtc * s.price : null;
    const profit = revenue != null ? revenue - cost : null;
    const remaining = Math.max(0, s.investment - s.cumulativeProfit);
    const paybackDays = s.investment > 0 && profit && profit > 0 ? remaining / profit : null;
    return { dailyBtc, revenue, minerCost, overheadCost, cost, profit, totalKw, overheadKw, cumulativeProfit: s.cumulativeProfit, investment: s.investment, paybackDays, todayBtc: s.todayBtc, unpaidBtc: s.unpaidBtc };
  }

  /** Daily rows for charts / history. */
  async history(days: number): Promise<Array<{ day: string; revenue: number; cost: number; profit: number; btc: number }>> {
    const { rows } = await this.pool.query<{ day: Date; revenue_eur: number; miner_cost_eur: number; overhead_cost_eur: number; btc: number }>(
      'SELECT * FROM daily_earnings WHERE day > (now() - make_interval(days => $1::int))::date ORDER BY day',
      [days],
    );
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      revenue: r.revenue_eur,
      cost: r.miner_cost_eur + r.overhead_cost_eur,
      profit: r.revenue_eur - r.miner_cost_eur - r.overhead_cost_eur,
      btc: r.btc,
    }));
  }

  // ---------------- external data refresh ----------------
  async refresh(): Promise<EarningsStatus> {
    await Promise.all([this.refreshPrice(), this.refreshF2Pool(), this.refreshHa()]);
    this.status.updatedAt = new Date().toISOString();
    return this.status;
  }

  private async refreshPrice(): Promise<void> {
    if (this.cfg.earnings.btcPriceManual > 0) {
      this.status.price = this.cfg.earnings.btcPriceManual;
      this.status.priceError = null;
      return;
    }
    try {
      const res = await fetch(`${COINGECKO}?ids=bitcoin&vs_currencies=${this.cfg.earnings.currency.toLowerCase()}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { bitcoin?: Record<string, number> };
      const price = data.bitcoin?.[this.cfg.earnings.currency.toLowerCase()];
      if (!price) throw new Error('kaina negrąžinta');
      this.status.price = price;
      this.status.priceError = null;
    } catch (err) {
      this.status.priceError = errorMessage(err);
    }
  }

  /** Electricity price + whole-facility power from Home Assistant. */
  private async refreshHa(): Promise<void> {
    const { haPriceEntity, haTotalPowerEntity } = this.cfg.earnings;
    if (haPriceEntity) {
      const v = await readHaState(haPriceEntity);
      if (v) {
        this.status.electricity = priceToEurKwh(v);
        this.status.electricitySource = 'ha';
      } else {
        this.status.electricitySource = 'fixed';
      }
    }
    if (haTotalPowerEntity) {
      const v = await readHaState(haTotalPowerEntity);
      this.status.totalPowerKw = v ? powerToKw(v) : null;
      this.status.powerAt = v?.at ?? null;
    }
  }

  private async refreshF2Pool(): Promise<void> {
    const { f2poolToken, f2poolAccount } = this.cfg.earnings;
    this.status.configured = Boolean(f2poolToken && f2poolAccount);
    if (!this.status.configured) {
      this.status.f2poolError = null;
      return;
    }
    try {
      const res = await fetch(F2POOL, {
        method: 'POST',
        headers: { 'F2P-API-SECRET': f2poolToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency: 'bitcoin', mining_user_name: f2poolAccount }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await res.json()) as { code?: number; msg?: string; balance_info?: Record<string, string | number> };
      if (data.code && data.code !== 0) throw new Error(`F2Pool: ${data.msg ?? data.code}`);
      const b = data.balance_info ?? {};
      const num = (v: unknown) => (v === undefined || v === null ? null : Number(v));
      this.status.todayBtc = num(b.estimated_today_income);
      this.status.yesterdayBtc = num(b.yesterday_income);
      this.status.totalBtc = num(b.total_income);
      this.status.unpaidBtc = num(b.balance);
      this.status.paidBtc = num(b.paid);
      this.status.f2poolError = null;
    } catch (err) {
      this.status.f2poolError = errorMessage(err);
      log.warn(`F2Pool fetch failed: ${this.status.f2poolError}`);
    }
  }
}
