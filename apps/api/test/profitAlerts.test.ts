/**
 * The hourly job profit check (services/profitAlerts.ts) against a stand-in database: tables of rows
 * that eq and in filter, and the check's functions answering from `state`. What those functions do
 * in the database is tested in supabase/tests/job_profit_alerts_test.sql.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/supabase";
import { checkJobProfits } from "../src/services/profitAlerts";

type Row = Record<string, unknown>;
const CO = "00000000-0000-4000-8000-0000000000c1";

function fakeDb(tables: Record<string, Row[]>, companies: Row[], jobs: Row[]) {
  const recorded: Array<{ args: Row }> = [];
  const swept: string[] = [];
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
      range: () => builder,
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Row) => {
    if (fn === "profit_alert_companies") return { data: companies, error: null };
    if (fn === "profit_alert_jobs") return { data: jobs, error: null };
    if (fn === "record_profit_checks") {
      recorded.push({ args });
      return { data: (args.p_checks as Row[]).filter((c) => c.tell).length, error: null };
    }
    if (fn === "finish_profit_sweep") {
      swept.push(args.p_company as string);
      return { data: 1, error: null };
    }
    throw new Error(`unexpected ${fn}`);
  };
  return { db: { from, rpc } as unknown as Db, recorded, swept };
}

// Job #12 for Maria Lopez: $1,000, its line costs $300 to make, 10 hours at $50 and $120 of dump fees: 8% profit.
const tables = (): Record<string, Row[]> => ({
  jobs: [
    { id: "j12", company_id: CO, number: 12, kind: "one_off", status: "active", client: { display_name: "Maria Lopez" }, financials: { contract_total: "1000.00" }, lines: [{ quantity: 1, unit_cost: 300, unit_labor_cost: null }] },
    { id: "j13", company_id: CO, number: 13, kind: "one_off", status: "active", client: { display_name: "Sam Lee" }, financials: { contract_total: 2000 }, lines: [{ quantity: 1, unit_cost: 300 }] },
    { id: "w1", company_id: CO, number: 14, kind: "recurring", status: "active", client: null, financials: { contract_total: 50 }, lines: [{ quantity: 1, unit_cost: 40 }] },
  ],
  time_entries: [
    { id: "t1", company_id: CO, job_id: "j12", user_id: "u1", started_at: "2026-11-10T13:00:00Z", ended_at: "2026-11-10T23:00:00Z", labor_rate: null },
    { id: "t2", company_id: CO, job_id: "w1", user_id: "u1", started_at: "2026-11-10T13:00:00Z", ended_at: "2026-11-10T23:00:00Z", labor_rate: null },
  ],
  memberships: [{ company_id: CO, user_id: "u1", labor_rate: 50 }],
  expenses: [{ company_id: CO, job_id: "j12", amount: "120.00", in_line_costs: false }, { company_id: CO, job_id: "j12", amount: "999.00", in_line_costs: true }],
  job_materials: [],
  job_pay: [],
  job_profit_alerts: [],
});

describe("the hourly job profit check", () => {
  it("tells the office about a one-off job that went below the line, in the job page's numbers", async () => {
    const { db, recorded, swept } = fakeDb(tables(), [{ company_id: CO, line: 20, sweep: false }], [{ job_id: "j12", changed_at: "2026-11-13T10:00:00.123456+00:00" }, { job_id: "j13", changed_at: null }, { job_id: "w1", changed_at: null }]);
    expect(await checkJobProfits(db)).toEqual({ companies: 1, checked: 3, told: 1, listed: 0, failed: 0 });
    const checks = recorded[0]!.args.p_checks as Row[];
    expect(checks.find((c) => c.job_id === "j12")).toEqual({
      job_id: "j12", changed_at: "2026-11-13T10:00:00.123456+00:00", below: true, tell: true, margin: 8, title: "Job #12 for Maria Lopez is at 8% profit, below your 20%",
    });
    // Nothing spent on #13 yet, and a repeating job isn't held to the line.
    expect(checks.find((c) => c.job_id === "j13")).toMatchObject({ below: false, tell: false });
    expect(checks.find((c) => c.job_id === "w1")).toMatchObject({ below: false, tell: false });
    expect(swept).toEqual([]);
  });

  it("doesn't tell again about a job already below", async () => {
    const t = tables();
    t.job_profit_alerts = [{ company_id: CO, job_id: "j12", below: true }];
    const { db, recorded } = fakeDb(t, [{ company_id: CO, line: 20, sweep: false }], [{ job_id: "j12", changed_at: "2026-11-13T10:00:00Z" }]);
    expect((await checkJobProfits(db)).told).toBe(0);
    expect((recorded[0]!.args.p_checks as Row[])[0]).toMatchObject({ below: true, tell: false });
  });

  it("only lists the jobs below right after the line changes, and finishes the sweep", async () => {
    const { db, recorded, swept } = fakeDb(tables(), [{ company_id: CO, line: 20, sweep: true }], [{ job_id: "j12", changed_at: null }]);
    expect(await checkJobProfits(db)).toMatchObject({ told: 0, listed: 1 });
    expect((recorded[0]!.args.p_checks as Row[])[0]).toMatchObject({ below: true, tell: false });
    expect(swept).toEqual([CO]);
  });

  it("clears the notes of jobs that are gone", async () => {
    const { db, recorded } = fakeDb(tables(), [{ company_id: CO, line: 20, sweep: false }], [{ job_id: "gone", changed_at: "2026-11-13T10:00:00Z" }]);
    await checkJobProfits(db);
    expect(recorded[0]!.args.p_checks).toEqual([{ job_id: "gone", changed_at: "2026-11-13T10:00:00Z", below: false, tell: false, margin: null, title: null }]);
  });
});
