import { monthlyEquivalent, normalizeBasis, WINDOW_MONTHS } from "./basis";
import { applicantsMatch, employersMatch } from "./names";
import { expectedMonths, payMonthOf } from "./months";
import { minorUnitDigits, toMinor, validatePayEvidence } from "./payEvidence";
import {
  CHECK_ORDER,
  type CheckId,
  type CheckResult,
  type CheckStatus,
  type DocumentAnnotation,
  type EmployerAggregate,
  type EngineDocument,
  type EngineInput,
  type EngineResult,
  type PayValidation,
  type ResultState,
} from "./types";

/** Section 6.5: inclusive band, expressed in basis points to avoid float drift. */
export const BAND_MIN_BP = 7000;
export const BAND_MAX_BP = 13000;

const TITLES: Record<CheckId, string> = {
  documents_readable: "Documents readable",
  payslips_identified: "Payslips identified",
  pay_evidence_consistency: "Pay evidence consistent",
  employer_match: "Employer matches application",
  single_employer: "Single employer",
  applicant_match: "Applicant matches application",
  applicant_consistent: "Applicant name consistent across payslips",
  payslip_count: "Four payslips counted",
  month_coverage: "Month coverage",
  currency_match: "Currency matches application",
  income_within_band: "Income within 70%-130% of stated",
};

interface Slip {
  doc: EngineDocument;
  payMonth: string | null;
  validation: PayValidation;
  grossValue: number | null;
  groupIndex: number;
}

interface Group {
  label: string;
  rep: string | null;
  slips: Slip[];
}

function effectiveGross(doc: EngineDocument): number | null {
  const g = doc.grossPay ?? doc.payEvidence?.gross.amount ?? null;
  return g !== null && Number.isFinite(g) ? g : null;
}

export function verify(input: EngineInput): EngineResult {
  const { stated, documents, submittedAt } = input;
  const expected = expectedMonths(submittedAt, WINDOW_MONTHS);
  const results = new Map<CheckId, CheckResult>();
  const put = (id: CheckId, status: CheckStatus, reason: string, evidence: Record<string, unknown> = {}) => {
    results.set(id, { id, title: TITLES[id], status, reason, evidence });
  };

  const annotations = new Map<string, DocumentAnnotation>();
  for (const d of documents) {
    annotations.set(d.id, {
      id: d.id,
      payMonth: null,
      employerGroup: null,
      inWindow: false,
      includedInAggregate: false,
      exclusionReasons: [],
      payValidation: null,
    });
  }
  const ann = (d: EngineDocument) => annotations.get(d.id)!;

  // ---- Target (6.1) ------------------------------------------------------
  let expectedWindowIncome: number | null = null;
  let targetNote = "";
  if (stated.incomeAmount !== null && stated.incomeAmount > 0) {
    expectedWindowIncome = monthlyEquivalent(stated.incomeAmount, stated.incomeBasis) * WINDOW_MONTHS;
    targetNote = `basis ${normalizeBasis(stated.incomeBasis)}`;
  } else if (stated.monthlyIncome !== null && stated.monthlyIncome > 0) {
    expectedWindowIncome = stated.monthlyIncome * WINDOW_MONTHS;
    targetNote = "stated monthly income (no usable stated amount)";
  }

  // ---- Readability and identification -----------------------------------
  const readable = documents.filter((d) => d.extractionOk);
  const unreadable = documents.filter((d) => !d.extractionOk);
  const identified = readable.filter((d) => d.isPayslip === true);
  const nonPayslips = readable.filter((d) => d.isPayslip !== true);

  for (const d of unreadable) {
    ann(d).exclusionReasons.push(`Could not be read: ${d.extractionError ?? "extraction failed"}.`);
  }
  for (const d of nonPayslips) ann(d).exclusionReasons.push("Not identified as a payslip.");

  if (readable.length === 0) {
    put("documents_readable", "fail", "No uploaded document could be read.", { unreadable: unreadable.map((d) => d.fileName) });
  } else if (unreadable.length > 0) {
    put("documents_readable", "warn", `${unreadable.length} of ${documents.length} document(s) could not be read.`, {
      unreadable: unreadable.map((d) => d.fileName),
    });
  } else {
    put("documents_readable", "pass", `All ${documents.length} document(s) were read.`);
  }

  if (identified.length === 0) {
    put("payslips_identified", "fail", "No payslips were identified in the upload.");
  } else if (nonPayslips.length > 0) {
    put("payslips_identified", "warn", `${identified.length} payslip(s) identified; ${nonPayslips.length} other document(s) ignored.`, {
      ignored: nonPayslips.map((d) => d.fileName),
    });
  } else {
    put("payslips_identified", "pass", `${identified.length} payslip(s) identified.`);
  }

  // ---- Per-slip validation, employer grouping ---------------------------
  const groups: Group[] = [];
  const slips: Slip[] = identified.map((doc) => {
    const validation = validatePayEvidence(doc, stated.currency);
    const payMonth = payMonthOf(doc.payDate) ?? payMonthOf(doc.payPeriodEnd);
    const name = doc.employerName?.trim() || null;
    // Slips with no employer name share one "unknown" group; they can never match the stated employer.
    let gi = groups.findIndex((g) => (name === null ? g.rep === null : g.rep !== null && employersMatch(g.rep, name)));
    if (gi === -1) {
      groups.push({ label: doc.employerName?.trim() || "Unknown employer", rep: doc.employerName?.trim() || null, slips: [] });
      gi = groups.length - 1;
    }
    const slip: Slip = { doc, payMonth, validation, grossValue: effectiveGross(doc), groupIndex: gi };
    groups[gi]!.slips.push(slip);
    const a = ann(doc);
    a.payMonth = payMonth;
    a.employerGroup = groups[gi]!.label;
    a.payValidation = validation;
    a.inWindow = payMonth !== null && expected.includes(payMonth);
    return slip;
  });

  // pay_evidence_consistency: any identified payslip, counted or not (6.4).
  const badEvidence = slips.filter((s) => s.validation.status !== "consistent");
  if (slips.length === 0) {
    put("pay_evidence_consistency", "skipped", "No payslips to validate.");
  } else if (badEvidence.length > 0) {
    put(
      "pay_evidence_consistency",
      "fail",
      `${badEvidence.length} payslip(s) have unresolved or inconsistent pay evidence: ` +
        badEvidence.map((s) => `${s.doc.fileName} (${s.validation.status}: ${s.validation.reasons.join(" ")})`).join("; "),
      { files: badEvidence.map((s) => s.doc.fileName) },
    );
  } else {
    put("pay_evidence_consistency", "pass", "Gross, deductions and net reconcile on every identified payslip.");
  }

  // ---- Working employer group -------------------------------------------
  let working: Group | null = null;
  if (groups.length > 0) {
    const matching = groups.filter((g) => employersMatch(g.rep, stated.employerName));
    const pool = matching.length > 0 ? matching : groups;
    working = pool.reduce((best, g) => (g.slips.length > best.slips.length ? g : best));
  }

  if (!working) {
    put("employer_match", "skipped", "No payslips to compare.");
    put("single_employer", "skipped", "No payslips to compare.");
  } else {
    if (!stated.employerName) {
      put("employer_match", "fail", "The application has no stated employer to compare against.");
    } else if (employersMatch(working.rep, stated.employerName)) {
      put("employer_match", "pass", `Payslip employer "${working.label}" matches stated employer "${stated.employerName}".`);
    } else {
      put("employer_match", "fail", `Payslip employer "${working.label}" does not match stated employer "${stated.employerName}".`);
    }
    const others = groups.filter((g) => g !== working);
    const othersInWindow = others.filter((g) => g.slips.some((s) => s.payMonth !== null && expected.includes(s.payMonth)));
    if (others.length === 0) {
      put("single_employer", "pass", "All payslips are from one employer.");
    } else if (othersInWindow.length > 0) {
      put("single_employer", "fail", `Payslips within the window come from multiple employers: ${[working, ...othersInWindow].map((g) => g.label).join(", ")}.`);
    } else {
      put("single_employer", "warn", `Payslips from other employer(s) exist outside the window: ${others.map((g) => g.label).join(", ")}.`);
    }
  }

  // ---- Selection (6.3) ---------------------------------------------------
  // DECISION: fixed rather than preserved. We pick one payslip per expected
  // month *before* filtering for validity, so duplicate or out-of-window
  // months can never occupy a slot ahead of a required older month.
  const selected: Slip[] = [];
  const counted: Slip[] = [];
  for (const s of slips) {
    if (working && groups[s.groupIndex] !== working) {
      ann(s.doc).exclusionReasons.push(`Belongs to a different employer group (${groups[s.groupIndex]!.label}).`);
    }
  }
  const undated: Slip[] = [];
  if (working) {
    for (const s of working.slips) {
      if (s.payMonth === null) {
        undated.push(s);
        ann(s.doc).exclusionReasons.push("No readable pay date; cannot be assigned to a month.");
      } else if (!expected.includes(s.payMonth)) {
        ann(s.doc).exclusionReasons.push(`Pay month ${s.payMonth} is outside the expected window (${expected[expected.length - 1]} to ${expected[0]}).`);
      }
    }
    const rank = (s: Slip) =>
      (s.grossValue !== null && s.validation.status !== "inconsistent" ? 0 : 2) +
      (s.validation.status === "consistent" ? 0 : 1);
    for (const month of expected) {
      const cands = working.slips.filter((s) => s.payMonth === month);
      if (cands.length === 0) continue;
      const ordered = [...cands].sort(
        (a, b) => rank(a) - rank(b) || (b.doc.payDate ?? "").localeCompare(a.doc.payDate ?? ""),
      );
      const [winner, ...dupes] = ordered as [Slip, ...Slip[]];
      selected.push(winner);
      for (const d of dupes) ann(d.doc).exclusionReasons.push(`Duplicate payslip for ${month}; another payslip was selected for that month.`);
      // Exclusions applied only after selection: unreadable gross / inconsistent evidence.
      const a = ann(winner.doc);
      if (winner.grossValue === null) a.exclusionReasons.push("Gross pay is missing or unreadable.");
      else if (winner.validation.status === "inconsistent") a.exclusionReasons.push("Pay evidence is inconsistent.");
      else counted.push(winner);
    }
  }
  for (const s of counted) ann(s.doc).includedInAggregate = true;

  // ---- Applicant checks --------------------------------------------------
  const nameSource = selected.length > 0 ? selected : working ? working.slips : [];
  const named = nameSource.filter((s) => (s.doc.applicantName ?? "").trim() !== "");
  if (nameSource.length === 0) {
    put("applicant_match", "skipped", "No payslips to compare.");
    put("applicant_consistent", "skipped", "No payslips to compare.");
  } else {
    const matchesStated = named.filter((s) => applicantsMatch(s.doc.applicantName, stated.applicantName));
    if (!stated.applicantName) {
      put("applicant_match", "fail", "The application has no stated applicant name to compare against.");
    } else if (named.length === 0) {
      put("applicant_match", "fail", "No selected payslip shows an applicant name, so identity cannot be verified.");
    } else if (matchesStated.length === 0) {
      put(
        "applicant_match",
        "fail",
        `Applicant "${stated.applicantName}" does not match the name on any selected payslip (${[...new Set(named.map((s) => s.doc.applicantName))].join(", ")}).`,
      );
    } else if (named.length < nameSource.length) {
      put("applicant_match", "warn", `Name matches on ${matchesStated.length} payslip(s); ${nameSource.length - named.length} show no name.`);
    } else {
      put("applicant_match", "pass", "Applicant name matches the selected payslips.");
    }
    const anchor = named[0]?.doc.applicantName ?? null;
    const disagree = named.filter((s) => !applicantsMatch(s.doc.applicantName, anchor));
    if (named.length === 0) {
      put("applicant_consistent", "skipped", "No names to compare.");
    } else if (disagree.length > 0) {
      put("applicant_consistent", "fail", `Applicant names differ across payslips: ${[...new Set(named.map((s) => s.doc.applicantName))].join(", ")}.`);
    } else {
      put("applicant_consistent", "pass", "Applicant name is the same on every named payslip.");
    }
  }

  // ---- Count and coverage -----------------------------------------------
  const countedMonths = [...new Set(counted.map((s) => s.payMonth!))];
  const missingMonths = expected.filter((m) => !countedMonths.includes(m));
  if (counted.length === WINDOW_MONTHS) {
    put("payslip_count", "pass", `${WINDOW_MONTHS} payslips counted.`);
  } else {
    put("payslip_count", "fail", `${counted.length} of ${WINDOW_MONTHS} required payslips could be counted.`, { counted: counted.length });
  }
  if (missingMonths.length === 0 && countedMonths.length === WINDOW_MONTHS) {
    if (undated.length > 0) {
      put("month_coverage", "warn", `All ${WINDOW_MONTHS} months covered; ${undated.length} undated payslip(s) were ignored.`, { expected });
    } else {
      put("month_coverage", "pass", `All ${WINDOW_MONTHS} expected months are covered (${expected.join(", ")}).`, { expected });
    }
  } else {
    put("month_coverage", "fail", `Missing month(s): ${missingMonths.join(", ")}.`, { expected, missing: missingMonths });
  }

  // ---- Currency ----------------------------------------------------------
  const stCur = stated.currency?.trim().toUpperCase() || null;
  if (counted.length === 0) {
    put("currency_match", "skipped", "No counted payslips.");
  } else if (!stCur) {
    put("currency_match", "fail", "The application has no stated currency, so payslip currency cannot be verified.");
  } else {
    const curs = counted.map((s) => s.doc.currency?.trim().toUpperCase() ?? s.validation.currency?.toUpperCase() ?? null);
    const explicit = counted.filter((s) => s.doc.currency);
    const wrong = explicit.filter((s) => s.doc.currency!.trim().toUpperCase() !== stCur);
    if (wrong.length > 0) {
      put("currency_match", "fail", `Payslip currency ${[...new Set(wrong.map((s) => s.doc.currency!.toUpperCase()))].join(", ")} differs from stated ${stCur}.`);
    } else if (explicit.length < counted.length) {
      put("currency_match", "warn", `${counted.length - explicit.length} payslip(s) do not state a currency; assumed ${stCur}.`, { curs });
    } else {
      put("currency_match", "pass", `All counted payslips are in ${stCur}.`);
    }
  }

  // ---- Income band -------------------------------------------------------
  let incomeRatio: number | null = null;
  let calculated: number | null = null;
  const blocked = counted.length !== WINDOW_MONTHS || results.get("month_coverage")!.status === "fail" || results.get("currency_match")!.status === "fail";
  if (blocked) {
    put("income_within_band", "skipped", "Not evaluated because the payslip set is incomplete or in the wrong currency; this is not treated as low income.");
  } else if (expectedWindowIncome === null) {
    put("income_within_band", "fail", "The application has no usable stated income, so the ratio cannot be computed.");
  } else {
    const cur = stCur;
    const totalMinor = counted.reduce((sum, s) => sum + toMinor(s.grossValue!, cur), 0);
    const targetMinor = toMinor(expectedWindowIncome, cur);
    const digits = minorUnitDigits(cur);
    calculated = totalMinor / 10 ** digits;
    const bp = Math.round((totalMinor * 10000) / targetMinor);
    incomeRatio = bp / 10000;
    const inBand = bp >= BAND_MIN_BP && bp <= BAND_MAX_BP;
    put(
      "income_within_band",
      inBand ? "pass" : "fail",
      `Counted gross ${calculated.toFixed(digits)} / target ${(targetMinor / 10 ** digits).toFixed(digits)} = ${incomeRatio.toFixed(4)} (${targetNote}); allowed 0.7000-1.3000 inclusive.`,
      { ratio: incomeRatio },
    );
  }

  // ---- Aggregates --------------------------------------------------------
  const employerAggregates: EmployerAggregate[] = groups.map((g) => {
    const c = counted.filter((s) => groups[s.groupIndex] === g);
    return {
      employerGroup: g.label,
      matchesStatedEmployer: employersMatch(g.rep, stated.employerName),
      identifiedPayslips: g.slips.length,
      countedPayslips: c.length,
      countedGrossTotal: c.reduce((sum, s) => sum + s.grossValue!, 0),
      countedMonths: c.map((s) => s.payMonth!).sort(),
      isWorkingGroup: g === working,
    };
  });

  // ---- Decision (6.5) ----------------------------------------------------
  const checks = CHECK_ORDER.map((id) => results.get(id)!);
  const failed = checks.filter((c) => c.status === "fail");
  let resultState: ResultState;
  let resultDescription: string;
  if (identified.length === 0) {
    // AC7: zero identified payslips is an Error, not a low-income Manual Review.
    resultState = "Error";
    resultDescription = "No payslips could be identified in the uploaded documents.";
  } else if (failed.length > 0) {
    resultState = "Manual Review";
    resultDescription = `Manual review required: ${failed.map((c) => c.title).join("; ")}.`;
  } else {
    resultState = "Approve";
    resultDescription = "All verification checks passed.";
  }

  return {
    resultState,
    resultDescription,
    checks,
    documents: documents.map((d) => ann(d)),
    employerAggregates,
    expectedMonths: expected,
    expectedWindowIncome,
    calculatedAggregateIncome: calculated,
    incomeRatio,
  };
}
