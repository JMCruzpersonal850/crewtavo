/**
 * Reading receipts and supplier invoices (apps/api/src/routes/receipts.ts): the company's switch, a
 * file sent to be read, and what comes back. Off, or when reading fails or takes too long, the form
 * is filled in by hand as it always was: nothing here throws at the person adding an expense.
 */
import type { MaterialCandidate, ReadField, ReceiptReading } from "@crewtavo/core/receipts";
import { api } from "@/lib/api";
import { base64Of, compressImage } from "@/lib/files";

/** What the server sends back for one file. */
export interface ReadAnswer {
  reading: ReceiptReading;
  fields: ReadField[];
  problems: string[];
  /** The job it names, among the person's (only when it wasn't read for a job already). */
  job: { id: string; number: number | null; title: string; why: "job_number" | "po_number" | "address" } | null;
  /** What its lines can be logged as on the job (the office with job costs), and the one each line seems to be. */
  candidates: MaterialCandidate[];
  matches: Array<number | null>;
}

/** The company's switch (settings.receipt_reading), which only the server turns on. */
export const readingOn = (settings: unknown) => (settings as { receipt_reading?: unknown } | null)?.receipt_reading === true;

/** How long the form waits for a reading before it's left to be filled in by hand. */
const READ_WAIT_MS = 60_000;

/** Read a picked file: what it says, or null (off, offline, too slow, or it couldn't be read). */
export async function readPickedFile(file: File, jobId: string | null): Promise<ReadAnswer | { failed: string }> {
  try {
    // A phone photo shrunk as it would be uploaded: Claude reads it as well, and it travels faster.
    const body = file.type.startsWith("image/") ? await compressImage(file, 2000, 0.85) : file;
    const ask = api.post<ReadAnswer>("/receipts/read", { file: await base64Of(body), job_id: jobId });
    const slow = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Reading it took too long. Fill it in by hand.")), READ_WAIT_MS));
    return await Promise.race([ask, slow]);
  } catch (error) {
    return { failed: error instanceof Error ? error.message : "It couldn't be read. Fill it in by hand." };
  }
}

const NAMES: Record<ReadField, string> = { vendor: "vendor", date: "date", amount: "total", tax: "tax", category: "category", lines: "line items" };
/** "vendor, date, total and tax" */
export function readFieldsText(fields: readonly ReadField[]): string {
  const names = fields.map((f) => NAMES[f]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

const WHY: Record<NonNullable<ReadAnswer["job"]>["why"], string> = { job_number: "its job number", po_number: "its PO number", address: "its address" };
/** "Job #1042 Birch drive (by its address)" */
export const suggestedJobText = (job: NonNullable<ReadAnswer["job"]>) => `Job #${job.number ?? "?"} ${job.title} (by ${WHY[job.why]})`;
