import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications } from "../db/schema";

export class ImportError extends Error {}

/** Recognised header spellings per field, compared after lowercasing and stripping non-alphanumerics. */
const ALIASES = {
  applicationId: ["applicationid", "applicationnumber", "applicationno", "appid", "application", "id", "referenceid", "reference"],
  applicantName: ["applicantname", "applicant", "fullname", "customername", "borrowername", "name"],
  employerName: ["employername", "employer", "companyname", "company", "employerorganisation", "employerorganization"],
  statedIncomeAmount: ["statedincomeamount", "statedincome", "incomeamount", "income", "annualincome", "statedsalary", "salary", "grossincome"],
  statedIncomeBasis: ["statedincomebasis", "incomebasis", "basis", "incomefrequency", "incomeperiod", "payfrequency", "frequency", "period"],
  statedMonthlyIncome: ["statedmonthlyincome", "monthlyincome", "monthlystatedincome", "monthlysalary", "monthly"],
  currency: ["currency", "currencycode", "ccy"],
} as const;
type Field = keyof typeof ALIASES;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    return "";
  }
  return String(v).trim();
}

async function readRows(fileName: string, data: Buffer): Promise<string[][]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) {
    const records = parseCsv(data.toString("utf8"), { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as string[][];
    return records;
  }
  if (lower.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(data as unknown as ArrayBuffer);
    } catch {
      throw new ImportError("The file is not a valid .xlsx workbook.");
    }
    const ws = wb.worksheets.find((s) => s.actualRowCount > 0);
    if (!ws) throw new ImportError("The workbook has no data.");
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.actualColumnCount; c++) cells.push(cellText(row.getCell(c).value));
      rows.push(cells);
    });
    return rows;
  }
  throw new ImportError("Only .xlsx and .csv files can be imported.");
}

function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t || !/[0-9]/.test(t)) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

export async function importApplications(db: Db, fileName: string, data: Buffer): Promise<ImportSummary> {
  const rows = await readRows(fileName, data);
  if (rows.length < 2) throw new ImportError("The file needs a header row and at least one data row.");
  const header = rows[0]!.map(norm);
  const col: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(ALIASES) as Field[]) {
    const idx = header.findIndex((h) => (ALIASES[field] as readonly string[]).includes(h));
    if (idx >= 0) col[field] = idx;
  }
  if (col.applicationId === undefined) {
    throw new ImportError("No application ID column found. Expected a header such as 'Application ID'.");
  }

  const warnings: string[] = [];
  for (const f of ["applicantName", "employerName", "statedIncomeAmount", "currency"] as Field[]) {
    if (col[f] === undefined) warnings.push(`No column recognised for ${f}; those values will be empty.`);
  }
  const get = (r: string[], f: Field) => (col[f] === undefined ? "" : (r[col[f]!] ?? "").trim());

  const byId = new Map<string, typeof applications.$inferInsert>();
  let skipped = 0;
  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const id = get(r, "applicationId");
    if (!id) {
      skipped += 1;
      warnings.push(`Row ${rowNo}: missing application ID; skipped.`);
      return;
    }
    if (byId.has(id)) warnings.push(`Row ${rowNo}: duplicate application ID ${id}; the later row wins.`);
    const cur = get(r, "currency").toUpperCase();
    if (cur && !/^[A-Z]{3}$/.test(cur)) warnings.push(`Row ${rowNo}: currency "${cur}" is not a 3-letter code; stored empty.`);
    const amountRaw = get(r, "statedIncomeAmount");
    const monthlyRaw = get(r, "statedMonthlyIncome");
    if (amountRaw && parseMoney(amountRaw) === null) warnings.push(`Row ${rowNo}: stated income "${amountRaw}" is not a number; stored empty.`);
    if (monthlyRaw && parseMoney(monthlyRaw) === null) warnings.push(`Row ${rowNo}: monthly income "${monthlyRaw}" is not a number; stored empty.`);
    byId.set(id, {
      applicationId: id,
      applicantName: get(r, "applicantName") || null,
      employerName: get(r, "employerName") || null,
      statedIncomeAmount: parseMoney(amountRaw),
      statedIncomeBasis: get(r, "statedIncomeBasis") || null,
      statedMonthlyIncome: parseMoney(monthlyRaw),
      currency: /^[A-Z]{3}$/.test(cur) ? cur : null,
      sourceFileName: fileName,
      importedAt: new Date(),
    });
  });

  const values = [...byId.values()];
  if (values.length === 0) return { imported: 0, updated: 0, skipped, warnings };
  const ids = values.map((v) => v.applicationId);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const found = await db.select({ id: applications.applicationId }).from(applications).where(inArray(applications.applicationId, ids.slice(i, i + 1000)));
    found.forEach((f) => existing.add(f.id));
  }
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(applications).values(values.slice(i, i + 500)).onConflictDoUpdate({
      target: applications.applicationId,
      set: {
        applicantName: sql`excluded.applicant_name`,
        employerName: sql`excluded.employer_name`,
        statedIncomeAmount: sql`excluded.stated_income_amount`,
        statedIncomeBasis: sql`excluded.stated_income_basis`,
        statedMonthlyIncome: sql`excluded.stated_monthly_income`,
        currency: sql`excluded.currency`,
        sourceFileName: sql`excluded.source_file_name`,
        importedAt: sql`excluded.imported_at`,
      },
    });
  }
  return { imported: values.length - existing.size, updated: existing.size, skipped, warnings };
}
