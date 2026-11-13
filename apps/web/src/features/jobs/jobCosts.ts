/**
 * The job page's costs, counted the way Finance → Profit and AI assistants count them (jobProfit in
 * packages/core/src/reports.ts): line items at cost, labor (time at its rates), sub and crew pay
 * (agreed, done or paid: public.job_pay_costs) and expenses. Once a job has labor of its own that
 * costs something (time on it at a rate, or sub and crew pay), its line items count without the labor
 * estimate their cost has in it, so that labor isn't counted twice. Time that costs nothing yet (no
 * rate set, or a clock still running) leaves the estimate in.
 *
 * Materials aren't counted twice either. A material logged against one of the job's lines (a load
 * ticket for the tons a line estimated) counts at the logged amount in place of the line's estimate
 * (materialUse), and an expense marked as already in the line items' costs (the supplier's invoice
 * for materials the estimate covers) isn't added on top of them.
 */
import { lineCosts, materialUse, type CostedLine, type CostedMaterial } from "@crewtavo/core/reports";
import { formatMoneyCents } from "@/lib/format";

/** Dollars and cents for an AnimatedNumber, the way formatMoneyCents writes them: "$1,250.00". */

export interface JobCostInput {
  contract: number;
  lines: readonly CostedLine[];
  /** Time on the job at its rates. */
  labor: number;
  /** Expenses that count: those not marked as already in the line items' costs. */
  expenses: number;
  /** Expenses marked as already in the line items' costs. */
  expensesInLines?: number;
  /** Materials logged on the job (job_materials). */
  logged?: readonly CostedMaterial[];
  /** public.job_pay_costs for the job: nothing when it has none. */
  crewPay: ReadonlyArray<{ amount: number | string | null; payees: number }>;
  /**
   * Extra work on a repeating job's visits (core costedExtras): what it's billed at, on top of the
   * job's price, and its lines, costed as the job's are.
   */
  extras?: { price: number; lines: readonly CostedLine[] };
}

/** The rule for logged materials, said on the Materials card and under the job's costs. */
export const LOGGED_MATERIALS_RULE = "Once a material on this job's line items is logged, job costing counts the amount logged, at the line's cost, in place of the estimate.";

export function jobCosts(input: JobCostInput) {
  const crew = input.crewPay.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const actualLabor = input.labor > 0 || input.crewPay.length > 0;
  const lines = lineCosts([...input.lines, ...(input.extras?.lines ?? [])], actualLabor);
  const logged = materialUse(input.lines, input.logged ?? [], actualLabor);
  const materials = lines.materials + logged.adjustment;
  const total = materials + input.labor + crew + input.expenses;
  const extras = input.extras?.price ?? 0;
  const price = input.contract + extras;
  const profit = price - total;
  const compared = logged.rows.filter((r) => r.estimated !== null);
  const inLines = input.expensesInLines ?? 0;
  return {
    materials,
    leftOut: lines.left_out,
    labor: input.labor,
    crew,
    expenses: input.expenses,
    total,
    profit,
    margin: price > 0 ? Math.round((profit / price) * 100) : null,
    /** What the extra work is billed at: counted with the price, and shown on a line of its own. */
    extras,
    actualLabor,
    /** Each logged material against the lines' estimate for it (Materials used shows them). */
    materialRows: logged.rows,
    /** What logged materials changed the line item costs by. */
    materialAdjustment: logged.adjustment,
    /** The one line under the costs when line items count materials only. */
    note: actualLabor && lines.left_out > 0
      ? `Line item costs count materials only, since this job has its own labor: the ${formatMoneyCents(lines.left_out)} of labor estimated in them isn't counted twice.`
      : null,
    /** Under the costs when logged materials stand in for a line's estimate. */
    materialNote: compared.length
      ? `Line item costs count ${compared.length === 1 ? compared[0]!.name : `${compared.length} materials`} as logged, not as estimated: ${logged.adjustment === 0 ? "the same as" : `${formatMoneyCents(Math.abs(logged.adjustment))} ${logged.adjustment > 0 ? "over" : "under"}`} the estimate.`
      : null,
    /** Under the costs when some expenses are left out as already in the line items. */
    expenseNote: inLines > 0 ? `${formatMoneyCents(inLines)} of expenses are marked as already in the line item costs, so they aren't counted again.` : null,
  };
}
