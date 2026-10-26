import type { AppConfig } from '../config.js';
import type { Pool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../util/async.js';

const log = createLogger('earnings');

/**
 * Mining earnings. Accurate ACCOUNT totals come from the F2Pool API (the pool knows real payouts);
 * BTC/EUR price from CoinGecko. Per-miner attribution is done in the UI by splitting the account
 * total proportionally by each miner's hashrate (all miners share one F2Pool worker, so the pool
 * itself cannot separate them). Electricity price turns revenue into profit.
 */
export interface EarningsStatus {
  configured: boolean;
  f2poolError: string | null;
  /** BTC, from F2Pool balance_info. */
  todayBtc: number | null; // estimated_today_income (since 00:00 UTC)
  yesterdayBtc: number | null; // full previous day
  totalBtc: number | null; // total_income
  unpaidBtc: number | null; // balance (before 00:00 UTC)
  paidBtc: number | null;
  /** BTC price in the chosen fiat (EUR). */
  price: number | null;
  priceError: string | null;
  currency: string;
  /** EUR/kWh used for profit. */
  electricity: number;
  account: string | null;
  updatedAt: string | null;
}

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const F2POOL = 'https://api.f2pool.com/v2/assets/balance';

export class EarningsService {
  private status: EarningsStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: AppConfig,
  ) {
    this.status = {
      configured: Boolean(cfg.earnings.f2poolToken && cfg.earnings.f2poolAccount),
      f2poolError: null,
      todayBtc: null,
      yesterdayBtc: null,
      totalBtc: null,
      unpaidBtc: null,
      paidBtc: null,
      price: null,
      priceError: null,
      currency: cfg.earnings.currency,
      electricity: cfg.earnings.electricityEurKwh,
      account: cfg.earnings.f2poolAccount || null,
      updatedAt: null,
    };
  }

  get current(): EarningsStatus {
    return this.status;
  }

  async init(): Promise<void> {
    await this.loadOverrides();
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => undefined), this.cfg.earnings.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async loadOverrides(): Promise<void> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM settings WHERE key IN ('earnings_electricity', 'earnings_price_manual')",
    );
    for (const r of rows) {
      if (r.key === 'earnings_electricity' && typeof r.value === 'number') this.status.electricity = r.value;
    }
  }

  /** Update the electricity price (EUR/kWh) from the dashboard. */
  async setElectricity(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error('Netinkama elektros kaina');
    this.status.electricity = value;
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ('earnings_electricity', to_jsonb($1::float8))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [value],
    );
  }

  async refresh(): Promise<EarningsStatus> {
    await Promise.all([this.refreshPrice(), this.refreshF2Pool()]);
    this.status.updatedAt = new Date().toISOString();
    return this.status;
  }

  private async refreshPrice(): Promise<void> {
    const manual = this.cfg.earnings.btcPriceManual;
    if (manual > 0) {
      this.status.price = manual;
      this.status.priceError = null;
      return;
    }
    try {
      const url = `${COINGECKO}?ids=bitcoin&vs_currencies=${this.cfg.earnings.currency.toLowerCase()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { bitcoin?: Record<string, number> };
      const price = data.bitcoin?.[this.cfg.earnings.currency.toLowerCase()];
      if (!price) throw new Error('kaina negrąžinta');
      this.status.price = price;
      this.status.priceError = null;
    } catch (err) {
      this.status.priceError = errorMessage(err);
      log.debug(`BTC price fetch failed: ${this.status.priceError}`);
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
      const data = (await res.json()) as {
        code?: number;
        msg?: string;
        balance_info?: {
          estimated_today_income?: string | number;
          yesterday_income?: string | number;
          total_income?: string | number;
          balance?: string | number;
          paid?: string | number;
        };
      };
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
