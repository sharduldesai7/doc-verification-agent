import { describe, expect, it } from "vitest";
import { monthlyEquivalent, normalizeBasis } from "../src/verification/basis";
import { applicantsMatch, employersMatch, normalizeEmployer } from "../src/verification/names";
import { expectedMonths, payMonthOf } from "../src/verification/months";
import { minorUnitDigits, toMinor, validatePayEvidence } from "../src/verification/payEvidence";
import { verify } from "../src/verification/engine";
import { CHECK_ORDER } from "../src/verification/types";
import { evidence, FOUR_MONTHS, goodSlips, input, slip } from "./helpers";

const status = (r: ReturnType<typeof verify>, id: string) => r.checks.find((c) => c.id === id)!.status;

describe("6.1 income basis normalization", () => {
  it.each([
    ["Annual", "annual"], ["per year", "annual"], ["Yearly", "annual"],
    ["Semi-Monthly", "semimonthly"], ["semimonth", "semimonthly"],
    ["Bi-Weekly", "biweekly"], ["fortnightly", "biweekly"], ["every two weeks", "biweekly"],
    ["Weekly", "weekly"], ["Monthly", "monthly"], ["", "monthly"], [null, "monthly"], ["twice a month", "monthly"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeBasis(raw as string | null)).toBe(expected);
  });

  it("checks annual/year before week (order matters)", () => {
    expect(normalizeBasis("weekly annualised")).toBe("annual");
  });

  it("converts to a monthly equivalent using the documented divisors", () => {
    expect(monthlyEquivalent(60000, "annual")).toBe(5000);
    expect(monthlyEquivalent(60000, "biweekly")).toBe(5000);
    expect(monthlyEquivalent(5000, "monthly")).toBe(5000);
  });

  it("target is monthly equivalent x 4", () => {
    const r = verify(input(goodSlips()));
    expect(r.expectedWindowIncome).toBe(20000);
  });
});

describe("6.2 name matching", () => {
  it("strips corporate suffixes and matches", () => {
    expect(employersMatch("Acme Corp.", "ACME Incorporated")).toBe(true);
    expect(normalizeEmployer("The Widget Holdings LLC")).toBe("widget");
  });
  it("reverts to original tokens when stripping empties the list", () => {
    expect(normalizeEmployer("The Company")).toBe("the company");
  });
  it("matches by substring in either direction", () => {
    expect(employersMatch("Acme", "Acme Widgets Ltd")).toBe(true);
    expect(employersMatch("Acme Widgets", "Acme")).toBe(true);
    expect(employersMatch("Acme", "Globex")).toBe(false);
  });
  it("handles diacritics and empties", () => {
    expect(employersMatch("Café Müller GmbH", "cafe muller")).toBe(true);
    expect(employersMatch("", "Acme")).toBe(false);
    expect(employersMatch(null, null)).toBe(false);
  });
  it("applicant: first and last token of the shorter side must appear in the other", () => {
    expect(applicantsMatch("Jane Doe", "Jane Quincy Doe")).toBe(true);
    expect(applicantsMatch("Doe, Jane", "Jane Doe")).toBe(true); // order may differ
    expect(applicantsMatch("Jane Doe", "Jane Smith")).toBe(false);
  });
  it("applicant: discards single-character tokens and requires both sides nonempty", () => {
    // "j" is dropped, leaving ["doe"]; first and last are both "doe", which is in the other side.
    expect(applicantsMatch("J. Doe", "Jane Doe")).toBe(true);
    expect(applicantsMatch("J. Doe", "Jane Smith")).toBe(false);
    expect(applicantsMatch("A B", "Jane Doe")).toBe(false);
    expect(applicantsMatch("", "Jane Doe")).toBe(false);
  });
});

describe("6.3 months and selection", () => {
  it("expected months are the four before submission, UTC, across a year boundary", () => {
    expect(expectedMonths(new Date("2026-09-15T00:00:00Z"))).toEqual(["2026-08", "2026-07", "2026-06", "2026-05"]);
    expect(expectedMonths(new Date("2026-02-01T00:00:00Z"))).toEqual(["2026-01", "2025-12", "2025-11", "2025-10"]);
    // 23:30 UTC on Sep 30 is still September in UTC, regardless of local zone.
    expect(expectedMonths(new Date("2026-09-30T23:30:00Z"))[0]).toBe("2026-08");
    expect(expectedMonths(new Date("2026-10-01T00:00:00Z"))[0]).toBe("2026-09");
  });
  it("derives pay month from ISO dates only", () => {
    expect(payMonthOf("2026-08-31")).toBe("2026-08");
    expect(payMonthOf("31/08/2026")).toBeNull();
    expect(payMonthOf(null)).toBeNull();
  });
  it("FIXED selection: duplicate/extra months cannot displace a required older month", () => {
    const docs = [
      slip("2026-09-10"), // current month, outside window
      slip("2026-08-31"),
      slip("2026-08-15"), // duplicate month
      slip("2026-07-31"),
      slip("2026-06-30"),
      slip("2026-05-31"), // the required oldest month
    ];
    const r = verify(input(docs));
    expect(r.resultState).toBe("Approve");
    const excluded = r.documents.filter((d) => !d.includedInAggregate);
    expect(excluded).toHaveLength(2);
    expect(excluded.flatMap((d) => d.exclusionReasons).join(" ")).toMatch(/outside the expected window/);
    expect(excluded.flatMap((d) => d.exclusionReasons).join(" ")).toMatch(/Duplicate/);
  });
  it("undated payslips are never counted and are warned about", () => {
    const r = verify(input([...goodSlips(), slip(null)]));
    expect(status(r, "month_coverage")).toBe("warn");
    expect(r.resultState).toBe("Approve");
  });
  it("groups by employer and picks the group matching the stated employer", () => {
    const other = FOUR_MONTHS.map((d) => slip(d, { employerName: "Globex" }));
    const r = verify(input([...other.slice(0, 1), ...goodSlips()]));
    expect(r.employerAggregates.find((a) => a.isWorkingGroup)?.employerGroup).toBe("Acme Corp");
    expect(status(r, "single_employer")).toBe("fail"); // Globex slip is inside the window
  });
  it("other-employer slips outside the window only warn", () => {
    const r = verify(input([...goodSlips(), slip("2024-01-31", { employerName: "Globex" })]));
    expect(status(r, "single_employer")).toBe("warn");
    expect(r.resultState).toBe("Approve");
  });
});

describe("6.4 pay evidence", () => {
  const validate = (ev: ReturnType<typeof evidence>, currency = "USD") =>
    validatePayEvidence({ grossPay: ev.gross.amount, netPay: ev.net.amount, currency, payEvidence: ev }, currency);

  it("per-currency minor unit precision", () => {
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("KRW")).toBe(0);
    expect(minorUnitDigits("BHD")).toBe(3);
    expect(minorUnitDigits("KWD")).toBe(3);
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("EUR")).toBe(2);
    expect(minorUnitDigits(null)).toBe(2);
    expect(toMinor(1.005, "USD")).toBe(101);
    expect(toMinor(1234, "JPY")).toBe(1234);
    expect(toMinor(1.2345, "KWD")).toBe(1235);
  });
  it("reconciles gross - deductions = net", () => {
    expect(validate(evidence(5000, 1000, 4000)).status).toBe("consistent");
  });
  it("tolerates exactly one minor unit and no more", () => {
    expect(validate(evidence(5000, 1000, 4000.01)).status).toBe("consistent");
    expect(validate(evidence(5000, 1000, 3999.99)).status).toBe("consistent");
    expect(validate(evidence(5000, 1000, 4000.02)).status).toBe("inconsistent");
  });
  it("tolerance is one minor unit of the currency (JPY: 1 yen; KWD: 0.001)", () => {
    expect(validate(evidence(500000, 100000, 400001), "JPY").status).toBe("consistent");
    expect(validate(evidence(500000, 100000, 400002), "JPY").status).toBe("inconsistent");
    expect(validate(evidence(500, 100, 400.001), "KWD").status).toBe("consistent");
    expect(validate(evidence(500, 100, 400.002), "KWD").status).toBe("inconsistent");
  });
  it.each(["YTD Gross Pay", "Year to Date Gross", "Cumulative Gross", "Taxable Gross Pay", "FICA Gross", "Previous Gross Pay"])(
    "rejects %s as inconsistent, not a soft warning",
    (label) => {
      const ev = evidence(5000, 1000, 4000);
      ev.gross = { amount: 5000, label, periodScope: "Current period" };
      expect(validate(ev).status).toBe("inconsistent");
    },
  );
  it.each(["YTD", "prior period", "last period", "next period", "cumulative"])("rejects scope %s", (scope) => {
    const ev = evidence(5000, 1000, 4000);
    ev.net = { amount: 4000, label: "Net Pay", periodScope: scope };
    expect(validate(ev).status).toBe("inconsistent");
  });
  it("unrecognised label or missing current-period signal is unresolved", () => {
    const a = evidence(5000, 1000, 4000);
    a.gross = { amount: 5000, label: "Wages", periodScope: "current" };
    expect(validate(a).status).toBe("unresolved");
    const b = evidence(5000, 1000, 4000);
    b.net = { amount: 4000, label: "Net Pay", periodScope: null };
    expect(validate(b).status).toBe("unresolved");
    const c = evidence(5000, 1000, 4000);
    c.deductions = { amount: null, label: null, periodScope: null };
    expect(validate(c).status).toBe("unresolved");
  });
  it("top-level gross disagreeing with printed gross is inconsistent", () => {
    const ev = evidence(5000, 1000, 4000);
    const v = validatePayEvidence({ grossPay: 9000, netPay: 4000, currency: "USD", payEvidence: ev }, "USD");
    expect(v.status).toBe("inconsistent");
  });
  it("no evidence at all is unresolved", () => {
    expect(validatePayEvidence({ grossPay: 1, netPay: 1, currency: "USD", payEvidence: null }, "USD").status).toBe("unresolved");
  });
});

describe("6.5 decision precedence", () => {
  it("records every check in the exact fixed order", () => {
    const r = verify(input(goodSlips()));
    expect(r.checks.map((c) => c.id)).toEqual([...CHECK_ORDER]);
    expect(r.checks.map((c) => c.id)).toEqual([
      "documents_readable", "payslips_identified", "pay_evidence_consistency", "employer_match",
      "single_employer", "applicant_match", "applicant_consistent", "payslip_count",
      "month_coverage", "currency_match", "income_within_band",
    ]);
  });

  it("AC1: four consistent same-employer payslips in band -> Approve", () => {
    const r = verify(input(goodSlips()));
    expect(r.resultState).toBe("Approve");
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
    expect(r.incomeRatio).toBe(1);
  });

  it("AC2: ratio exactly 0.70 and 1.30 approve (inclusive)", () => {
    const low = verify(input(goodSlips(3500))); // 14000 / 20000
    expect(low.incomeRatio).toBe(0.7);
    expect(low.resultState).toBe("Approve");
    const high = verify(input(goodSlips(6500))); // 26000 / 20000
    expect(high.incomeRatio).toBe(1.3);
    expect(high.resultState).toBe("Approve");
  });

  it("AC3: ratio outside the band -> Manual Review", () => {
    const low = verify(input(goodSlips(3499))); // 0.6998
    expect(low.incomeRatio).toBe(0.6998);
    expect(status(low, "income_within_band")).toBe("fail");
    expect(low.resultState).toBe("Manual Review");
    const high = verify(input(goodSlips(6501)));
    expect(high.resultState).toBe("Manual Review");
  });

  it("ratio is rounded to four decimals before the band comparison", () => {
    // 13,000.4 / 10,000 -> 1.30004 rounds to 1.3000 -> inside band
    const r = verify(input(goodSlips(3250.1), { incomeAmount: 30000 }));
    expect(r.incomeRatio).toBe(1.3);
    expect(r.resultState).toBe("Approve");
  });

  it("AC4: inconsistent evidence on one selected slip -> Manual Review", () => {
    const docs = goodSlips();
    docs[1]!.payEvidence = evidence(5000, 1000, 3000);
    const r = verify(input(docs));
    expect(status(r, "pay_evidence_consistency")).toBe("fail");
    expect(r.resultState).toBe("Manual Review");
  });

  it("AC4: bad evidence on a slip excluded from the window still blocks approval", () => {
    const stray = slip("2024-01-31");
    stray.payEvidence = evidence(5000, 1000, 1);
    const r = verify(input([...goodSlips(), stray]));
    expect(stray && r.documents.find((d) => d.id === stray.id)!.includedInAggregate).toBe(false);
    expect(status(r, "pay_evidence_consistency")).toBe("fail");
    expect(r.resultState).toBe("Manual Review");
  });

  it("unresolved evidence also blocks approval", () => {
    const docs = goodSlips();
    docs[0]!.payEvidence!.net = { amount: 4000, label: "Net Pay", periodScope: null };
    expect(verify(input(docs)).resultState).toBe("Manual Review");
  });

  it("AC5: applicant differs from every selected payslip -> Manual Review with explicit reason", () => {
    const docs = FOUR_MONTHS.map((d) => slip(d, { applicantName: "John Smith" }));
    const r = verify(input(docs));
    expect(status(r, "applicant_match")).toBe("fail");
    expect(r.checks.find((c) => c.id === "applicant_match")!.reason).toMatch(/John Smith/);
    expect(r.resultState).toBe("Manual Review");
  });

  it("AC5: a name missing on some slips alone does not fail the check", () => {
    const docs = goodSlips();
    docs[0]!.applicantName = null;
    docs[1]!.applicantName = "";
    const r = verify(input(docs));
    expect(status(r, "applicant_match")).toBe("warn");
    expect(r.resultState).toBe("Approve");
  });

  it("applicant_consistent fails when names differ across slips even if one matches", () => {
    const docs = goodSlips();
    docs[0]!.applicantName = "John Smith";
    const r = verify(input(docs));
    expect(status(r, "applicant_match")).toBe("pass");
    expect(status(r, "applicant_consistent")).toBe("fail");
    expect(r.resultState).toBe("Manual Review");
  });

  it("no names anywhere cannot be verified and blocks approval", () => {
    const docs = goodSlips().map((d) => ({ ...d, applicantName: null }));
    expect(status(verify(input(docs)), "applicant_match")).toBe("fail");
  });

  it("AC6: fewer than four valid payslips -> Manual Review, ratio not computed", () => {
    const r = verify(input(goodSlips().slice(0, 3)));
    expect(status(r, "payslip_count")).toBe("fail");
    expect(status(r, "month_coverage")).toBe("fail");
    expect(status(r, "income_within_band")).toBe("skipped");
    expect(r.incomeRatio).toBeNull();
    expect(r.calculatedAggregateIncome).toBeNull();
    expect(r.resultState).toBe("Manual Review");
  });

  it("AC6: four payslips but a month is missing (wrong month) -> Manual Review", () => {
    const docs = [...goodSlips().slice(0, 3), slip("2026-03-31")];
    const r = verify(input(docs));
    expect(status(r, "month_coverage")).toBe("fail");
    expect(r.resultState).toBe("Manual Review");
  });

  it("a slip with unreadable gross is excluded after selection and fails the count", () => {
    const docs = goodSlips();
    docs[2]!.grossPay = null;
    docs[2]!.payEvidence = null;
    const r = verify(input(docs));
    expect(status(r, "payslip_count")).toBe("fail");
    expect(r.resultState).toBe("Manual Review");
  });

  it("employer mismatch and missing stated data block approval rather than default", () => {
    expect(status(verify(input(goodSlips(), { employerName: "Globex" })), "employer_match")).toBe("fail");
    expect(status(verify(input(goodSlips(), { employerName: null })), "employer_match")).toBe("fail");
    const noIncome = verify(input(goodSlips(), { incomeAmount: null, monthlyIncome: null }));
    expect(status(noIncome, "income_within_band")).toBe("fail");
    expect(noIncome.incomeRatio).toBeNull();
    expect(noIncome.resultState).toBe("Manual Review");
  });

  it("falls back to stated monthly income when no amount is given", () => {
    const r = verify(input(goodSlips(), { incomeAmount: null, monthlyIncome: 5000 }));
    expect(r.expectedWindowIncome).toBe(20000);
    expect(r.resultState).toBe("Approve");
  });

  it("currency mismatch fails; missing slip currency only warns", () => {
    const eur = FOUR_MONTHS.map((d) => slip(d, { currency: "EUR" }));
    const r = verify(input(eur));
    expect(status(r, "currency_match")).toBe("fail");
    expect(status(r, "income_within_band")).toBe("skipped");
    expect(r.resultState).toBe("Manual Review");
    const docs = goodSlips();
    docs[0]!.currency = null;
    expect(status(verify(input(docs)), "currency_match")).toBe("warn");
  });

  it("AC7: an unreadable or non-payslip upload alongside good documents only warns", () => {
    const junk = slip(null, { extractionOk: false, extractionError: "blurry", isPayslip: null });
    const letter = slip(null, { isPayslip: false });
    const r = verify(input([...goodSlips(), junk, letter]));
    expect(status(r, "documents_readable")).toBe("warn");
    expect(status(r, "payslips_identified")).toBe("warn");
    expect(r.resultState).toBe("Approve");
  });

  it("AC7: zero identified payslips -> Error", () => {
    const r = verify(input([slip(null, { isPayslip: false }), slip(null, { extractionOk: false })]));
    expect(status(r, "payslips_identified")).toBe("fail");
    expect(r.resultState).toBe("Error");
    expect(r.checks).toHaveLength(CHECK_ORDER.length);
  });

  it("anchors the window on the submission time, not the current time", () => {
    const docs = ["2025-12-31", "2025-11-30", "2025-10-31", "2025-09-30"].map((d) => slip(d));
    const r = verify(input(docs, {}, new Date("2026-01-05T00:00:00Z")));
    expect(r.expectedMonths).toEqual(["2025-12", "2025-11", "2025-10", "2025-09"]);
    expect(r.resultState).toBe("Approve");
  });

  it("aggregates report counted gross per employer", () => {
    const r = verify(input(goodSlips()));
    expect(r.employerAggregates).toEqual([
      expect.objectContaining({ employerGroup: "Acme Corp", countedPayslips: 4, countedGrossTotal: 20000, matchesStatedEmployer: true, isWorkingGroup: true }),
    ]);
  });
});
